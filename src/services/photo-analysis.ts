import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { exifCaptureTime } from "../lib/exif.js";
import { prisma } from "../lib/prisma.js";
import { formatLocal } from "../lib/time.js";

async function loadLocal(fileUrl: string) {
  if (!fileUrl.startsWith("/uploads/")) return null;
  return readFile(resolve("uploads", basename(fileUrl)));
}

export async function fingerprint(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();
  const pixels = await sharp(buffer).resize(16, 16, { fit: "fill" }).grayscale().raw().toBuffer();
  const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  const perceptual = [...pixels].map((value) => value >= mean ? "1" : "0").join("");
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    perceptual,
    takenAt: exifCaptureTime(metadata.exif),
    metadata: { width: metadata.width, height: metadata.height, format: metadata.format, orientation: metadata.orientation }
  };
}

export function similarity(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return 0;
  let equal = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal++;
  return equal / a.length;
}

/** At or above: the same shot (auto-rework). Between SUSPICIOUS and DUPLICATE: master must look (R4: 0.88 has 0% false matches between different photos). */
export const DUPLICATE_SIMILARITY = 0.98;
export const SUSPICIOUS_SIMILARITY = 0.88;
/** Phone and server clocks drift; a photo this much "earlier" is still treated as on time. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** Vision answers below this confidence are hints only: the master decides. */
export const LOW_CONFIDENCE = 0.5;

/** 6.3.1: an "after" photo must be shot after the order was issued (else it is old) and after work started (else suspicious). */
function photoFreshness(takenAt: Date | null, order: { createdAt: Date; startedAt: Date | null }) {
  if (!takenAt) return null;
  if (takenAt.getTime() < order.createdAt.getTime() - CLOCK_SKEW_MS) return "BEFORE_ORDER" as const;
  if (order.startedAt && takenAt.getTime() < order.startedAt.getTime() - CLOCK_SKEW_MS) return "BEFORE_START" as const;
  return "OK" as const;
}

async function findSimilarEarlierPhoto(workOrderId: number, perceptual: string) {
  const order = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId }, select: { equipmentId: true } });
  const candidates = await prisma.photo.findMany({
    where: { workOrderId: { not: workOrderId }, workOrder: { equipmentId: order.equipmentId } },
    select: { workOrderId: true, metadata: true },
    orderBy: { capturedAt: "desc" },
    take: 300
  });
  for (const candidate of candidates) {
    const other = (candidate.metadata as { perceptual?: string } | null)?.perceptual;
    const value = other ? similarity(perceptual, other) : 0;
    if (value >= SUSPICIOUS_SIMILARITY) return { workOrderId: candidate.workOrderId, similarity: value };
  }
  return null;
}

