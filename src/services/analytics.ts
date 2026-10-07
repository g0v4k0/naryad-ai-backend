import { prisma } from "../lib/prisma.js";
import { localHour, shiftOf } from "../lib/time.js";
import { askOllama } from "./ollama.js";

export const REPEAT_WINDOW_DAYS = 7;

/**
 * Repairs that did not hold: the same fault code on the same equipment came back as an emergency within 7 days.
 * Orders without a fault code (planned maintenance) are not repairs and never count. Returns the ids of such orders.
 */
export async function findRepeatFailures(orders: Array<{ id: number; equipmentId: number; faultCodeId: number | null; closedAt: Date | null; completedAt?: Date | null }>) {
  const finished = orders.filter((order) => order.faultCodeId && (order.closedAt ?? order.completedAt));
  if (!finished.length) return new Set<number>();
  const times = finished.map((order) => (order.closedAt ?? order.completedAt)!.getTime());
  const failures = await prisma.workOrder.findMany({
    where: { type: "EMERGENCY", status: { not: "CANCELLED" }, equipmentId: { in: [...new Set(finished.map((x) => x.equipmentId))] }, createdAt: { gt: new Date(Math.min(...times)), lte: new Date(Math.max(...times) + REPEAT_WINDOW_DAYS * 86_400_000) } },
    select: { id: true, equipmentId: true, faultCodeId: true, createdAt: true }
  });
  const repeated = new Set<number>();
  finished.forEach((order, index) => {
    const end = times[index] + REPEAT_WINDOW_DAYS * 86_400_000;
    if (failures.some((f) => f.id !== order.id && f.equipmentId === order.equipmentId && f.faultCodeId === order.faultCodeId && f.createdAt.getTime() > times[index] && f.createdAt.getTime() <= end)) repeated.add(order.id);
  });
  return repeated;
}

type Insight = { type: string; title: string; description: string; recommendation: string; severity: number; areaId: number | null; equipmentId: number | null; evidence: object };

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** P(X ≥ k) for X ~ Binomial(n, p): how likely this many repeats are by chance at the others' rate. */
export function binomialTail(n: number, k: number, p: number) {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let term = Math.pow(1 - p, n); // P(X = 0)
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += term;
    term = term * (n - i) / (i + 1) * p / (1 - p);
  }
  return Math.max(0, 1 - below);
}
/** Repeat-failure findings must be unlikely by chance: small samples are noise. */
const SIGNIFICANCE = 0.01;

