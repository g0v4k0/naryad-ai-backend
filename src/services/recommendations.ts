import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";

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
  return executors.map((user) => {
    const scores = user.assignedOrders.map((x) => x.aiAssessment?.masterScore ?? x.aiAssessment?.score).filter((x): x is number => Boolean(x));
    const rating = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 3;
    const availability = user.employeeStatus === "AVAILABLE" ? 50 : user.employeeStatus === "QUEUED" ? 20 : 0;
    const score = Math.round((availability + rating * 8 - user._count.assignedOrders * 3) * 10) / 10;
    const specialtyMatch = specialty ? user.specialty === specialty : null;
    return { id: user.id, fullName: user.fullName, specialty: user.specialty, brigadeId: user.brigadeId, employeeStatus: user.employeeStatus, queue: user._count.assignedOrders, equipmentRating: rating, specialtyMatch, requiredSpecialty: specialty ?? null, score };
  }).sort((a, b) => Number(b.specialtyMatch ?? true) - Number(a.specialtyMatch ?? true) || b.score - a.score);
}

export async function suggestFaultAndNormative(description: string, equipmentId: number) {
  const equipment = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
  const [codes, norms] = await Promise.all([
    prisma.faultCode.findMany(),
    prisma.workNormative.findMany({ where: { OR: [{ equipmentId }, { equipmentType: equipment.type }] } })
  ]);
  try {
    const raw = await askOllama<{ faultCodeId?: unknown; normativeId?: unknown; estimatedHours?: unknown; explanation?: unknown }>(
      "Выбери только из переданных идентификаторов. Верни JSON faultCodeId, normativeId, estimatedHours, explanation.",
      JSON.stringify({ description, equipment, faultCodes: codes, normatives: norms })
    );
    // Never hand the client an id that is not in the reference lists.
    const faultCodeId = codes.some((x) => x.id === raw.faultCodeId) ? raw.faultCodeId as number : null;
    const normative = norms.find((x) => x.id === raw.normativeId);
    const hours = Number(raw.estimatedHours);
    return {
      faultCodeId,
      normativeId: normative?.id ?? null,
      estimatedHours: Number.isFinite(hours) && hours > 0 ? hours : Number(normative?.hours ?? norms[0]?.hours ?? 2),
      explanation: typeof raw.explanation === "string" ? raw.explanation : "Рекомендация по справочнику"
    };
  } catch {
    return { faultCodeId: codes[0]?.id ?? null, normativeId: norms[0]?.id ?? null, estimatedHours: Number(norms[0]?.hours ?? 2), explanation: "Базовая рекомендация по справочнику" };
  }
}
