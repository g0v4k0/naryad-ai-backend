import { createHash } from "node:crypto";
import { AiVerdict, KnowledgeKind, Prisma, WorkOrderStatus, type KnowledgeCase } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";

/**
 * RAG memory around the LLM. Every master decision (CLOSE / SEND_TO_REWORK) is stored as a labelled
 * example; on the next similar case the prompt receives the nearest ones, so the model follows the
 * plant's own practice without retraining. Vectors live in MySQL and are searched in memory: a plant
 * produces thousands of closures a year, where a brute-force dot product takes milliseconds.
 */

/** `times` — how many stored cases repeat this one (same text, same decision): templated reports are common. */
export type Precedent = Omit<KnowledgeCase, "embedding"> & { similarity: number; times: number };
type Entry = { vector: Float32Array; row: Omit<KnowledgeCase, "embedding"> };

export const ragEnabled = () => Boolean(config.OLLAMA_EMBED_MODEL);

export const reviewText = (equipmentType: string, problem: string, report: string) => `Оборудование: ${equipmentType}\nПроблема: ${problem}\nОтчёт: ${report}`;
export const faultText = (equipmentType: string, problem: string) => `Оборудование: ${equipmentType}\nПроблема: ${problem}`;

function normalize(values: number[]) {
  const vector = Float32Array.from(values);
  const norm = Math.hypot(...vector) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  const response = await fetch(`${config.OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.OLLAMA_EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Ollama embed вернула ${response.status}`);
  const body = (await response.json()) as { embeddings?: number[][] };
  if (body.embeddings?.length !== texts.length) throw new Error("Ollama не вернула эмбеддинги");
  return body.embeddings.map(normalize);
}

const toBytes = (vector: Float32Array) => new Uint8Array(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength);
const fromBytes = (bytes: Uint8Array) => new Float32Array(new Uint8Array(bytes).buffer);

// Reloaded only when the table changes (count / last update / last id), so a truncate or a new decision is seen at once.
const cache = new Map<KnowledgeKind, { signature: string; entries: Entry[] }>();

async function entries(kind: KnowledgeKind) {
  const where = { kind, model: config.OLLAMA_EMBED_MODEL };
  const agg = await prisma.knowledgeCase.aggregate({ where, _count: { _all: true }, _max: { id: true, updatedAt: true } });
  const signature = `${agg._count._all}:${agg._max.id}:${agg._max.updatedAt?.getTime()}`;
  const cached = cache.get(kind);
  if (cached?.signature === signature) return cached.entries;
  const rows = await prisma.knowledgeCase.findMany({ where });
  const loaded = rows.map(({ embedding, ...row }) => ({ vector: fromBytes(embedding), row }));
  cache.set(kind, { signature, entries: loaded });
  return loaded;
}

/** Nearest stored cases above RAG_MIN_SIMILARITY; [] when RAG is off, the memory is empty or embeddings fail. */
export async function recall(kind: KnowledgeKind, text: string, options: { exclude?: number; k?: number } = {}): Promise<Precedent[]> {
  if (!ragEnabled()) return [];
  try {
    const memory = (await entries(kind)).filter((x) => x.row.workOrderId !== options.exclude);
    if (!memory.length) return [];
    const [query] = await embed([text]);
    const ranked = memory
      .map(({ vector, row }) => {
        let dot = 0;
        for (let i = 0; i < vector.length; i++) dot += vector[i] * query[i];
        return { ...row, similarity: Math.round(dot * 1000) / 1000, times: 1 };
      })
      .filter((x) => x.similarity >= config.RAG_MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity || b.updatedAt.getTime() - a.updatedAt.getTime());
    // Copies of one templated report would otherwise fill every slot and hide the master's other decisions.
    const distinct = new Map<string, Precedent>();
    for (const x of ranked) {
      const key = `${x.textHash}:${x.accepted}:${x.faultCodeId}`;
      const seen = distinct.get(key);
      if (seen) seen.times++;
      else distinct.set(key, x);
    }
    const all = [...distinct.values()];
    const top = all.slice(0, options.k ?? config.RAG_TOP_K);
    // Accepted history reports are plentiful and outrank a master's return under a new rule, while only a
    // return carries the plant's requirement: keep the best one in the last slot instead of the weakest acceptance.
    const rework = kind === "REVIEW" && top.length && !top.some((x) => !x.accepted) ? all.find((x) => !x.accepted) : undefined;
    if (rework) top[top.length - 1] = rework;
    return top;
  } catch (error) {
    console.error("RAG recall:", error);
    return [];
  }
}

type Lesson = Omit<KnowledgeCase, "id" | "textHash" | "model" | "embedding" | "createdAt" | "updatedAt">;

const hashOf = (lesson: Lesson) => createHash("sha1").update(`${lesson.problem}\u0000${lesson.report ?? ""}`).digest("hex");

