import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { buildAnomalies, predictFailures, summarizeInsights } from "../../src/services/analytics.js";
import { bearer, insertOrder, seedBase, type Base } from "../helpers/db.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

let base: Base;
beforeEach(async () => { base = await seedBase(); });
const day = 86_400_000;

async function closed(n: number, data: Record<string, unknown> = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await insertOrder(base, { status: "CLOSED", createdAt: new Date(Date.now() - (i + 1) * day), closedAt: new Date(Date.now() - i * day), ...data }));
  return out;
}

describe("поиск аномалий", () => {
  it("частые ремонты и повторяющийся шифр на одном оборудовании", async () => {
    await closed(8, { equipmentId: base.conveyor.id, faultCodeId: base.fault.id, actualDowntimeMinutes: 60 });
    await closed(1, { equipmentId: base.pump.id });
    await closed(1, { equipmentId: base.crusher.id, areaId: base.area2.id });
    const insights = await buildAnomalies();
    const conveyor = insights.filter((x) => x.equipmentId === base.conveyor.id).map((x) => x.type).sort();
    expect(conveyor).toEqual(["FREQUENT_FAILURES", "REPEATED_FAULT"]);
    const frequent = insights.find((x) => x.type === "FREQUENT_FAILURES")!;
    expect(frequent.evidence).toMatchObject({ orders: 8, downtime: 480, topFault: ["М-01", 8] });
    expect(insights.some((x) => x.equipmentId === base.pump.id)).toBe(false);
  });

  it("аварии в течение 7 дней после ППР", async () => {
    await insertOrder(base, { status: "CLOSED", type: "PLANNED", createdAt: new Date(Date.now() - 10 * day) });
    await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", createdAt: new Date(Date.now() - 8 * day) });
    await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", createdAt: new Date(Date.now() - 6 * day) });
    const insights = await buildAnomalies();
    expect(insights.find((x) => x.type === "FAILURE_AFTER_PLANNED_MAINTENANCE")).toMatchObject({ severity: 5, evidence: { afterPlanned: 2, planned: 1, rate: 2, fleetRate: 0 } });
  });

  it("повторяющийся шифр не поднимается, если он лишь один из многих (< 40% ремонтов)", async () => {
    for (let i = 0; i < 10; i++) await insertOrder(base, { status: "CLOSED", faultCodeId: i < 3 ? base.fault.id : base.fault2.id, createdAt: new Date(Date.now() - (i + 1) * day) });
    for (let i = 0; i < 4; i++) await prisma.faultCode.create({ data: { code: `X-${i}`, name: "x", category: "X" } });
    const codes = await prisma.faultCode.findMany();
    await prisma.workOrder.updateMany({ where: { faultCodeId: base.fault2.id }, data: { faultCodeId: null } });
    const spread = await prisma.workOrder.findMany({ where: { faultCodeId: null } });
    for (const [i, o] of spread.entries()) await prisma.workOrder.update({ where: { id: o.id }, data: { faultCodeId: codes[2 + (i % 4)].id } });
    const insights = await buildAnomalies();
    expect(insights.some((x) => x.type === "REPEATED_FAULT")).toBe(false); // М-01: 3 из 10 = 30%
  });

  it("отказы после ППР не поднимаются, если у остального парка такая же частота", async () => {
    for (const equipmentId of [base.pump.id, base.conveyor.id]) {
      await insertOrder(base, { status: "CLOSED", type: "PLANNED", equipmentId, createdAt: new Date(Date.now() - 10 * day) });
      await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", equipmentId, createdAt: new Date(Date.now() - 8 * day) });
      await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", equipmentId, createdAt: new Date(Date.now() - 6 * day) });
    }
    expect((await buildAnomalies()).some((x) => x.type === "FAILURE_AFTER_PLANNED_MAINTENANCE")).toBe(false);
  });

  it("аномальный расход материала (max > 2× среднего)", async () => {
    const orders = await closed(4);
    for (const [i, q] of [1, 1, 1, 10].entries()) await prisma.materialUsage.create({ data: { workOrderId: orders[i].id, materialId: base.grease.id, quantity: q } });
    const insights = await buildAnomalies();
    expect(insights.find((x) => x.type === "MATERIAL_ANOMALY")!.evidence).toMatchObject({ spikes: [{ materialId: base.grease.id, maximum: 10 }] });
  });

  it("повторный запуск за тот же период не дублирует записи", async () => {
    await closed(8, { equipmentId: base.conveyor.id, faultCodeId: base.fault.id });
    const from = new Date(Date.now() - 90 * day), to = new Date();
    await buildAnomalies(from, to);
    const first = await prisma.anomalyInsight.count();
    await buildAnomalies(from, to);
    expect(first).toBeGreaterThan(0);
    expect(await prisma.anomalyInsight.count()).toBe(first);
  });

  it("POST /anomalies/run возвращает инсайты и AI-сводку", async () => {
    mocks.ollama.handler = () => ollamaReply({ summary: "Конвейер К-3 требует внимания", recommendations: ["RCA"] });
    await closed(8, { equipmentId: base.conveyor.id, faultCodeId: base.fault.id });
    const res = await request(app).post("/api/analytics/anomalies/run").set(bearer(base.master)).send({});
    expect(res.body.ai.summary).toContain("К-3");
    expect(res.body.insights.length).toBeGreaterThan(0);
    expect((await request(app).get("/api/analytics/anomalies").set(bearer(base.manager))).body.length).toBe(res.body.insights.length);
  });

  it("сводка без Ollama — детерминированный текст", async () => {
    mocks.ollama.handler = () => ({ status: 500 });
    expect((await summarizeInsights([])).summary).toContain("проверка мастером");
  });
});

