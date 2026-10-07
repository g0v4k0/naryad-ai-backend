import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { STATUS_LABELS } from "../lib/labels.js";
import { prisma } from "../lib/prisma.js";
import { formatLocal } from "../lib/time.js";
import { findRepeatFailures } from "./analytics.js";
import { phrase } from "./ai-text.js";

const PERIOD_HOURS = { shift: 12, day: 24, week: 24 * 7, month: 24 * 30 } as const;
const OPEN_STATUSES = ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] as const;

const filterSchema = z.object({
  period: z.enum(["shift", "day", "week", "month"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  areaId: z.coerce.number().int().positive().optional(),
  equipmentId: z.coerce.number().int().positive().optional(),
  executorId: z.coerce.number().int().positive().optional(),
  brigadeId: z.coerce.number().int().positive().optional()
});
export type ReportFilter = { from: Date; to: Date; areaId?: number; equipmentId?: number; executorId?: number; brigadeId?: number };

/** Every report: shift / day / week / month or any from–to, filtered by area, equipment, executor, brigade. */
export function parseReportFilter(query: unknown, defaultPeriod: keyof typeof PERIOD_HOURS): ReportFilter {
  const input = filterSchema.parse(query);
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - PERIOD_HOURS[input.period ?? defaultPeriod] * 3_600_000);
  return { from, to, areaId: input.areaId, equipmentId: input.equipmentId, executorId: input.executorId, brigadeId: input.brigadeId };
}

/** Orders created in the period that match the filters; a brigade matches its own orders and its members' orders. */
export function orderWhere(filter: ReportFilter, dateField: "createdAt" | "closedAt" = "createdAt"): Prisma.WorkOrderWhereInput {
  return {
    [dateField]: { gte: filter.from, lte: filter.to },
    ...(filter.areaId ? { areaId: filter.areaId } : {}),
    ...(filter.equipmentId ? { equipmentId: filter.equipmentId } : {}),
    ...(filter.executorId ? { assigneeId: filter.executorId } : {}),
    ...(filter.brigadeId ? { OR: [{ brigadeId: filter.brigadeId }, { assignee: { brigadeId: filter.brigadeId } }] } : {})
  };
}

const downtimeMinutes = (order: { actualDowntimeMinutes: number | null; downtime: { startedAt: Date; endedAt: Date | null } | null }, now: Date) =>
  order.actualDowntimeMinutes ?? (order.downtime ? Math.round(((order.downtime.endedAt ?? now).getTime() - order.downtime.startedAt.getTime()) / 60_000) : 0);

/* ───────────── Shift report ───────────── */

export async function buildShiftReport(filter: ReportFilter) {
  const now = new Date();
  const orders = await prisma.workOrder.findMany({
    where: orderWhere(filter),
    select: { id: true, status: true, deadline: true, assigneeId: true, equipmentId: true, actualDowntimeMinutes: true, downtime: { select: { startedAt: true, endedAt: true } } }
  });
  const count = (statuses: readonly string[]) => orders.filter((x) => statuses.includes(x.status)).length;
  const executors = await prisma.user.findMany({
    where: {
      role: Role.EXECUTOR,
      ...(filter.executorId ? { id: filter.executorId } : {}),
      ...(filter.brigadeId ? { brigadeId: filter.brigadeId } : {})
    },
    select: { id: true, fullName: true, specialty: true, employeeStatus: true, isOnShift: true, assignedOrders: { where: { status: { in: [...OPEN_STATUSES] } }, select: { id: true } } },
    orderBy: { fullName: "asc" }
  });
  const load = executors
    .map((user) => {
      const own = orders.filter((x) => x.assigneeId === user.id);
      return {
        id: user.id, fullName: user.fullName, specialty: user.specialty, employeeStatus: user.employeeStatus, isOnShift: user.isOnShift,
        assigned: own.length,
        completed: own.filter((x) => ["COMPLETED", "AI_REVIEW", "CLOSED"].includes(x.status)).length,
        activeNow: user.assignedOrders.length
      };
    })
    .filter((x) => x.isOnShift || x.assigned);
  const downtimeOrders = orders.filter((x) => x.actualDowntimeMinutes || x.downtime);
  const openDowntime = await prisma.equipmentDowntime.findMany({
    where: { endedAt: null, ...(filter.areaId ? { equipment: { areaId: filter.areaId } } : {}), ...(filter.equipmentId ? { equipmentId: filter.equipmentId } : {}) },
    distinct: ["equipmentId"], select: { equipmentId: true }
  });
  const report = {
    from: filter.from,
    to: filter.to,
    issued: orders.length,
    completed: count(["COMPLETED", "AI_REVIEW", "CLOSED"]),
    closed: count(["CLOSED"]),
    overdue: orders.filter((x) => x.deadline < now && (OPEN_STATUSES as readonly string[]).includes(x.status)).length,
    rejected: count(["REJECTED"]),
    cancelled: count(["CANCELLED"]),
    inProgress: count(["ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK", "ISSUED"]),
    load,
    workload: {
      executorsOnShift: load.filter((x) => x.isOnShift).length,
      busy: load.filter((x) => x.activeNow > 0).length,
      free: load.filter((x) => x.isOnShift && x.activeNow === 0).length
    },
    downtime: {
      equipmentInDowntimeNow: openDowntime.length,
      orders: downtimeOrders.length,
      minutes: downtimeOrders.reduce((sum, x) => sum + downtimeMinutes(x, now), 0)
    }
  };
  const fallback = `За период выдано ${report.issued}, закрыто ${report.closed}, просрочено ${report.overdue}, отклонено ${report.rejected}. `
    + `Простой оборудования ${report.downtime.minutes} мин, сейчас в простое ${report.downtime.equipmentInDowntimeNow}. `
    + `На смене ${report.workload.executorsOnShift} исполнителей, заняты ${report.workload.busy}.`;
  const facts = {
    выдано: report.issued, выполнено: report.completed, закрыто: report.closed, просрочено: report.overdue, отклонено: report.rejected, отменено: report.cancelled, в_работе: report.inProgress,
    исполнителей_на_смене: report.workload.executorsOnShift, заняты: report.workload.busy, свободны: report.workload.free,
    простой_минут: report.downtime.minutes, нарядов_с_простоем: report.downtime.orders, сейчас_в_простое_единиц: report.downtime.equipmentInDowntimeNow,
    самые_загруженные: load.filter((x) => x.assigned).sort((a, b) => b.assigned - a.assigned).slice(0, 3).map((x) => `${x.fullName}: выдано ${x.assigned}, выполнено ${x.completed}`)
  };
  const { text: aiSummary } = await phrase({
    task: "Напиши сводку смены для мастера горно-обогатительного предприятия: 2–3 предложения — выдано, выполнено, просрочено, отклонено, загрузка людей, простои; отметь, на что обратить внимание.",
    facts, lang: "ru", hasData: report.issued > 0 || report.workload.executorsOnShift > 0, fallback, key: "summary"
  });
  return { ...report, aiSummary };
}

/* ───────────── Ratings ───────────── */

const JUSTIFIED_REJECT = /(материал|допуск|аварийн|безопасн|смен|запчаст|инструмент|болен|болезн)/i;
const round1 = (value: number) => Math.round(value * 10) / 10;
const pct = (value: number) => `${Math.round(value * 100)}%`;

type ClosedOrder = { id: number; equipmentId: number; faultCodeId: number | null; deadline: Date; closedAt: Date | null; priority: string; aiAssessment: { score: number; masterScore: number | null; verdict: string } | null; events: Array<{ action: string }> };

/** Weighted components of an executor's rating; the same formula is explained to the executor. */
export function ratingComponents(done: ClosedOrder[], repeated: Set<number>, rejectComments: Array<string | null>) {
  const quality = done.length ? done.reduce((s, x) => s + (x.aiAssessment?.masterScore ?? x.aiAssessment?.score ?? 0), 0) / done.length : 0;
  const onTimeRate = done.length ? done.filter((x) => x.closedAt! <= x.deadline).length / done.length : 0;
  const reworked = done.filter((x) => x.aiAssessment?.verdict === "REWORK_REQUIRED" || x.events.some((e) => e.action === "SEND_TO_REWORK"));
  const reworkRate = done.length ? reworked.length / done.length : 0;
  const repeatFailureRate = done.length ? done.filter((x) => repeated.has(x.id)).length / done.length : 0;
  // A returned order counts once even if it was both reworked and broke again.
  const returnRate = done.length ? done.filter((x) => reworked.includes(x) || repeated.has(x.id)).length / done.length : 0;
  const productivity = Math.min(1, done.length / 20);
  const complexityBonus = Math.min(5, done.filter((x) => x.priority === "EMERGENCY" || x.priority === "HIGH").length);
  const unjustifiedRejects = rejectComments.filter((comment) => !comment || !JUSTIFIED_REJECT.test(comment)).length;
  // "No returns" is earned by closing orders, not by having none.
  const noReturnsShare = done.length ? 1 - returnRate : 0;
  const points = {
    quality: round1(quality / 5 * 45),
    onTime: round1(onTimeRate * 25),
    noReturns: round1(noReturnsShare * 15),
    volume: round1(productivity * 10),
    complexity: complexityBonus,
    rejects: -2 * unjustifiedRejects
  };
  const score = Math.max(0, Math.round((quality / 5 * 45 + onTimeRate * 25 + noReturnsShare * 15 + productivity * 10 + complexityBonus - unjustifiedRejects * 2) * 10) / 10);
  return { score, quality: Math.round(quality * 100) / 100, onTimeRate, reworkRate, repeatFailureRate, returnRate, productivity, unjustifiedRejects, complexityBonus, closed: done.length, points };
}

/** 6.6: a plain-language explanation of where the executor's score came from and what to improve. */
export function explainRating(r: ReturnType<typeof ratingComponents>) {
  if (!r.closed) return `Закрытых нарядов за период нет${r.unjustifiedRejects ? `; необоснованных отказов ${r.unjustifiedRejects} (−${2 * r.unjustifiedRejects})` : ""}. Рейтинг ${r.score}.`;
  const lines = [
    `Качество ${r.quality} из 5 → ${r.points.quality} из 45`,
    `в срок ${pct(r.onTimeRate)} → ${r.points.onTime} из 25`,
    `без доработок и повторных поломок ${pct(1 - r.returnRate)} → ${r.points.noReturns} из 15`,
    `закрыто ${r.closed} → ${r.points.volume} из 10`,
    `сложные наряды +${r.points.complexity}`,
    ...(r.unjustifiedRejects ? [`необоснованные отказы ${r.unjustifiedRejects} → ${r.points.rejects}`] : [])
  ];
  const losses = [
    { lost: 45 - r.points.quality, tip: "повысить качество: подробнее описывать работы, прикладывать фото «после»" },
    { lost: 25 - r.points.onTime, tip: "закрывать наряды в срок или заранее сообщать мастеру о задержке" },
    { lost: 15 - r.points.noReturns, tip: "устранять причину поломки, чтобы оборудование не возвращалось в ремонт" },
    { lost: 10 - r.points.volume, tip: "закрывать больше нарядов" }
  ].sort((a, b) => b.lost - a.lost);
  return `${lines.join("; ")}. Итого ${r.score} из 100. ${losses[0].lost >= 3 ? `Больше всего баллов можно добавить, если ${losses[0].tip}.` : "Все составляющие близки к максимуму."}`;
}

export async function buildRatings(filter: ReportFilter) {
  const users = await prisma.user.findMany({
    where: { role: Role.EXECUTOR, ...(filter.executorId ? { id: filter.executorId } : {}), ...(filter.brigadeId ? { brigadeId: filter.brigadeId } : {}) },
    select: {
      id: true, fullName: true, specialty: true, brigadeId: true,
      events: { where: { action: "REJECT", createdAt: { gte: filter.from, lte: filter.to } }, select: { comment: true } },
      assignedOrders: {
        where: { closedAt: { gte: filter.from, lte: filter.to }, ...(filter.areaId ? { areaId: filter.areaId } : {}), ...(filter.equipmentId ? { equipmentId: filter.equipmentId } : {}) },
        select: { id: true, equipmentId: true, faultCodeId: true, deadline: true, closedAt: true, priority: true, aiAssessment: { select: { score: true, masterScore: true, verdict: true } }, events: { where: { action: "SEND_TO_REWORK" }, select: { action: true } } }
      }
    }
  });
  const repeated = await findRepeatFailures(users.flatMap((u) => u.assignedOrders));
  return users.map((user) => {
    const components = ratingComponents(user.assignedOrders, repeated, user.events.map((e) => e.comment));
    return { id: user.id, fullName: user.fullName, specialty: user.specialty, brigadeId: user.brigadeId, ...components, explanation: explainRating(components), formula: "45×качество/5 + 25×доля в срок + 15×(1 − доля возвратов: доработка или та же поломка снова за 7 дней) + 10×min(1, закрыто/20) + до 5 за сложные − 2 за необоснованный отказ" };
  }).sort((a, b) => b.score - a.score);
}

export async function buildBrigadeRatings(filter: ReportFilter) {
  const brigades = await prisma.brigade.findMany({
    where: filter.brigadeId ? { id: filter.brigadeId } : {},
    include: { members: { include: { assignedOrders: { where: { closedAt: { gte: filter.from, lte: filter.to }, ...(filter.areaId ? { areaId: filter.areaId } : {}) }, include: { aiAssessment: true } } } } }
  });
  const repeated = await findRepeatFailures(brigades.flatMap((b) => b.members.flatMap((m) => m.assignedOrders)));
  return brigades.map((brigade) => {
    const orders = brigade.members.flatMap((member) => member.assignedOrders);
    const quality = orders.length ? orders.reduce((sum, order) => sum + (order.aiAssessment?.masterScore ?? order.aiAssessment?.score ?? 0), 0) / orders.length : 0;
    const onTime = orders.length ? orders.filter((order) => order.closedAt! <= order.deadline).length / orders.length : 0;
    const repeatFailureRate = orders.length ? orders.filter((order) => repeated.has(order.id)).length / orders.length : 0;
    return { id: brigade.id, name: brigade.name, members: brigade.members.length, closed: orders.length, quality: Math.round(quality * 100) / 100, onTimeRate: onTime, repeatFailureRate, score: Math.round((quality / 5 * 70 + onTime * 30) * 10) / 10 };
  }).sort((a, b) => b.score - a.score);
}

/* ───────────── Materials ───────────── */

export type MaterialGroup = "material" | "area" | "equipment" | "executor";

/** Written-off materials with deviation from the normative (7: «отклонения от нормы»). */
export async function buildMaterialsReport(filter: ReportFilter, groupBy: MaterialGroup = "material") {
  const usages = await prisma.materialUsage.findMany({
    where: { workOrder: orderWhere(filter) },
    include: {
      material: true,
      workOrder: { select: { id: true, number: true, area: { select: { id: true, name: true } }, equipment: { select: { id: true, name: true } }, assignee: { select: { id: true, fullName: true } }, normative: { select: { materialNorms: true } } } }
    }
  });
  const groupOf = (usage: typeof usages[number]) =>
    groupBy === "area" ? { id: usage.workOrder.area.id, name: usage.workOrder.area.name }
      : groupBy === "equipment" ? { id: usage.workOrder.equipment.id, name: usage.workOrder.equipment.name }
        : groupBy === "executor" ? { id: usage.workOrder.assignee.id, name: usage.workOrder.assignee.fullName } : null;
  const rows = new Map<string, { group: { id: number; name: string } | null; materialId: number; material: typeof usages[number]["material"]; quantity: number; count: number; normQuantity: number; quantityWithNorm: number; overNormCount: number; overNormOrders: string[] }>();
  for (const usage of usages) {
    const group = groupOf(usage);
    const key = `${group?.id ?? 0}:${usage.materialId}`;
    const row = rows.get(key) ?? { group, materialId: usage.materialId, material: usage.material, quantity: 0, count: 0, normQuantity: 0, quantityWithNorm: 0, overNormCount: 0, overNormOrders: [] };
    const quantity = Number(usage.quantity);
    row.quantity += quantity;
    row.count++;
    const norm = usage.workOrder.normative?.materialNorms.find((x) => x.materialId === usage.materialId);
    if (norm) {
      row.normQuantity += Number(norm.quantity);
      row.quantityWithNorm += quantity;
      // Same threshold as the AI closure check.
      if (quantity > Number(norm.quantity) * 1.5) { row.overNormCount++; row.overNormOrders.push(usage.workOrder.number); }
    }
    rows.set(key, row);
  }
  return [...rows.values()].map(({ quantityWithNorm, ...row }) => ({
    ...row,
    quantity: round1(row.quantity),
    unit: row.material.unit,
    // Only lines that have a normative are compared with it.
    deviationPercent: row.normQuantity ? Math.round((quantityWithNorm / row.normQuantity - 1) * 100) : null,
    // Back-compatible fields of the previous groupBy response.
    _sum: { quantity: String(round1(row.quantity)) },
    _count: row.count
  })).sort((a, b) => (a.group?.name ?? "").localeCompare(b.group?.name ?? "") || b.quantity - a.quantity);
}

/* ───────────── Downtime ───────────── */

/** Downtime per equipment unit with causes by fault code and the planned / unplanned split. */
export async function buildDowntimeReport(filter: ReportFilter) {
  const now = new Date();
  const orders = await prisma.workOrder.findMany({
    where: { AND: [orderWhere(filter), { OR: [{ downtime: { isNot: null } }, { actualDowntimeMinutes: { gt: 0 } }] }] },
    include: { equipment: { include: { area: true } }, faultCode: true, downtime: true }
  });
  const items = orders.map((order) => ({
    workOrderId: order.id, number: order.number, type: order.type, equipmentId: order.equipmentId, equipment: order.equipment.name, area: order.equipment.area.name,
    faultCode: order.faultCode?.code ?? null, faultName: order.faultCode?.name ?? null, reason: order.downtime?.reason ?? order.description,
    startedAt: order.downtime?.startedAt ?? order.startedAt, endedAt: order.downtime?.endedAt ?? order.closedAt, ongoing: Boolean(order.downtime && !order.downtime.endedAt),
    minutes: downtimeMinutes(order, now)
  }));
  const byEquipment = new Map<number, { equipmentId: number; equipment: string; area: string; minutes: number; count: number; plannedMinutes: number; unplannedMinutes: number; ongoing: boolean; byFaultCode: Map<string, { code: string; name: string | null; minutes: number; count: number }> }>();
  for (const item of items) {
    const entry = byEquipment.get(item.equipmentId) ?? { equipmentId: item.equipmentId, equipment: item.equipment, area: item.area, minutes: 0, count: 0, plannedMinutes: 0, unplannedMinutes: 0, ongoing: false, byFaultCode: new Map() };
    entry.minutes += item.minutes;
    entry.count++;
    if (item.type === "PLANNED") entry.plannedMinutes += item.minutes; else entry.unplannedMinutes += item.minutes;
    entry.ongoing ||= item.ongoing;
    const code = item.faultCode ?? "без шифра";
    const fault = entry.byFaultCode.get(code) ?? { code, name: item.faultName, minutes: 0, count: 0 };
    fault.minutes += item.minutes;
    fault.count++;
    entry.byFaultCode.set(code, fault);
    byEquipment.set(item.equipmentId, entry);
  }
  const total = items.reduce((sum, x) => sum + x.minutes, 0);
  const planned = items.filter((x) => x.type === "PLANNED").reduce((sum, x) => sum + x.minutes, 0);
  return {
    from: filter.from,
    to: filter.to,
    totals: { minutes: total, plannedMinutes: planned, unplannedMinutes: total - planned, plannedShare: total ? planned / total : 0, unplannedShare: total ? (total - planned) / total : 0, ongoing: items.filter((x) => x.ongoing).length },
    byEquipment: [...byEquipment.values()].map((x) => ({
      ...x,
      plannedShare: x.minutes ? x.plannedMinutes / x.minutes : 0,
      unplannedShare: x.minutes ? x.unplannedMinutes / x.minutes : 0,
      byFaultCode: [...x.byFaultCode.values()].sort((a, b) => b.minutes - a.minutes)
    })).sort((a, b) => b.minutes - a.minutes),
    items
  };
}

/* ───────────── Export tables ───────────── */

export const EXPORTABLE = ["orders", "shift", "ratings", "brigades", "materials", "downtime", "anomalies"] as const;
export type ExportKind = typeof EXPORTABLE[number];
export type Table = { title: string; columns: Array<{ header: string; key: string; width: number }>; rows: Array<Record<string, unknown>>; summary?: string[] };

const col = (header: string, key: string, width = 16) => ({ header, key, width });
const percentCell = (value: number) => `${Math.round(value * 100)}%`;

/** One table per report so the same data goes to Excel and PDF. */
export async function buildTable(kind: ExportKind, filter: ReportFilter, options: { materialsGroupBy?: MaterialGroup } = {}): Promise<Table> {
  if (kind === "shift") {
    const r = await buildShiftReport(filter);
    return {
      title: "Отчёт за смену",
      columns: [col("Исполнитель", "fullName", 28), col("Специальность", "specialty"), col("Выдано", "assigned", 10), col("Выполнено", "completed", 12), col("В работе сейчас", "activeNow", 16)],
      rows: r.load,
      summary: [`Выдано: ${r.issued}`, `Выполнено: ${r.completed}`, `Закрыто: ${r.closed}`, `Просрочено: ${r.overdue}`, `Отклонено: ${r.rejected}`, `Простой: ${r.downtime.minutes} мин, сейчас в простое ${r.downtime.equipmentInDowntimeNow}`, `Сводка ИИ: ${r.aiSummary}`]
    };
  }
  if (kind === "ratings") {
    const r = await buildRatings(filter);
    return {
      title: "Рейтинг исполнителей",
      columns: [col("Исполнитель", "fullName", 28), col("Балл", "score", 8), col("Качество", "quality", 10), col("В срок", "onTime", 10), col("Возвраты", "returns", 10), col("Закрыто", "closed", 10), col("Отказы", "unjustifiedRejects", 10), col("Пояснение", "explanation", 80)],
      rows: r.map((x) => ({ ...x, onTime: percentCell(x.onTimeRate), returns: percentCell(x.returnRate) }))
    };
  }
  if (kind === "brigades") {
    const r = await buildBrigadeRatings(filter);
    return { title: "Рейтинг бригад", columns: [col("Бригада", "name", 20), col("Балл", "score", 8), col("Качество", "quality", 10), col("В срок", "onTime", 10), col("Закрыто", "closed", 10)], rows: r.map((x) => ({ ...x, onTime: percentCell(x.onTimeRate) })) };
  }
  if (kind === "materials") {
    const r = await buildMaterialsReport(filter, options.materialsGroupBy);
    return {
      title: "Списанные материалы",
      columns: [col("Группа", "group", 24), col("Материал", "material", 28), col("Количество", "quantity", 12), col("Ед.", "unit", 6), col("Списаний", "count", 10), col("Отклонение от нормы", "deviation", 20), col("Сверх нормы", "overNormCount", 12)],
      rows: r.map((x) => ({ ...x, group: x.group?.name ?? "", material: x.material.name, deviation: x.deviationPercent === null ? "нет нормы" : `${x.deviationPercent > 0 ? "+" : ""}${x.deviationPercent}%` }))
    };
  }
  if (kind === "downtime") {
    const r = await buildDowntimeReport(filter);
    return {
      title: "Простои оборудования",
      columns: [col("Оборудование", "equipment", 26), col("Участок", "area", 22), col("Минут", "minutes", 10), col("Случаев", "count", 10), col("Внеплановые", "unplanned", 12), col("Причины (шифры)", "causes", 40)],
      rows: r.byEquipment.map((x) => ({ ...x, unplanned: percentCell(x.unplannedShare), causes: x.byFaultCode.map((f) => `${f.code}: ${f.minutes} мин`).join(", ") })),
      summary: [`Всего ${r.totals.minutes} мин; плановые ${percentCell(r.totals.plannedShare)}, внеплановые ${percentCell(r.totals.unplannedShare)}`]
    };
  }
  if (kind === "anomalies") {
    const insights = await prisma.anomalyInsight.findMany({ where: { ...(filter.areaId ? { OR: [{ areaId: filter.areaId }, { areaId: null }] } : {}) }, orderBy: [{ severity: "desc" }, { createdAt: "desc" }], take: 200 });
    return { title: "Аномалии и зависимости", columns: [col("Важность", "severity", 10), col("Вывод", "title", 40), col("Описание", "description", 60), col("Рекомендация", "recommendation", 60)], rows: insights };
  }
  const orders = await prisma.workOrder.findMany({ where: orderWhere(filter), include: { area: true, equipment: true, assignee: { select: { fullName: true } }, aiAssessment: true }, orderBy: { createdAt: "asc" }, take: 5000 });
  return {
    title: "Наряды",
    columns: [col("Номер", "number", 14), col("Участок", "area", 24), col("Оборудование", "equipment", 26), col("Исполнитель", "assignee", 24), col("Статус", "status", 18), col("Срок", "deadline", 22), col("Оценка", "score", 10)],
    rows: orders.map((x) => ({ number: x.number, area: x.area.name, equipment: x.equipment.name, assignee: x.assignee.fullName, status: STATUS_LABELS[x.status], deadline: formatLocal(x.deadline), score: x.aiAssessment?.masterScore ?? x.aiAssessment?.score }))
  };
}
