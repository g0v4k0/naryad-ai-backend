import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { describeWorkload, openOrdersSelect } from "./employee-status.js";
import { faultText, recall } from "./rag.js";

const ACTIVE_STATUSES = ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] as const;

// Fault-code categories: М механика, Г гидравлика, П пневматика, С смазка — слесарь; Э — электрик.
const CATEGORY_SPECIALTY: Record<string, string> = { "М": "Слесарь", "Г": "Слесарь", "П": "Слесарь", "С": "Слесарь", "Э": "Электрик" };
const SPECIALTY_KEYWORDS: Array<[string, RegExp]> = [
  ["Электрик", /электр|двигател|кабел|пускател|автомат|освещ|датчик|напряжен|питани|замыкан|контактор|щит/i],
  ["Сварщик", /свар|трещин|шов|прожог|наплав|излом металл|порыв металл/i]
];

/** Specialty a job needs: explicit, from the fault code category, or from the problem description (mechanical by default). */
export async function requiredSpecialty(hints: { specialty?: string; faultCodeId?: number; description?: string }) {
  if (hints.specialty) return hints.specialty;
  if (hints.faultCodeId) {
    const code = await prisma.faultCode.findUnique({ where: { id: hints.faultCodeId } });
    if (code && CATEGORY_SPECIALTY[code.category]) return CATEGORY_SPECIALTY[code.category];
  }
  if (hints.description?.trim()) return SPECIALTY_KEYWORDS.find(([, pattern]) => pattern.test(hints.description!))?.[0] ?? "Слесарь";
  return undefined;
}

export type ExecutorHints = { specialty?: string; faultCodeId?: number; description?: string; brigadeId?: number; excludeIds?: number[] };

/**
 * Free executors of the right specialty with the best rating on this equipment type come first.
 * Without any hint about the job, specialty is not considered.
 */
export async function recommendExecutors(equipmentId: number, hints: ExecutorHints = {}) {
  const equipment = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
  const specialty = await requiredSpecialty(hints);
  const executors = await prisma.user.findMany({
    where: { role: Role.EXECUTOR, isOnShift: true, ...(hints.brigadeId ? { brigadeId: hints.brigadeId } : {}), ...(hints.excludeIds?.length ? { id: { notIn: hints.excludeIds } } : {}) },
    include: {
      assignedOrders: { where: { equipment: { type: equipment.type }, status: "CLOSED" }, include: { aiAssessment: true } },
      _count: { select: { assignedOrders: { where: { status: { in: [...ACTIVE_STATUSES] } } } } }
    }
  });
  const openOrders = await prisma.user.findMany({ where: { id: { in: executors.map((x) => x.id) } }, select: { id: true, assignedOrders: openOrdersSelect } });
  return executors.map((user) => {
    const scores = user.assignedOrders.map((x) => x.aiAssessment?.masterScore ?? x.aiAssessment?.score).filter((x): x is number => Boolean(x));
    const rating = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 3;
    const availability = user.employeeStatus === "AVAILABLE" ? 50 : user.employeeStatus === "QUEUED" ? 20 : 0;
    const score = Math.round((availability + rating * 8 - user._count.assignedOrders * 3) * 10) / 10;
    const specialtyMatch = specialty ? user.specialty === specialty : null;
    const { statusText, currentOrder } = describeWorkload(true, openOrders.find((x) => x.id === user.id)?.assignedOrders ?? []);
    // Plain-language "why" for the master, in the order the ranking weighs it.
    const reasons = [
      statusText,
      ...(specialtyMatch === true ? [`нужная специальность: ${specialty}`] : specialtyMatch === false ? [`нужен ${specialty}, а это ${user.specialty ?? "другая специальность"}`] : []),
      scores.length ? `оценка ${rating.toFixed(1)} по ${scores.length} нарядам на «${equipment.type}»` : `нет закрытых нарядов на «${equipment.type}»`
    ];
    return {
      id: user.id, fullName: user.fullName, specialty: user.specialty, grade: user.grade, brigadeId: user.brigadeId, employeeStatus: user.employeeStatus,
      statusText, currentOrder, queue: user._count.assignedOrders, equipmentRating: rating, equipmentOrders: scores.length,
      specialtyMatch, requiredSpecialty: specialty ?? null, score, reasons
    };
  }).sort((a, b) => Number(b.specialtyMatch ?? true) - Number(a.specialtyMatch ?? true) || b.score - a.score);
}

type Code = { id: number; code: string; name: string };
type Norm = { id: number; name: string; hours: unknown; faultCodeId: number | null };

/** The normative to pair with a fault code: the model's pick if it fits the code, else the code's own normative. */
function pairNormative(norms: Norm[], faultCodeId: number | null, picked?: Norm) {
  if (!faultCodeId) return picked;
  if (picked && (picked.faultCodeId === null || picked.faultCodeId === faultCodeId)) return picked;
  return norms.find((x) => x.faultCodeId === faultCodeId) ?? picked;
}

