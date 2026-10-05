import { Router } from "express";
import { Role } from "@prisma/client";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { allow, auth } from "../middleware/auth.js";
import { buildAnomalies, predictFailures, summarizeInsights } from "../services/analytics.js";

export const analyticsRouter = Router();
analyticsRouter.use(auth, allow(Role.MASTER, Role.MANAGER, Role.ADMIN));
analyticsRouter.post("/anomalies/run", asyncHandler(async (req, res) => {
  const from = req.body.from ? new Date(req.body.from) : undefined;
  const to = req.body.to ? new Date(req.body.to) : undefined;
  const insights = await buildAnomalies(from, to);
  res.json({ insights, ai: await summarizeInsights(insights) });
}));
analyticsRouter.get("/anomalies", asyncHandler(async (_req, res) => res.json(await prisma.anomalyInsight.findMany({ include: { area: true, equipment: true }, orderBy: [{ severity: "desc" }, { createdAt: "desc" }], take: 100 }))));
analyticsRouter.get("/failure-forecast", asyncHandler(async (req, res) => res.json(await predictFailures(Number(req.query.days ?? 30)))));
analyticsRouter.get("/dashboard", asyncHandler(async (_req, res) => {
  const now = new Date();
  const activeStatuses = ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] as const;
  const [active, overdue, downtime, topEquipmentCounts, executorRows, completed] = await Promise.all([
    prisma.workOrder.count({ where: { status: { in: [...activeStatuses] } } }),
    prisma.workOrder.count({ where: { deadline: { lt: now }, status: { in: [...activeStatuses] } } }),
    prisma.equipmentDowntime.aggregate({ where: { endedAt: null }, _count: true }),
    prisma.workOrder.groupBy({ by: ["equipmentId"], where: { type: "EMERGENCY", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: true, orderBy: { _count: { equipmentId: "desc" } }, take: 5 }),
    prisma.user.findMany({ where: { role: "EXECUTOR" }, select: { id: true, fullName: true, assignedOrders: { where: { closedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, select: { aiAssessment: { select: { score: true, masterScore: true } } } } } }),
    prisma.workOrder.findMany({ where: { closedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, select: { createdAt: true, acceptedAt: true, startedAt: true, completedAt: true } })
  ]);
  const equipmentNames = await prisma.equipment.findMany({ where: { id: { in: topEquipmentCounts.map((x) => x.equipmentId) } }, select: { id: true, name: true } });
  const topEquipment = topEquipmentCounts.map((x) => ({ ...x, name: equipmentNames.find((e) => e.id === x.equipmentId)?.name }));
  const topExecutors = executorRows.map((user) => {
    const scores = user.assignedOrders.map((x) => x.aiAssessment?.masterScore ?? x.aiAssessment?.score).filter((x): x is number => Boolean(x));
    return { id: user.id, fullName: user.fullName, score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0, closed: scores.length };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  const averageMinutes = (pairs: Array<[Date | null, Date | null]>) => {
    const values = pairs.flatMap(([from, to]) => from && to ? [(to.getTime() - from.getTime()) / 60_000] : []);
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  };
  res.json({ active, overdue, equipmentInDowntime: downtime._count, averageReactionMinutes: averageMinutes(completed.map((x) => [x.createdAt, x.acceptedAt])), averageCompletionMinutes: averageMinutes(completed.map((x) => [x.startedAt, x.completedAt])), topEquipment, topExecutors });
}));
