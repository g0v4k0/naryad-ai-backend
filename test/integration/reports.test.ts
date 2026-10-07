import ExcelJS from "exceljs";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { bearer, insertOrder, seedBase, type Base } from "../helpers/db.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

let base: Base;
beforeEach(async () => { base = await seedBase(); });
const hour = 3_600_000;
const binary = (res: any, cb: any) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); };

describe("отчёты", () => {
  it("сменный отчёт + AI-сводка, fallback без Ollama", async () => {
    await insertOrder(base, { status: "CLOSED" });
    await insertOrder(base, { status: "AI_REVIEW" });
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - 1000) });
    mocks.ollama.handler = () => ollamaReply({ summary: "Смена прошла штатно" });
    const res = await request(app).get("/api/reports/shift").set(bearer(base.master));
    expect(res.body).toMatchObject({ issued: 3, completed: 2, closed: 1, overdue: 1, rejected: 0, aiSummary: "Смена прошла штатно" });
    const fallback = "За период выдано 3, закрыто 1, просрочено 1, отклонено 0. Простой оборудования 0 мин, сейчас в простое 0. На смене 2 исполнителей, заняты 1.";
    mocks.ollama.handler = () => ({ status: 500 });
    expect((await request(app).get("/api/reports/shift").set(bearer(base.master))).body.aiSummary).toBe(fallback);
    mocks.ollama.handler = () => ollamaReply({ summary: { text: "не строка" } });
    expect((await request(app).get("/api/reports/shift").set(bearer(base.master))).body.aiSummary).toBe(fallback);
  });

  it("фильтры отчётов по участку и исполнителю", async () => {
    await insertOrder(base, { status: "CLOSED" });
    await insertOrder(base, { status: "CLOSED", areaId: base.area2.id, equipmentId: base.crusher.id, assigneeId: base.worker2.id });
    mocks.ollama.handler = () => ({ status: 500 });
    expect((await request(app).get(`/api/reports/shift?areaId=${base.area2.id}`).set(bearer(base.master))).body.issued).toBe(1);
    expect((await request(app).get(`/api/reports/shift?executorId=${base.worker1.id}`).set(bearer(base.master))).body.issued).toBe(1);
    expect((await request(app).get(`/api/reports/shift?brigadeId=${base.brigade.id}`).set(bearer(base.master))).body.issued).toBe(2);
  });

  it("рейтинг исполнителей: формула 45/25/15/10/+5/−2", async () => {
    // worker1: 2 закрытых, оба вовремя, оценки 5 и 4, один аварийный; один отказ без уважительной причины
    for (const [score, priority] of [[5, "EMERGENCY"], [4, "NORMAL"]] as const) {
      const o = await insertOrder(base, { status: "CLOSED", priority, deadline: new Date(Date.now() + hour), closedAt: new Date() });
      await prisma.aiAssessment.create({ data: { workOrderId: o.id, verdict: "ACCEPTED", score, explanation: "x" } });
    }
    const rejected = await insertOrder(base, { status: "REJECTED" });
    await prisma.workOrderEvent.create({ data: { workOrderId: rejected.id, actorId: base.worker1.id, action: "REJECT", comment: "Не хочу" } });
    await prisma.workOrderEvent.create({ data: { workOrderId: rejected.id, actorId: base.worker1.id, action: "REJECT", comment: "Нет материала" } });
    const res = await request(app).get("/api/reports/ratings").set(bearer(base.manager));
    const w1 = res.body.find((x: any) => x.id === base.worker1.id);
    // 4.5/5*45 + 1*25 + 1*15 + (2/20)*10 + 1 − 2 = 40.5+25+15+1+1−2 = 80.5
    expect(w1).toMatchObject({ score: 80.5, quality: 4.5, onTimeRate: 1, reworkRate: 0, unjustifiedRejects: 1, complexityBonus: 1, closed: 2 });
    expect(res.body[0].id).toBe(base.worker1.id);
  });

  it("рейтинг бригад 70% качество / 30% сроки", async () => {
    const o = await insertOrder(base, { status: "CLOSED", deadline: new Date(Date.now() - hour), closedAt: new Date() });
    await prisma.aiAssessment.create({ data: { workOrderId: o.id, verdict: "ACCEPTED", score: 5, explanation: "x" } });
    const res = await request(app).get("/api/reports/brigade-ratings").set(bearer(base.manager));
    expect(res.body[0]).toMatchObject({ name: "Бригада А", closed: 1, quality: 5, onTimeRate: 0, score: 70 });
  });

  it("материалы и простои", async () => {
    const o = await insertOrder(base, { status: "CLOSED" });
    await prisma.materialUsage.create({ data: { workOrderId: o.id, materialId: base.bearing.id, quantity: 3 } });
    await prisma.equipmentDowntime.create({ data: { equipmentId: base.pump.id, workOrderId: o.id, startedAt: new Date(Date.now() - 2 * hour), endedAt: new Date(Date.now() - hour) } });
    const m = await request(app).get("/api/reports/materials").set(bearer(base.manager));
    expect(m.body[0]).toMatchObject({ quantity: 3, count: 1, unit: "шт", deviationPercent: null, _sum: { quantity: "3" }, material: { name: "Подшипник 6205" } });
    const d = await request(app).get("/api/reports/downtime").set(bearer(base.manager));
    expect(d.body.items[0].minutes).toBe(60);
    expect(d.body.byEquipment[0]).toMatchObject({ equipment: "Насос Н-1", minutes: 60, plannedMinutes: 60, unplannedMinutes: 0 });
    expect((await request(app).get(`/api/reports/work-order/${o.id}`).set(bearer(base.manager))).body.id).toBe(o.id);
  });

  it("Excel: заголовки и строки", async () => {
    await insertOrder(base, { status: "CLOSED" });
    const res = await request(app).get("/api/reports/export.xlsx").set(bearer(base.master)).buffer(true).parse(binary);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.getWorksheet("Наряды")!;
    expect(sheet.getRow(1).values).toContain("Оборудование");
    expect(sheet.rowCount).toBe(2);
  });

  it("PDF: валидный документ", async () => {
    await insertOrder(base, { status: "CLOSED" });
    const res = await request(app).get("/api/reports/export.pdf").set(bearer(base.master)).buffer(true).parse(binary);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