/** The model sometimes cites raw ids ("норматив 113"); the master needs the names of what is actually suggested. */
function readableExplanation(text: string, code?: Code, normative?: Norm) {
  return text
    .replace(/(норматив\S*)\s*(№\s*)?\d+\b/gi, (_, word: string) => normative ? `${word} «${normative.name}»` : word)
    .replace(/(шифр\S*)\s*(№\s*)?\d+\b/gi, (_, word: string) => code ? `${word} ${code.code}` : word)
    .replace(/\b(normativeId|faultCodeId|id)\s*[:=]?\s*\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function suggestion(codes: Code[], faultCodeId: number | null, normative: Norm | undefined, hours: number, explanation: string, basedOn: number) {
  const code = codes.find((x) => x.id === faultCodeId);
  return {
    faultCodeId: code?.id ?? null,
    normativeId: normative?.id ?? null,
    estimatedHours: hours,
    explanation: readableExplanation(explanation, code, normative),
    basedOn,
    faultCode: code ? { id: code.id, code: code.code, name: code.name } : null,
    normative: normative ? { id: normative.id, name: normative.name, hours: Number(normative.hours) } : null
  };
}

/**
 * Fault code and normative for a problem description.
 * fast: no LLM — a similarity-weighted vote of the plant's closed orders (RAG memory), under a second;
 * null fields when there is nothing similar.
 */
export async function suggestFaultAndNormative(description: string, equipmentId: number, options: { fast?: boolean } = {}) {
  const equipment = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
  const [codes, norms, similar] = await Promise.all([
    prisma.faultCode.findMany(),
    prisma.workNormative.findMany({ where: { OR: [{ equipmentId }, { equipmentId: null, equipmentType: equipment.type }] } }),
    recall("FAULT", faultText(equipment.type, description))
  ]);
  // How the plant actually closed similar problems (RAG memory); only codes that still exist.
  const similarOrders = similar.filter((x) => codes.some((c) => c.id === x.faultCodeId)).map((x) => ({
    problem: x.problem, equipmentType: x.equipmentType, faultCodeId: x.faultCodeId, normativeId: x.normativeId, actualHours: x.actualHours, times: x.times, similarity: x.similarity
  }));
  const basedOn = similarOrders.length;
  const byVote = () => {
    const votes = new Map<number, number>();
    for (const x of similarOrders) votes.set(x.faultCodeId!, (votes.get(x.faultCodeId!) ?? 0) + x.similarity * x.times);
    const faultCodeId = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    const normative = norms.find((x) => x.faultCodeId === faultCodeId) ?? norms.find((x) => x.id === similarOrders.find((o) => o.faultCodeId === faultCodeId)?.normativeId);
    return suggestion(codes, faultCodeId, normative, Number(normative?.hours ?? norms[0]?.hours ?? 2), "По похожим закрытым нарядам предприятия", basedOn);
  };
  if (options.fast) return basedOn ? byVote() : suggestion(codes, null, undefined, 0, "Похожих закрытых нарядов нет", 0);
  try {
    const raw = await askOllama<{ faultCodeId?: unknown; normativeId?: unknown; estimatedHours?: unknown; explanation?: unknown }>(
      "Выбери только из переданных идентификаторов. Верни JSON faultCodeId, normativeId, estimatedHours, explanation."
        + " explanation — одно-два предложения для мастера: почему этот шифр и сколько займёт работа; называй шифр и норматив по названию, без идентификаторов."
        + (basedOn ? " similarOrders — как на этом предприятии закрыли похожие наряды: если проблема та же, предпочти их шифр." : ""),
      JSON.stringify({ description, equipment, faultCodes: codes, normatives: norms, ...(basedOn ? { similarOrders } : {}) })
    );
    // Never hand the client an id that is not in the reference lists.
    const faultCodeId = codes.some((x) => x.id === raw.faultCodeId) ? raw.faultCodeId as number : null;
    const normative = pairNormative(norms, faultCodeId, norms.find((x) => x.id === raw.normativeId));
    const hours = Number(raw.estimatedHours);
    return suggestion(codes, faultCodeId, normative,
      Number.isFinite(hours) && hours > 0 ? hours : Number(normative?.hours ?? norms[0]?.hours ?? 2),
      typeof raw.explanation === "string" ? raw.explanation : "Рекомендация по справочнику", basedOn);
  } catch {
    // Without the LLM: similarity-weighted vote of the nearest closed orders.
    if (basedOn) return byVote();
    return suggestion(codes, codes[0]?.id ?? null, norms[0], Number(norms[0]?.hours ?? 2), "Базовая рекомендация по справочнику", basedOn);
  }
}