/** Breakdowns tied to the shift, time of day, executor or brigade (6.5). */
async function correlationInsights(orders: Array<{ id: number; type: string; createdAt: Date; equipmentId: number; faultCodeId: number | null; closedAt: Date | null; assigneeId: number; brigadeId: number | null }>, areaId: number | null) {
  const insights: Insight[] = [];
  const emergencies = orders.filter((order) => order.type === "EMERGENCY");
  if (emergencies.length >= 10) {
    const night = emergencies.filter((order) => shiftOf(order.createdAt) === "NIGHT").length;
    const shares = { DAY: (emergencies.length - night) / emergencies.length, NIGHT: night / emergencies.length };
    // Both shifts are 12 h: an even split is expected.
    const worst = shares.NIGHT >= shares.DAY ? "NIGHT" : "DAY";
    if (shares[worst] >= 0.7) insights.push({
      type: "SHIFT_PATTERN",
      title: `Аварии чаще в ${worst === "NIGHT" ? "ночную" : "дневную"} смену`,
      description: `${percent(shares[worst])} аварийных нарядов (${Math.round(shares[worst] * emergencies.length)} из ${emergencies.length}) приходится на ${worst === "NIGHT" ? "ночную" : "дневную"} смену при ожидаемых 50%`,
      recommendation: worst === "NIGHT" ? "Проверить укомплектованность ночной смены и обходы оборудования ночью" : "Проверить нагрузку на оборудование в дневном режиме и качество приёмки смены",
      severity: 3, areaId, equipmentId: null, evidence: { total: emergencies.length, night, day: emergencies.length - night, shares }
    });
    const buckets = [0, 0, 0, 0];
    for (const order of emergencies) buckets[Math.floor(localHour(order.createdAt) / 6)]++;
    const peak = buckets.indexOf(Math.max(...buckets));
    const share = buckets[peak] / emergencies.length;
    if (share >= 0.45) insights.push({
      type: "TIME_OF_DAY",
      title: `Пик аварий с ${String(peak * 6).padStart(2, "0")}:00 до ${String(peak * 6 + 6).padStart(2, "0")}:00`,
      description: `${percent(share)} аварийных нарядов возникает в этот интервал при ожидаемых 25%`,
      recommendation: "Сопоставить пик с пусками, пересменкой и режимом нагрузки; усилить контроль в это время",
      severity: 3, areaId, equipmentId: null, evidence: { total: emergencies.length, byQuarterOfDay: buckets }
    });
  }

  const closed = orders.filter((order) => order.closedAt);
  const repeated = await findRepeatFailures(closed);
  const totalRepeats = repeated.size;
  const groupStats = <K extends number>(key: (order: typeof closed[number]) => K | null) => {
    const stats = new Map<K, { closed: number; repeats: number }>();
    for (const order of closed) {
      const k = key(order);
      if (k === null) continue;
      const entry = stats.get(k) ?? { closed: 0, repeats: 0 };
      entry.closed++;
      if (repeated.has(order.id)) entry.repeats++;
      stats.set(k, entry);
    }
    return stats;
  };
  const restRate = (stat: { closed: number; repeats: number }) => {
    const restClosed = closed.length - stat.closed;
    return restClosed ? (totalRepeats - stat.repeats) / restClosed : 0;
  };

  const byExecutor = groupStats((order) => order.assigneeId);
  const executors = await prisma.user.findMany({ where: { id: { in: [...byExecutor.keys()] } }, select: { id: true, fullName: true } });
  for (const [executorId, stat] of byExecutor) {
    const rate = stat.repeats / stat.closed, rest = restRate(stat);
    if (stat.repeats >= 3 && rate >= Math.max(0.25, 2 * rest) && binomialTail(stat.closed, stat.repeats, rest) < SIGNIFICANCE) insights.push({
      type: "EXECUTOR_REPEAT_FAILURES",
      title: `${executors.find((x) => x.id === executorId)?.fullName ?? `Исполнитель ${executorId}`}: повторные отказы после ремонта`,
      description: `После ${stat.repeats} из ${stat.closed} его ремонтов (${percent(rate)}) та же неисправность возвращалась в течение ${REPEAT_WINDOW_DAYS} дней; у остальных — ${percent(rest)}`,
      recommendation: "Разобрать с исполнителем последние ремонты, проверить технологию и при необходимости направить на обучение или работу в паре с опытным",
      severity: 4, areaId, equipmentId: null, evidence: { executorId, closed: stat.closed, repeats: stat.repeats, rate, restRate: rest }
    });
  }

  const memberBrigade = new Map((await prisma.user.findMany({ where: { brigadeId: { not: null } }, select: { id: true, brigadeId: true } })).map((x) => [x.id, x.brigadeId!]));
  const byBrigade = groupStats((order) => order.brigadeId ?? memberBrigade.get(order.assigneeId) ?? null);
  const brigades = await prisma.brigade.findMany({ where: { id: { in: [...byBrigade.keys()] } }, select: { id: true, name: true } });
  if (byBrigade.size >= 2) for (const [brigadeId, stat] of byBrigade) {
    const rate = stat.repeats / stat.closed, rest = restRate(stat);
    if (stat.repeats >= 3 && rate >= Math.max(0.2, 1.5 * rest) && binomialTail(stat.closed, stat.repeats, rest) < SIGNIFICANCE) insights.push({
      type: "BRIGADE_REPEAT_FAILURES",
      title: `${brigades.find((x) => x.id === brigadeId)?.name ?? `Бригада ${brigadeId}`}: повторные отказы выше, чем у других`,
      description: `${percent(rate)} ремонтов бригады заканчиваются повторной поломкой в течение ${REPEAT_WINDOW_DAYS} дней; у остальных бригад — ${percent(rest)}`,
      recommendation: "Проверить состав бригады, инструмент и соблюдение технологии ремонта",
      severity: 3, areaId, equipmentId: null, evidence: { brigadeId, closed: stat.closed, repeats: stat.repeats, rate, restRate: rest }
    });
  }
  return insights;
}

