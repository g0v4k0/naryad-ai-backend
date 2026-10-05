import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";

export async function recommendExecutors(equipmentId: number) {
  const equipment = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
  const executors = await prisma.user.findMany({
    where: { role: Role.EXECUTOR, isOnShift: true },
    include: {
      assignedOrders: { where: { equipment: { type: equipment.type }, status: "CLOSED" }, include: { aiAssessment: true } },
      _count: { select: { assignedOrders: { where: { status: { in: ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] } } } } }
    }
  });
  return executors.map((user) => {
    const scores = user.assignedOrders.map((x) => x.aiAssessment?.masterScore ?? x.aiAssessment?.score).filter((x): x is number => Boolean(x));
    const rating = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 3;
    const availability = user.employeeStatus === "AVAILABLE" ? 50 : user.employeeStatus === "QUEUED" ? 20 : 0;
    const score = Math.round((availability + rating * 8 - user._count.assignedOrders * 3) * 10) / 10;
    return { id: user.id, fullName: user.fullName, specialty: user.specialty, employeeStatus: user.employeeStatus, queue: user._count.assignedOrders, equipmentRating: rating, score };
  }).sort((a, b) => b.score - a.score);
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