async function rememberAll(lessons: Lesson[]) {
  if (!lessons.length) return 0;
  const vectors = await embed(lessons.map((x) => x.kind === KnowledgeKind.REVIEW ? reviewText(x.equipmentType, x.problem, x.report ?? "") : faultText(x.equipmentType, x.problem)));
  for (const [i, lesson] of lessons.entries()) {
    const data = { ...lesson, model: config.OLLAMA_EMBED_MODEL, embedding: toBytes(vectors[i]) };
    const textHash = hashOf(lesson);
    await prisma.knowledgeCase.upsert({
      where: { kind_workOrderId_textHash: { kind: lesson.kind, workOrderId: lesson.workOrderId, textHash } },
      create: { ...data, textHash },
      update: data
    });
  }
  return lessons.length;
}

async function lessonsOf(workOrderId: number): Promise<Lesson[]> {
  const order = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { equipment: true, aiAssessment: true, events: { where: { action: "SEND_TO_REWORK" }, orderBy: { id: "desc" }, take: 1 } }
  });
  const closed = order.status === WorkOrderStatus.CLOSED;
  if (!closed && order.status !== WorkOrderStatus.REWORK) return [];
  const base = { workOrderId, problem: order.description, equipmentType: order.equipment.type, accepted: null, aiVerdict: null, masterScore: null, masterComment: null, faultCodeId: null, normativeId: null, actualHours: null, report: null };
  const lessons: Lesson[] = [];
  if (order.completionText?.trim()) {
    lessons.push({
      ...base,
      kind: KnowledgeKind.REVIEW,
      report: order.completionText,
      accepted: closed,
      // An assessment written by the CLOSE handler itself (no AI review happened) is not an AI opinion.
      aiVerdict: order.aiAssessment && order.aiAssessment.rawResponse !== null ? order.aiAssessment.verdict : null,
      masterScore: closed ? order.aiAssessment?.masterScore ?? null : null,
      masterComment: (closed ? order.aiAssessment?.masterComment : order.events[0]?.comment) ?? null
    });
  }
  if (closed && order.faultCodeId) {
    const hours = order.startedAt && order.completedAt ? (order.completedAt.getTime() - order.startedAt.getTime()) / 3_600_000 : null;
    lessons.push({ ...base, kind: KnowledgeKind.FAULT, faultCodeId: order.faultCodeId, normativeId: order.normativeId, actualHours: hours === null ? null : Math.round(hours * 100) / 100 });
  }
  return lessons;
}

/** Called after the master closes an order or sends it to rework: the decision becomes a precedent. */
export async function learnFromMasterDecision(workOrderId: number) {
  if (!ragEnabled()) return 0;
  return rememberAll(await lessonsOf(workOrderId));
}

/** Rebuilds the memory from history (closed orders and orders currently in rework), e.g. after changing the embedding model. */
export async function reindexKnowledge() {
  if (!ragEnabled()) return { orders: 0, cases: 0 };
  const orders = await prisma.workOrder.findMany({ where: { status: { in: [WorkOrderStatus.CLOSED, WorkOrderStatus.REWORK] } }, select: { id: true }, orderBy: { id: "asc" } });
  let cases = 0;
  for (let i = 0; i < orders.length; i += 32) {
    const batch = (await Promise.all(orders.slice(i, i + 32).map((x) => lessonsOf(x.id)))).flat();
    cases += await rememberAll(batch);
  }
  await prisma.knowledgeCase.deleteMany({ where: { model: { not: config.OLLAMA_EMBED_MODEL } } });
  return { orders: orders.length, cases };
}

const pct = (part: number, total: number) => total ? Math.round(part / total * 1000) / 10 : null;

/**
 * How well the AI agrees with the masters, month by month: the self-learning curve of the live system.
 * Agreement = the AI's "accept / rework" matched the master's final decision on the same report.
 */
export async function knowledgeStats() {
  const [byKind, reviews, recent] = await Promise.all([
    prisma.knowledgeCase.groupBy({ by: ["kind"], _count: { _all: true } }),
    prisma.knowledgeCase.findMany({ where: { kind: KnowledgeKind.REVIEW, aiVerdict: { not: null } }, select: { accepted: true, aiVerdict: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.aiAssessment.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, rawResponse: { not: Prisma.DbNull } }, select: { ragPrecedents: true } })
  ]);
  const agrees = (x: (typeof reviews)[number]) => (x.aiVerdict !== AiVerdict.REWORK_REQUIRED) === x.accepted;
  const months = new Map<string, { total: number; agreed: number }>();
  for (const x of reviews) {
    const key = x.createdAt.toISOString().slice(0, 7);
    const month = months.get(key) ?? { total: 0, agreed: 0 };
    month.total++;
    if (agrees(x)) month.agreed++;
    months.set(key, month);
  }
  const count = (kind: KnowledgeKind) => byKind.find((x) => x.kind === kind)?._count._all ?? 0;
  return {
    enabled: ragEnabled(),
    model: config.OLLAMA_EMBED_MODEL || null,
    cases: { review: count(KnowledgeKind.REVIEW), fault: count(KnowledgeKind.FAULT) },
    masterAgreementPct: pct(reviews.filter(agrees).length, reviews.length),
    masterOverrides: reviews.filter((x) => !agrees(x)).length,
    byMonth: [...months].map(([month, x]) => ({ month, decisions: x.total, agreementPct: pct(x.agreed, x.total) })),
    reviewsLast30Days: recent.length,
    reviewsWithPrecedentsPct: pct(recent.filter((x) => x.ragPrecedents > 0).length, recent.length)
  };
}