/** Per area: emergencies and downtime per equipment unit, so a big area is not "problematic" just for its size. */
export function areaStats(orders: Array<{ type: string; equipmentId: number; actualDowntimeMinutes: number | null; equipment: { area: { id: number; name: string } } }>) {
  const byArea = new Map<number, { areaId: number; name: string; units: Set<number>; emergencies: number; downtime: number; orders: number }>();
  for (const order of orders) {
    const area = order.equipment.area;
    const entry = byArea.get(area.id) ?? { areaId: area.id, name: area.name, units: new Set<number>(), emergencies: 0, downtime: 0, orders: 0 };
    entry.orders++;
    entry.units.add(order.equipmentId);
    if (order.type === "EMERGENCY") entry.emergencies++;
    entry.downtime += order.actualDowntimeMinutes ?? 0;
    byArea.set(area.id, entry);
  }
  return [...byArea.values()].map(({ units, ...x }) => ({ ...x, units: units.size, emergenciesPerUnit: x.emergencies / units.size, downtimePerUnit: x.downtime / units.size }))
    .sort((a, b) => b.emergenciesPerUnit - a.emergenciesPerUnit || b.downtimePerUnit - a.downtimePerUnit);
}

/** Areas whose equipment breaks or stands idle much more than equipment of the other areas. */
function areaInsights(orders: Parameters<typeof areaStats>[0]) {
  const stats = areaStats(orders);
  if (stats.length < 2) return [];
  const insights: Insight[] = [];
  for (const stat of stats) {
    const others = stats.filter((x) => x.areaId !== stat.areaId);
    const avgEmergencies = others.reduce((sum, x) => sum + x.emergenciesPerUnit, 0) / others.length;
    const avgDowntime = others.reduce((sum, x) => sum + x.downtimePerUnit, 0) / others.length;
    if (stat.emergencies >= 5 && (stat.emergenciesPerUnit >= 1.5 * avgEmergencies || stat.downtimePerUnit >= 1.5 * avgDowntime)) insights.push({
      type: "AREA_HOTSPOT",
      title: `Участок «${stat.name}»: больше всего аварий и простоев`,
      description: `${stat.emergenciesPerUnit.toFixed(1)} аварийных наряда и ${Math.round(stat.downtimePerUnit / 60)} ч простоя на единицу оборудования за период; на других участках в среднем ${avgEmergencies.toFixed(1)} и ${Math.round(avgDowntime / 60)} ч`,
      recommendation: "Включить оборудование участка в приоритетный план ППР и проверить условия эксплуатации",
      severity: 4, areaId: stat.areaId, equipmentId: null, evidence: { ...stat, avgEmergenciesPerUnitOtherAreas: avgEmergencies, avgDowntimePerUnitOtherAreas: avgDowntime }
    });
  }
  return insights;
}

/**
 * Finds patterns in closed orders of the period and stores them. Results for the whole plant are stored;
 * `areaId` only narrows what is returned (e.g. «проблемы участка дробления за месяц»).
 */
