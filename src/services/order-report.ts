import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const round1 = (value: number) => Math.round(value * 10) / 10;

type TimingInput = { deadline: Date; startedAt: Date | null; completedAt: Date | null; closedAt: Date | null; normative?: { hours: Prisma.Decimal } | null };

/** Actual time against the normative and the deadline (6.4: «время выполнения против норматива»). */
export function orderTiming(order: TimingInput, now = new Date()) {
  const normativeHours = order.normative ? Number(order.normative.hours) : null;
  const actualHours = order.startedAt && order.completedAt ? round1((order.completedAt.getTime() - order.startedAt.getTime()) / 3_600_000) : null;
  const finishedAt = order.completedAt ?? order.closedAt;
  const overdueMinutes = Math.max(0, Math.round(((finishedAt ?? now).getTime() - order.deadline.getTime()) / 60_000));
  return {
    normativeHours,
    actualHours,
    vsNormativePercent: normativeHours && actualHours !== null ? Math.round(actualHours / normativeHours * 100) : null,
    deadlineMet: finishedAt ? finishedAt <= order.deadline : null,
    overdueMinutes
  };
}

const fullInclude = {
  area: true,
  equipment: true,
  brigade: true,
  creator: { select: { id: true, fullName: true } },
  assignee: { select: { id: true, fullName: true, specialty: true } },
  faultCode: true,
  normative: true,
  photos: { orderBy: { capturedAt: "asc" } },
  materialUsages: { include: { material: true } },
  aiAssessment: { include: { reviewedBy: { select: { id: true, fullName: true } } } },
  downtime: true,
  events: { include: { actor: { select: { id: true, fullName: true } } }, orderBy: { createdAt: "asc" } }
} as const satisfies Prisma.WorkOrderInclude;

/** Master's report: full card, status chronology, works, materials, photos, AI verdict, downtime. */
export async function masterOrderReport(id: number) {
  const order = await prisma.workOrder.findUnique({ where: { id }, include: fullInclude });
  if (!order) return null;
  const downtimeMinutes = order.actualDowntimeMinutes ?? (order.downtime ? Math.round(((order.downtime.endedAt ?? new Date()).getTime() - order.downtime.startedAt.getTime()) / 60_000) : null);
  return {
    ...order,
    timing: orderTiming(order),
    downtimeMinutes,
    chronology: order.events.map((event) => ({ at: event.createdAt, action: event.action, from: event.fromStatus, to: event.toStatus, actor: event.actor.fullName, comment: event.comment })),
    photosBefore: order.photos.filter((photo) => photo.type === "BEFORE"),
    photosAfter: order.photos.filter((photo) => photo.type === "AFTER"),
    // Final score: the master's when set, otherwise the AI's.
    finalScore: order.aiAssessment ? order.aiAssessment.masterScore ?? order.aiAssessment.score : null
  };
}

/** Executor's report: score, what was good, what to improve, time against the normative. */
export async function executorOrderReport(id: number) {
  const order = await prisma.workOrder.findUnique({ where: { id }, include: { equipment: true, normative: true, aiAssessment: true } });
  if (!order) return null;
  const assessment = order.aiAssessment;
  return {
    id: order.id,
    number: order.number,
    equipment: order.equipment.name,
    status: order.status,
    assigneeId: order.assigneeId,
    verdict: assessment?.verdict ?? null,
    aiScore: assessment?.score ?? null,
    masterScore: assessment?.masterScore ?? null,
    finalScore: assessment ? assessment.masterScore ?? assessment.score : null,
    explanation: assessment?.explanation ?? null,
    strengths: (assessment?.strengths as string[] | null) ?? [],
    improvements: (assessment?.improvements as string[] | null) ?? [],
    masterComment: assessment?.masterComment ?? null,
    photoComment: assessment?.photoComment ?? null,
    timing: orderTiming(order)
  };
}