export async function analyzeOrderPhotos(workOrderId: number) {
  const photos = await prisma.photo.findMany({ where: { workOrderId }, orderBy: { capturedAt: "asc" } });
  const analyzed = [];
  for (const photo of photos) {
    const buffer = await loadLocal(photo.fileUrl);
    if (!buffer) continue;
    const fp = await fingerprint(buffer);
    await prisma.photo.update({ where: { id: photo.id }, data: { contentHash: fp.sha256, metadata: { ...fp.metadata, perceptual: fp.perceptual, takenAt: fp.takenAt?.toISOString() ?? null } } });
    analyzed.push({ ...photo, ...fp, buffer });
  }
  const before = analyzed.find((x) => x.type === "BEFORE");
  const after = analyzed.find((x) => x.type === "AFTER");
  if (!after) return { score: 1, confidence: 1, comment: "Отсутствует доступное фото после", duplicate: false, missing: true };
  const oldDuplicate = await prisma.photo.findFirst({ where: { id: { not: after.id }, contentHash: after.sha256, workOrderId: { not: workOrderId } }, select: { id: true, workOrderId: true } });
  if (oldDuplicate) return { score: 1, confidence: 1, comment: `Фото уже использовалось в наряде ${oldDuplicate.workOrderId}`, duplicate: true };
  const order = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId }, select: { createdAt: true, startedAt: true } });
  const freshness = photoFreshness(after.takenAt, order);
  if (freshness === "BEFORE_ORDER") return { score: 1, confidence: 0.9, comment: `Фото после снято ${formatLocal(after.takenAt!)} — раньше выдачи наряда, это старый снимок`, duplicate: false, stale: true, takenAt: after.takenAt };
  if (freshness === "BEFORE_START") return { score: 3, confidence: 0.4, comment: `Фото после снято ${formatLocal(after.takenAt!)} — до начала работ; проверьте, что снимок сделан после ремонта`, duplicate: false, suspicious: true, takenAt: after.takenAt };
  const earlier = await findSimilarEarlierPhoto(workOrderId, after.perceptual);
  if (earlier) return { score: 3, confidence: 0.4, comment: `Фото после похоже на фото из наряда ${earlier.workOrderId} (сходство ${Math.round(earlier.similarity * 100)}%) — проверьте, что снимок новый`, duplicate: false, suspicious: true };
  if (!before) return { score: 3, confidence: 0.45, comment: "Фото после проверено, но сравнить с фото до невозможно", duplicate: false };
  const exactDuplicate = before.sha256 === after.sha256;
  const visualSimilarity = similarity(before.perceptual, after.perceptual);
  if (exactDuplicate || visualSimilarity >= DUPLICATE_SIMILARITY) return { score: 1, confidence: 0.98, comment: "Фото до и после совпадают или почти не отличаются", duplicate: true, visualSimilarity };
  if (visualSimilarity >= SUSPICIOUS_SIMILARITY) return { score: 3, confidence: 0.4, comment: `Фото до и после очень похожи (${Math.round(visualSimilarity * 100)}%) — проверьте, что ремонт виден на снимке`, duplicate: false, suspicious: true, visualSimilarity };

  if (config.OLLAMA_VISION_MODEL) {
    try {
      const response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.OLLAMA_VISION_MODEL,
          stream: false,
          format: "json",
          messages: [{ role: "user", content: "Сравни промышленное оборудование до и после ремонта. Верни JSON score 1..5, confidence 0..1, comment, sameEquipment boolean, problemFixed boolean, safetyIssues string[]. При низкой уверенности прямо укажи необходимость проверки мастером.", images: [before.buffer.toString("base64"), after.buffer.toString("base64")] }]
        }),
        signal: AbortSignal.timeout(120_000)
      });
      if (response.ok) {
        const body = await response.json() as { message?: { content?: string } };
        if (body.message?.content) {
          const raw = JSON.parse(body.message.content) as { score?: unknown; confidence?: unknown; comment?: unknown; sameEquipment?: unknown; problemFixed?: unknown; safetyIssues?: unknown };
          // Normalize model output: these values are stored in Int/Float columns.
          const vision = {
            score: Math.max(1, Math.min(5, Math.round(Number(raw.score)) || 3)),
            confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.5)),
            comment: typeof raw.comment === "string" ? raw.comment : "Оценка vision-модели",
            sameEquipment: typeof raw.sameEquipment === "boolean" ? raw.sameEquipment : undefined,
            problemFixed: typeof raw.problemFixed === "boolean" ? raw.problemFixed : undefined,
            safetyIssues: Array.isArray(raw.safetyIssues) ? raw.safetyIssues.map(String) : []
          };
          if (vision.sameEquipment === false) return { ...vision, score: 1, comment: `${vision.comment}. На фото другое оборудование`, duplicate: false, visualSimilarity };
          if (vision.safetyIssues?.length) return { ...vision, score: Math.min(vision.score, 2), comment: `${vision.comment}. Замечания безопасности: ${vision.safetyIssues.join(", ")}`, duplicate: false, visualSimilarity };
          return { ...vision, duplicate: false, visualSimilarity, lowConfidence: vision.confidence < LOW_CONFIDENCE };
        }
      }
    } catch (error) {
      console.error("Vision model:", error);
    }
  }
  return { score: 4, confidence: 0.55, comment: "Фото отличаются; требуется окончательная проверка мастером", duplicate: false, visualSimilarity, lowConfidence: true };
}
