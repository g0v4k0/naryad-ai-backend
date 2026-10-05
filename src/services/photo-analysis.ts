import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";

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
    metadata: { width: metadata.width, height: metadata.height, format: metadata.format, orientation: metadata.orientation }
  };
}

export function similarity(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return 0;
  let equal = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal++;
  return equal / a.length;
}

export async function analyzeOrderPhotos(workOrderId: number) {
  const photos = await prisma.photo.findMany({ where: { workOrderId }, orderBy: { capturedAt: "asc" } });
  const analyzed = [];
  for (const photo of photos) {
    const buffer = await loadLocal(photo.fileUrl);
    if (!buffer) continue;
    const fp = await fingerprint(buffer);
    await prisma.photo.update({ where: { id: photo.id }, data: { contentHash: fp.sha256, metadata: { ...fp.metadata, perceptual: fp.perceptual } } });
    analyzed.push({ ...photo, ...fp, buffer });
  }
  const before = analyzed.find((x) => x.type === "BEFORE");
  const after = analyzed.find((x) => x.type === "AFTER");
  if (!after) return { score: 1, confidence: 1, comment: "Отсутствует доступное фото после", duplicate: false };
  const oldDuplicate = await prisma.photo.findFirst({ where: { id: { not: after.id }, contentHash: after.sha256, workOrderId: { not: workOrderId } }, select: { id: true, workOrderId: true } });
  if (oldDuplicate) return { score: 1, confidence: 1, comment: `Фото уже использовалось в наряде ${oldDuplicate.workOrderId}`, duplicate: true };
  if (!before) return { score: 3, confidence: 0.45, comment: "Фото после проверено, но сравнить с фото до невозможно", duplicate: false };
  const exactDuplicate = before.sha256 === after.sha256;
  const visualSimilarity = similarity(before.perceptual, after.perceptual);
  if (exactDuplicate || visualSimilarity > 0.98) return { score: 1, confidence: 0.98, comment: "Фото до и после совпадают или почти не отличаются", duplicate: true, visualSimilarity };

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
          const vision = JSON.parse(body.message.content) as { score: number; confidence: number; comment: string; sameEquipment?: boolean; problemFixed?: boolean; safetyIssues?: string[] };
          if (vision.sameEquipment === false) return { ...vision, score: 1, comment: `${vision.comment}. На фото другое оборудование`, duplicate: false, visualSimilarity };
          if (vision.safetyIssues?.length) return { ...vision, score: Math.min(vision.score, 2), comment: `${vision.comment}. Замечания безопасности: ${vision.safetyIssues.join(", ")}`, duplicate: false, visualSimilarity };
          return { ...vision, duplicate: false, visualSimilarity };
        }
      }
    } catch (error) {
      console.error("Vision model:", error);
    }
  }
  return { score: 4, confidence: 0.55, comment: "Фото отличаются; требуется окончательная проверка мастером", duplicate: false, visualSimilarity };
}
