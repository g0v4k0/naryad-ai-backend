import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";

export async function buildAnomalies(from = new Date(Date.now() - 90 * 86_400_000), to = new Date()) {
  const orders = await prisma.workOrder.findMany({
    where: { createdAt: { gte: from, lte: to }, status: "CLOSED" },
    include: { equipment: { include: { area: true } }, faultCode: true, materialUsages: true }
  });
  const groups = new Map<number, typeof orders>();
  for (const order of orders) groups.set(order.equipmentId, [...(groups.get(order.equipmentId) ?? []), order]);
  const average = groups.size ? orders.length / groups.size : 0;
  // Emergency orders within 7 days after a planned one, per equipment, to compare each unit with the rest of the fleet.
  const afterPlannedStats = new Map<number, { afterPlanned: number; planned: number }>();
  for (const [equipmentId, list] of groups) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const afterPlanned = sorted.filter((order, index) => order.type === "EMERGENCY" && sorted.slice(0, index).some((previous) => previous.type === "PLANNED" && order.createdAt.getTime() - previous.createdAt.getTime() <= 7 * 86_400_000)).length;
    afterPlannedStats.set(equipmentId, { afterPlanned, planned: list.filter((x) => x.type === "PLANNED").length });
  }
  const fleetTotals = [...afterPlannedStats.values()].reduce((sum, x) => ({ afterPlanned: sum.afterPlanned + x.afterPlanned, planned: sum.planned + x.planned }), { afterPlanned: 0, planned: 0 });
  const insights: Array<{ type: string; title: string; description: string; recommendation: string; severity: number; areaId: number; equipmentId: number; evidence: object }> = [];
  for (const [equipmentId, list] of groups) {
    const equipment = list[0].equipment;
    const downtime = list.reduce((sum, x) => sum + (x.actualDowntimeMinutes ?? 0), 0);
    const faultCounts = new Map<string, number>();
    for (const order of list) if (order.faultCode) faultCounts.set(order.faultCode.code, (faultCounts.get(order.faultCode.code) ?? 0) + 1);
    const topFault = [...faultCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (list.length >= Math.max(3, average * 1.8)) insights.push({
      type: "FREQUENT_FAILURES",
      title: `${equipment.name}: повышенная частота ремонтов`,
      description: `${list.length} закрытых нарядов за период, суммарный простой ${downtime} минут${topFault ? `; частый шифр ${topFault[0]} — ${topFault[1]} раз` : ""}`,
      recommendation: "Провести анализ первопричины и пересмотреть план ППР",
      severity: list.length > average * 3 ? 5 : 4,
      areaId: equipment.areaId,
      equipmentId: equipment.id,
      evidence: { orders: list.length, downtime, topFault }
    });
    // The same fault must dominate the unit's repairs, not just occur three times among many.
    const topShare = topFault ? topFault[1] / list.length : 0;
    if (topFault && topFault[1] >= 3 && topShare >= 0.4) insights.push({
      type: "REPEATED_FAULT",
      title: `${equipment.name}: повторяющийся шифр ${topFault[0]}`,
      description: `Одинаковая неисправность зарегистрирована ${topFault[1]} раз (${Math.round(topShare * 100)}% ремонтов)`,
      recommendation: "Проверить первопричину вместо повторной замены узла",
      severity: 4, areaId: equipment.areaId, equipmentId: equipment.id,
      evidence: { faultCode: topFault[0], count: topFault[1], share: topShare }
    });
    const { afterPlanned, planned } = afterPlannedStats.get(equipmentId)!;
    const rate = planned ? afterPlanned / planned : 0;
    const restPlanned = fleetTotals.planned - planned;
    const restRate = restPlanned ? (fleetTotals.afterPlanned - afterPlanned) / restPlanned : 0;
    if (afterPlanned >= 2 && rate >= Math.max(0.3, 2 * restRate)) insights.push({
      type: "FAILURE_AFTER_PLANNED_MAINTENANCE", title: `${equipment.name}: отказы после ППР`,
      description: `${afterPlanned} аварийных наряда возникли в течение 7 дней после плановых работ`,
      recommendation: "Проверить качество ППР и контрольную карту", severity: 5,
      areaId: equipment.areaId, equipmentId: equipment.id, evidence: { afterPlanned, planned, rate, fleetRate: restRate }
    });
    const materialTotals = new Map<number, number[]>();
    for (const order of list) for (const usage of order.materialUsages) materialTotals.set(usage.materialId, [...(materialTotals.get(usage.materialId) ?? []), Number(usage.quantity)]);
    const spikes = [...materialTotals.entries()].flatMap(([materialId, values]) => {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const max = Math.max(...values);
      return values.length >= 3 && max > avg * 2 ? [{ materialId, average: avg, maximum: max }] : [];
    });
    if (spikes.length) insights.push({
      type: "MATERIAL_ANOMALY", title: `${equipment.name}: аномальный расход материалов`,
      description: `Найдены отклонения по ${spikes.length} материалам`, recommendation: "Проверить списания и нормативы",
      severity: 3, areaId: equipment.areaId, equipmentId: equipment.id, evidence: { spikes }
    });
  }
  await prisma.anomalyInsight.deleteMany({ where: { periodFrom: from, periodTo: to } });
  if (insights.length) await prisma.anomalyInsight.createMany({ data: insights.map((x) => ({ ...x, periodFrom: from, periodTo: to })) });
  return prisma.anomalyInsight.findMany({ where: { periodFrom: from, periodTo: to }, orderBy: { severity: "desc" } });
}

export async function predictFailures(days = 30) {
  const now = new Date();
  const recentFrom = new Date(now.getTime() - days * 86_400_000);
  const previousFrom = new Date(recentFrom.getTime() - days * 86_400_000);
  const equipment = await prisma.equipment.findMany({ include: { orders: { where: { createdAt: { gte: previousFrom }, type: "EMERGENCY" }, select: { createdAt: true } } } });
  return equipment.map((item) => {
    const recent = item.orders.filter((x) => x.createdAt >= recentFrom).length;
    const previous = item.orders.length - recent;
    // Laplace-smoothed and capped: 3 failures after 1 is a weaker signal than 7 after 6 on a critical unit.
    const growth = Math.min(1, (recent + 1) / (previous + 1) - 1);
    const probability = Math.min(0.95, Math.max(0.05, 0.15 + recent * 0.08 + Math.max(0, growth) * 0.25 + item.criticality * 0.04));
    return { equipmentId: item.id, equipment: item.name, recentFailures: recent, previousFailures: previous, growth, probability: Math.round(probability * 100) / 100 };
  }).filter((x) => x.recentFailures > 0).sort((a, b) => b.probability - a.probability);
}

export async function summarizeInsights(insights: unknown) {
  try {
    return await askOllama<{ summary: string; recommendations: string[] }>("Сделай краткий производственный вывод на русском. Верни JSON summary и recommendations[].", JSON.stringify(insights));
  } catch {
    return { summary: "Выявлены проблемные единицы оборудования; требуется проверка мастером.", recommendations: ["Проверить оборудование с максимальной частотой отказов"] };
  }
}