describe("прогноз отказов", () => {
  it("вероятность растёт с числом недавних аварий, ростом и критичностью; ограничена 0.05..0.95", async () => {
    for (let i = 0; i < 3; i++) await insertOrder(base, { type: "EMERGENCY", equipmentId: base.conveyor.id, createdAt: new Date(Date.now() - (i + 1) * day) });
    await insertOrder(base, { type: "EMERGENCY", equipmentId: base.pump.id, createdAt: new Date(Date.now() - 2 * day) });
    await insertOrder(base, { type: "EMERGENCY", equipmentId: base.pump.id, createdAt: new Date(Date.now() - 40 * day) });
    for (let i = 0; i < 15; i++) await insertOrder(base, { type: "EMERGENCY", equipmentId: base.crusher.id, areaId: base.area2.id, createdAt: new Date(Date.now() - (i % 20 + 1) * day) });
    const forecast = await predictFailures(30);
    expect(forecast.map((x) => x.equipment)).toEqual(["Дробилка Д-2", "Конвейер К-3", "Насос Н-1"]);
    const conveyor = forecast.find((x) => x.equipment === "Конвейер К-3")!;
    // 0.15 + 3*0.08 + growth(1)*0.25 + criticality(5)*0.04
    expect(conveyor.probability).toBeCloseTo(0.84, 2);
    expect(forecast[0].probability).toBe(0.95);
    const pump = forecast.find((x) => x.equipment === "Насос Н-1")!;
    expect(pump).toMatchObject({ recentFailures: 1, previousFailures: 1, growth: 0 });
    // рост сглажен: 3 после 0 → (3+1)/(0+1)−1 = 3, ограничен 1
    expect(conveyor.growth).toBe(1);
  });
});

describe("дашборд", () => {
  it("считает активные, просроченные, простой, реакцию и выполнение", async () => {
    const t = Date.now() - 2 * day;
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - 1000) });
    await insertOrder(base, { status: "ISSUED" });
    const em = await insertOrder(base, { type: "EMERGENCY", equipmentId: base.conveyor.id });
    await prisma.equipmentDowntime.create({ data: { equipmentId: base.conveyor.id, workOrderId: em.id, startedAt: new Date() } });
    const c = await insertOrder(base, { status: "CLOSED", createdAt: new Date(t), acceptedAt: new Date(t + 10 * 60_000), startedAt: new Date(t + 20 * 60_000), completedAt: new Date(t + 140 * 60_000), closedAt: new Date(t + 150 * 60_000) });
    await prisma.aiAssessment.create({ data: { workOrderId: c.id, verdict: "ACCEPTED", score: 4, masterScore: 5, explanation: "x" } });
    const res = await request(app).get("/api/analytics/dashboard").set(bearer(base.manager));
    expect(res.body).toMatchObject({ active: 3, overdue: 1, equipmentInDowntime: 1, averageReactionMinutes: 10, averageCompletionMinutes: 120 });
    expect(res.body.topEquipment[0]).toMatchObject({ name: "Конвейер К-3", _count: 1 });
    expect(res.body.topExecutors[0]).toMatchObject({ fullName: "Слесарь 1", score: 5, closed: 1 });
    expect((await request(app).get("/api/analytics/failure-forecast?days=7").set(bearer(base.master))).status).toBe(200);
  });
});