export async function buildAnomalies(from = new Date(Date.now() - 90 * 86_400_000), to = new Date(), options: { areaId?: number } = {}) {
  const orders = await prisma.workOrder.findMany({
    where: { createdAt: { gte: from, lte: to }, status: "CLOSED" },
    include: { equipment: { include: { area: true } }, faultCode: true, materialUsages: true, normative: { include: { materialNorms: true } } }
  });
  const periodDays = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);
  const groups = new Map<number, typeof orders>();
  for (const order of orders) groups.set(order.equipmentId, [...(groups.get(order.equipmentId) ?? []), order]);
  const average = groups.size ? orders.length / groups.size : 0;
  // Emergency orders within 7 days after a planned one, per equipment, to compare each unit with the rest of the fleet.
  const afterPlannedStats = new Map<number, { afterPlanned: number; planned: number; emergencies: number }>();
  for (const [equipmentId, list] of groups) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const afterPlanned = sorted.filter((order, index) => order.type === "EMERGENCY" && sorted.slice(0, index).some((previous) => previous.type === "PLANNED" && order.createdAt.getTime() - previous.createdAt.getTime() <= 7 * 86_400_000)).length;
    afterPlannedStats.set(equipmentId, { afterPlanned, planned: list.filter((x) => x.type === "PLANNED").length, emergencies: list.filter((x) => x.type === "EMERGENCY").length });
  }
  const fleetTotals = [...afterPlannedStats.values()].reduce((sum, x) => ({ afterPlanned: sum.afterPlanned + x.afterPlanned, planned: sum.planned + x.planned }), { afterPlanned: 0, planned: 0 });
  const insights: Insight[] = [];
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
    const { afterPlanned, planned, emergencies } = afterPlannedStats.get(equipmentId)!;
    const rate = planned ? afterPlanned / planned : 0;
    const restPlanned = fleetTotals.planned - planned;
    const restRate = restPlanned ? (fleetTotals.afterPlanned - afterPlanned) / restPlanned : 0;
    // A unit that breaks all the time also breaks after ППР: compare with its own failures spread evenly over the period.
    const windowShare = Math.min(1, planned * 7 / periodDays);
    const expectedByChance = emergencies * windowShare;
    if (afterPlanned >= 2 && rate >= Math.max(0.3, 2 * restRate) && afterPlanned >= 2 * expectedByChance) insights.push({
      type: "FAILURE_AFTER_PLANNED_MAINTENANCE", title: `${equipment.name}: отказы после ППР`,
      description: `${afterPlanned} аварийных наряда возникли в течение 7 дней после плановых работ`,
      recommendation: "Проверить качество ППР и контрольную карту", severity: 5,
      areaId: equipment.areaId, equipmentId: equipment.id, evidence: { afterPlanned, planned, rate, fleetRate: restRate, expectedByChance: Math.round(expectedByChance * 10) / 10 }
    });
    // With a normative a write-off is compared with its norm (different repairs use different amounts);
    // without one, with the unit's own average for that material.
    const materialValues = new Map<number, Array<{ quantity: number; norm: number | null }>>();
    for (const order of list) for (const usage of order.materialUsages) {
      const norm = order.normative?.materialNorms.find((x) => x.materialId === usage.materialId);
      materialValues.set(usage.materialId, [...(materialValues.get(usage.materialId) ?? []), { quantity: Number(usage.quantity), norm: norm ? Number(norm.quantity) : null }]);
    }
    const spikes = [...materialValues.entries()].flatMap(([materialId, entries]) => {
      const values = entries.map((x) => x.quantity);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const withoutNorm = entries.filter((x) => x.norm === null).map((x) => x.quantity);
      const freeAvg = withoutNorm.length ? withoutNorm.reduce((a, b) => a + b, 0) / withoutNorm.length : 0;
      const overNorm = entries.filter((x) => x.norm !== null && x.quantity > x.norm * 2);
      const overAverage = withoutNorm.length >= 3 ? withoutNorm.filter((q) => q > freeAvg * 2) : [];
      if (!overNorm.length && !overAverage.length) return [];
      const norms = entries.flatMap((x) => x.norm === null ? [] : [x.norm]);
      return [{ materialId, average: Math.round(avg * 100) / 100, maximum: Math.max(...values), spikes: overNorm.length + overAverage.length, norm: norms.length ? Math.max(...norms) : null }];
    });
    if (spikes.length) insights.push({
      type: "MATERIAL_ANOMALY", title: `${equipment.name}: аномальный расход материалов`,
      description: `Найдены отклонения по ${spikes.length} материалам: ${spikes.map((x) => `списано до ${x.maximum}${x.norm ? ` при норме ${x.norm}` : ` при среднем ${x.average}`}`).join("; ")}`, recommendation: "Проверить списания и нормативы",
      severity: 3, areaId: equipment.areaId, equipmentId: equipment.id, evidence: { spikes }
    });
  }
  insights.push(...areaInsights(orders));
  insights.push(...await correlationInsights(orders, null));
  await prisma.anomalyInsight.deleteMany({ where: { periodFrom: from, periodTo: to } });
  if (insights.length) await prisma.anomalyInsight.createMany({ data: insights.map((x) => ({ ...x, periodFrom: from, periodTo: to })) });
  return prisma.anomalyInsight.findMany({
    where: { periodFrom: from, periodTo: to, ...(options.areaId ? { OR: [{ areaId: options.areaId }, { areaId: null }] } : {}) },
    orderBy: { severity: "desc" }
  });
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
    const raw = await askOllama<{ summary?: unknown; recommendations?: unknown }>("Сделай краткий производственный вывод на русском. Верни JSON: summary — строка, recommendations — массив строк.", JSON.stringify(insights));
    if (typeof raw.summary !== "string" || !raw.summary.trim()) throw new Error("Пустая сводка");
    return { summary: raw.summary, recommendations: Array.isArray(raw.recommendations) ? raw.recommendations.map(String) : [] };
  } catch {
    return { summary: "Выявлены проблемные единицы оборудования; требуется проверка мастером.", recommendations: ["Проверить оборудование с максимальной частотой отказов"] };
  }
}
