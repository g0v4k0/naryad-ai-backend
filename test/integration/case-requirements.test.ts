import ExcelJS from "exceljs";
import sharp from "sharp";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { exifCaptureTime } from "../../src/lib/exif.js";
import { prisma } from "../../src/lib/prisma.js";
import { exifWallTime } from "../../src/lib/time.js";
import { reviewWorkOrder } from "../../src/services/ai-review.js";
import { buildAnomalies } from "../../src/services/analytics.js";
import { checkDeadlines } from "../../src/services/deadlines.js";
import { bearer, createUser, insertOrder, seedBase, type Base } from "../helpers/db.js";
import { saveUpload, scene } from "../helpers/images.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

// Требования кейса «НарядAI», которые закрывались отдельно от исходной реализации; номера — разделы кейса.
let base: Base;
beforeEach(async () => { base = await seedBase(); });
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const binary = (res: any, cb: any) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); };
const ollamaDown = () => { mocks.ollama.handler = () => ({ status: 500 }); };
/** UTC time of a plant-local (UTC+5) hour `daysAgo` days back. */
const localAt = (daysAgo: number, hour: number) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5));
};

describe("5.1 выдача наряда", () => {
  it("при выборе исполнителя виден статус: свободен / выполняет наряд №… / в очереди N / не на смене", async () => {
    const current = await insertOrder(base, { status: "IN_PROGRESS", assigneeId: base.worker1.id });
    await insertOrder(base, { status: "QUEUED", assigneeId: base.worker1.id });
    await insertOrder(base, { status: "ISSUED", assigneeId: base.worker2.id });
    const res = await request(app).get("/api/references/executors").set(bearer(base.master));
    const byId = (id: number) => res.body.find((x: any) => x.id === id);
    expect(byId(base.worker1.id)).toMatchObject({ statusText: `выполняет наряд №${current.number}, в очереди 1`, queue: 1, currentOrder: { id: current.id } });
    expect(byId(base.worker2.id)).toMatchObject({ statusText: "в очереди 1 наряд", currentOrder: null });
    expect(byId(base.worker3.id).statusText).toBe("не на смене");
    expect((await request(app).get("/api/references/executors?specialty=Электрик").set(bearer(base.master))).body.map((x: any) => x.id)).toEqual([base.worker2.id]);
  });

  it("ИИ-подбор: свободный исполнитель нужной специальности идёт первым, даже если у другого балл выше", async () => {
    const done = await insertOrder(base, { status: "CLOSED", assigneeId: base.worker2.id });
    await prisma.aiAssessment.create({ data: { workOrderId: done.id, verdict: "ACCEPTED", score: 5, explanation: "x" } });
    const leak = await request(app).get(`/api/recommendations/executors?equipmentId=${base.pump.id}&description=${encodeURIComponent("Течь масла из-под крышки насоса")}`).set(bearer(base.master));
    expect(leak.body[0]).toMatchObject({ id: base.worker1.id, specialtyMatch: true, requiredSpecialty: "Слесарь" });
    expect(leak.body[1]).toMatchObject({ id: base.worker2.id, specialtyMatch: false });
    const electric = await request(app).get(`/api/recommendations/executors?equipmentId=${base.pump.id}&faultCodeId=${base.fault2.id}`).set(bearer(base.master));
    expect(electric.body[0]).toMatchObject({ id: base.worker2.id, requiredSpecialty: "Электрик" });
  });

  it("наряд можно выдать бригаде: старшим назначается лучший член бригады на смене, остальные уведомлены", async () => {
    const res = await request(app).post("/api/work-orders").set(bearer(base.master)).send({
      type: "PLANNED", description: "Замена подшипника насоса", areaId: base.area.id, equipmentId: base.pump.id,
      brigadeId: base.brigade.id, priority: "NORMAL", normativeId: base.normative.id
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ brigadeId: base.brigade.id, assigneeId: base.worker1.id });
    expect(await prisma.notification.count({ where: { userId: base.worker2.id, type: "BRIGADE_ORDER" } })).toBe(1);
    const empty = await prisma.brigade.create({ data: { name: "Пустая" } });
    const none = await request(app).post("/api/work-orders").set(bearer(base.master)).send({ type: "PLANNED", description: "abc", areaId: base.area.id, equipmentId: base.pump.id, brigadeId: empty.id, priority: "NORMAL", normativeId: base.normative.id });
    expect(none.status).toBe(400);
    const neither = await request(app).post("/api/work-orders").set(bearer(base.master)).send({ type: "PLANNED", description: "abc", areaId: base.area.id, equipmentId: base.pump.id, priority: "NORMAL", normativeId: base.normative.id });
    expect(neither.status).toBe(400);
    const outsider = await request(app).post("/api/work-orders").set(bearer(base.master)).send({ type: "PLANNED", description: "abc", areaId: base.area.id, equipmentId: base.pump.id, brigadeId: empty.id, assigneeId: base.worker1.id, priority: "NORMAL", normativeId: base.normative.id });
    expect(outsider.status).toBe(400);
    expect((await request(app).get(`/api/work-orders?brigadeId=${base.brigade.id}`).set(bearer(base.master))).body).toHaveLength(1);
  });

  it("мастер отменяет наряд в работе или на доработке; простой оборудования закрывается", async () => {
    const order = await insertOrder(base, { status: "IN_PROGRESS", type: "EMERGENCY" });
    await prisma.equipmentDowntime.create({ data: { equipmentId: base.pump.id, workOrderId: order.id, startedAt: new Date(Date.now() - HOUR) } });
    const res = await request(app).post(`/api/work-orders/${order.id}/action`).set(bearer(base.master)).send({ action: "CANCEL", comment: "Оборудование выведено в резерв" });
    expect(res.body.order.status).toBe("CANCELLED");
    expect((await prisma.equipmentDowntime.findUniqueOrThrow({ where: { workOrderId: order.id } })).endedAt).not.toBeNull();
    const rework = await insertOrder(base, { status: "REWORK" });
    expect((await request(app).post(`/api/work-orders/${rework.id}/action`).set(bearer(base.master)).send({ action: "CANCEL" })).status).toBe(200);
  });
});

describe("5.2 панель мастера", () => {
  it("фильтры по оборудованию, приоритету, типу, просрочке; признак isOverdue", async () => {
    const late = await insertOrder(base, { status: "IN_PROGRESS", priority: "EMERGENCY", type: "EMERGENCY", deadline: new Date(Date.now() - MIN) });
    await insertOrder(base, { status: "ISSUED", equipmentId: base.conveyor.id, priority: "NORMAL" });
    await insertOrder(base, { status: "CLOSED", deadline: new Date(Date.now() - DAY) });
    const get = (q: string) => request(app).get(`/api/work-orders?${q}`).set(bearer(base.master));
    expect((await get("overdue=1")).body.map((x: any) => x.id)).toEqual([late.id]);
    expect((await get(`equipmentId=${base.conveyor.id}`)).body).toHaveLength(1);
    expect((await get("priority=EMERGENCY,HIGH")).body).toHaveLength(1);
    expect((await get("type=EMERGENCY")).body).toHaveLength(1);
    expect((await get("status=IN_PROGRESS,ISSUED&compact=1")).body.find((x: any) => x.id === late.id).isOverdue).toBe(true);
    expect((await get("status=NOPE")).status).toBe(400);
  });

  it("канбан: колонки по статусам, просроченные отдельно, счётчики смены", async () => {
    await insertOrder(base, { status: "ISSUED" });
    await insertOrder(base, { status: "ACCEPTED" });
    const late = await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - MIN), type: "EMERGENCY" });
    await prisma.equipmentDowntime.create({ data: { equipmentId: base.pump.id, workOrderId: late.id, startedAt: new Date() } });
    await insertOrder(base, { status: "QUEUED" });
    await insertOrder(base, { status: "AI_REVIEW", completedAt: new Date() });
    await insertOrder(base, { status: "CLOSED", closedAt: new Date(Date.now() - 5 * DAY), createdAt: new Date(Date.now() - 6 * DAY) });
    const res = await request(app).get("/api/work-orders/board").set(bearer(base.master));
    const sizes = Object.fromEntries(Object.entries(res.body.columns).map(([k, v]) => [k, (v as unknown[]).length]));
    expect(sizes).toEqual({ issued: 1, accepted: 1, inProgress: 1, queued: 1, completed: 1, overdue: 1 });
    expect(res.body.counters).toEqual({ issued: 5, completed: 1, overdue: 1, equipmentInDowntime: 1 });
    const mine = await request(app).get("/api/work-orders/board").set(bearer(base.worker2));
    expect(mine.body.counters.issued).toBe(0);
  });
});

describe("5.3 приложение исполнителя", () => {
  it("комментарий без смены статуса: свой наряд — можно, чужой — 403; повтор по clientActionId не дублирует", async () => {
    const order = await insertOrder(base, { status: "IN_PROGRESS" });
    const send = (user: any, body: object) => request(app).post(`/api/work-orders/${order.id}/comment`).set(bearer(user)).send(body);
    expect((await send(base.worker1, { comment: "ждём подшипник со склада", clientActionId: "comment-0001" })).status).toBe(201);
    expect((await send(base.worker1, { comment: "ждём подшипник со склада", clientActionId: "comment-0001" })).body.replayed).toBe(true);
    expect((await send(base.worker2, { comment: "x" })).status).toBe(403);
    expect((await send(base.worker1, { comment: " " })).status).toBe(400);
    expect((await request(app).post("/api/work-orders/999999/comment").set(bearer(base.master)).send({ comment: "x" })).status).toBe(404);
    expect(await prisma.workOrderEvent.count({ where: { workOrderId: order.id, action: "COMMENT" } })).toBe(1);
  });
});

describe("6.1 контроль сроков", () => {
  it("сообщение о просрочке: номер, оборудование, участок, исполнитель, статус, на сколько, последний комментарий", async () => {
    const order = await insertOrder(base, { status: "IN_PROGRESS", startedAt: new Date(Date.now() - 2 * HOUR), deadline: new Date(Date.now() - 45.5 * MIN) });
    await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: base.worker1.id, action: "COMMENT", comment: "ждём подшипник со склада" } });
    await checkDeadlines();
    const message = (await prisma.notification.findFirstOrThrow({ where: { userId: base.master.id } })).message;
    expect(message).toContain(`Наряд №${order.number} просрочен на 45 мин.`);
    expect(message).toContain("Насос Н-1, участок дробление.");
    expect(message).toContain("Исполнитель: Слесарь 1.");
    expect(message).toMatch(/Статус: в работе с \d{2}:\d{2}\./);
    expect(message).toContain("Последний комментарий: “ждём подшипник со склада”.");
  });

  it("непринятый наряд с далёким сроком тоже эскалируется, мастеру предлагается свободный исполнитель", async () => {
    const order = await insertOrder(base, { status: "ISSUED", createdAt: new Date(Date.now() - 11 * MIN), deadline: new Date(Date.now() + 5 * HOUR) });
    await checkDeadlines();
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: base.master.id, type: "NOT_ACCEPTED", workOrderId: order.id } });
    expect(note.message).toContain("Предлагаем переназначить: Электрик 2 (электрик), свободен.");
    await prisma.user.update({ where: { id: base.worker2.id }, data: { employeeStatus: "BUSY" } });
    const other = await insertOrder(base, { status: "ISSUED", priority: "EMERGENCY", createdAt: new Date(Date.now() - 4 * MIN), deadline: new Date(Date.now() + 5 * HOUR) });
    await checkDeadlines();
    expect((await prisma.notification.findFirstOrThrow({ where: { workOrderId: other.id, type: "NOT_ACCEPTED" } })).message).toContain("Свободных исполнителей на смене нет.");
    await checkDeadlines();
    expect(await prisma.notification.count({ where: { type: "NOT_ACCEPTED" } })).toBe(2);
  });
});

describe("6.3 фото: время съёмки и низкая уверенность", () => {
  const withTime = async (seed: number, takenAt: Date) => sharp(await scene(seed)).withExif({ IFD0: { DateTime: exifWallTime(takenAt), Make: "SecretPhone" } }).jpeg().toBuffer();
  const completed = async (afterTakenAt: Date | null) => {
    const order = await insertOrder(base, { status: "COMPLETED", type: "EMERGENCY", completionText: "Заменён подшипник, вибрация в норме", faultCodeId: base.fault.id, createdAt: new Date(Date.now() - 3 * HOUR), startedAt: new Date(Date.now() - HOUR), completedAt: new Date() });
    const buffer = afterTakenAt ? await withTime(order.id + 50, afterTakenAt) : await scene(order.id + 50);
    await prisma.photo.create({ data: { workOrderId: order.id, authorId: base.worker1.id, type: "AFTER", fileUrl: await saveUpload(`t${order.id}.jpg`, buffer) } });
    return order;
  };

  it("загрузка сохраняет время съёмки из EXIF и убирает остальные метаданные; без EXIF берётся takenAt клиента", async () => {
    const shot = new Date(Math.floor((Date.now() - 10 * MIN) / 1000) * 1000);
    const res = await request(app).post("/api/uploads").set(bearer(base.worker1)).attach("file", await withTime(7, shot), "a.jpg");
    expect(res.body.takenAt).toBe(shot.toISOString());
    const stored = await readFile(`uploads/${res.body.url.split("?")[0].split("/").pop()}`);
    const exif = (await sharp(stored).metadata()).exif;
    expect(exifCaptureTime(exif)?.toISOString()).toBe(shot.toISOString());
    expect(exif!.toString("latin1")).not.toContain("SecretPhone");
    const client = await request(app).post("/api/uploads").set(bearer(base.worker1)).field("takenAt", shot.toISOString()).attach("file", await scene(8), "b.jpg");
    expect(client.body.takenAt).toBe(shot.toISOString());
    const none = await request(app).post("/api/uploads").set(bearer(base.worker1)).field("takenAt", "вчера").attach("file", await scene(9), "c.jpg");
    expect(none.body.takenAt).toBeNull();
  });

  it("фото «после» снято раньше выдачи наряда → старый снимок, доработка", async () => {
    mocks.ollama.handler = () => ollamaReply({ verdict: "ACCEPTED", score: 5, explanation: "ok", strengths: [], improvements: [] });
    const order = await completed(new Date(Date.now() - 3 * DAY));
    const a = await reviewWorkOrder(order.id);
    expect(a.verdict).toBe("REWORK_REQUIRED");
    expect(a.photoComment).toContain("раньше выдачи наряда");
  });

  it("фото «после» снято до начала работ → вердикт не меняется, но наряд помечен «нужна проверка мастером»", async () => {
    mocks.ollama.handler = () => ollamaReply({ verdict: "ACCEPTED", score: 5, explanation: "ok", strengths: [], improvements: [] });
    const order = await completed(new Date(Date.now() - 2 * HOUR));
    const a = await reviewWorkOrder(order.id);
    expect(a).toMatchObject({ verdict: "ACCEPTED", needsMasterReview: true });
    expect(a.explanation).toMatch(/^Нужна проверка мастером\./);
    expect(a.photoComment).toContain("до начала работ");
  });

  it("свежее фото без сравнения проходит без флага; без LLM — флаг", async () => {
    mocks.ollama.handler = () => ollamaReply({ verdict: "ACCEPTED", score: 5, explanation: "ok", strengths: [], improvements: [] });
    expect(await reviewWorkOrder((await completed(new Date(Date.now() - 5 * MIN))).id)).toMatchObject({ verdict: "ACCEPTED", needsMasterReview: false });
    ollamaDown();
    expect((await reviewWorkOrder((await completed(null)).id)).needsMasterReview).toBe(true);
  });
});

describe("6.4 отчёт по наряду", () => {
  async function closedOrder() {
    const now = Date.now();
    const order = await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", normativeId: base.normative.id, faultCodeId: base.fault.id, completionText: "Заменён подшипник", createdAt: new Date(now - 4 * HOUR), startedAt: new Date(now - 3 * HOUR), completedAt: new Date(now - HOUR), closedAt: new Date(now - 0.5 * HOUR), deadline: new Date(now - 0.75 * HOUR) });
    await prisma.aiAssessment.create({ data: { workOrderId: order.id, verdict: "ACCEPTED_WITH_COMMENTS", score: 4, masterScore: 5, explanation: "Хорошо", strengths: ["Конкретно"], improvements: ["Фото"] } });
    await prisma.equipmentDowntime.create({ data: { equipmentId: base.pump.id, workOrderId: order.id, startedAt: new Date(now - 4 * HOUR), endedAt: new Date(now - 0.5 * HOUR) } });
    await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: base.worker1.id, action: "START", toStatus: "IN_PROGRESS" } });
    return order;
  }

  it("исполнителю: оценка, что хорошо, что улучшить, время против норматива", async () => {
    const order = await closedOrder();
    const res = await request(app).get(`/api/work-orders/${order.id}/report`).set(bearer(base.worker1));
    expect(res.body).toMatchObject({ audience: "EXECUTOR", finalScore: 5, aiScore: 4, strengths: ["Конкретно"], improvements: ["Фото"], timing: { normativeHours: 2, actualHours: 2, vsNormativePercent: 100, deadlineMet: true } });
    expect(res.body.chronology).toBeUndefined();
    expect((await request(app).get(`/api/work-orders/${order.id}/report`).set(bearer(base.worker2))).status).toBe(403);
    expect((await request(app).get("/api/work-orders/999999/report").set(bearer(base.worker2))).status).toBe(404);
  });

  it("мастеру: хронология, фото до/после, вердикт ИИ, простой; PDF наряда", async () => {
    const order = await closedOrder();
    const res = await request(app).get(`/api/work-orders/${order.id}/report`).set(bearer(base.master));
    expect(res.body).toMatchObject({ audience: "MASTER", downtimeMinutes: 210, finalScore: 5, photosBefore: [], photosAfter: [], chronology: [{ action: "START", actor: "Слесарь 1" }] });
    expect((await request(app).get(`/api/reports/work-order/${order.id}`).set(bearer(base.manager))).body.timing.actualHours).toBe(2);
    expect((await request(app).get("/api/work-orders/999999/report").set(bearer(base.master))).status).toBe(404);
    expect((await request(app).get("/api/reports/work-order/999999").set(bearer(base.master))).status).toBe(404);
    const pdf = await request(app).get(`/api/reports/work-order/${order.id}.pdf`).set(bearer(base.master)).buffer(true).parse(binary);
    expect(pdf.headers["content-type"]).toContain("pdf");
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    expect((await request(app).get("/api/reports/work-order/999999.pdf").set(bearer(base.master))).status).toBe(404);
    const detail = await request(app).get(`/api/work-orders/${order.id}`).set(bearer(base.worker1));
    expect(detail.body.timing).toMatchObject({ normativeHours: 2, deadlineMet: true });
  });
});

describe("6.5 аналитика: закономерности", () => {
  const closedAt = (data: Record<string, unknown>) => insertOrder(base, { status: "CLOSED", ...data });

  it("связь со сменой и временем суток", async () => {
    for (let i = 0; i < 9; i++) await closedAt({ type: "EMERGENCY", createdAt: localAt(i + 2, 2), closedAt: localAt(i + 2, 4) });
    for (let i = 0; i < 3; i++) await closedAt({ type: "EMERGENCY", createdAt: localAt(i + 2, 13), closedAt: localAt(i + 2, 15) });
    const types = (await buildAnomalies()).map((x) => x.type);
    expect(types).toContain("SHIFT_PATTERN");
    expect(types).toContain("TIME_OF_DAY");
    const shift = (await prisma.anomalyInsight.findFirstOrThrow({ where: { type: "SHIFT_PATTERN" } }));
    expect(shift.title).toBe("Аварии чаще в ночную смену");
    expect(shift.evidence).toMatchObject({ total: 12, night: 9 });
  });

  it("исполнитель, после которого та же поломка возвращается в течение 7 дней", async () => {
    for (const days of [40, 30, 20, 10]) {
      await closedAt({ type: "PLANNED", faultCodeId: base.fault.id, assigneeId: base.worker1.id, createdAt: new Date(Date.now() - (days + 1) * DAY), closedAt: new Date(Date.now() - days * DAY) });
      await closedAt({ type: "EMERGENCY", faultCodeId: base.fault.id, assigneeId: base.worker2.id, createdAt: new Date(Date.now() - (days - 2) * DAY), closedAt: new Date(Date.now() - (days - 2) * DAY + HOUR) });
    }
    for (let i = 0; i < 6; i++) await closedAt({ type: "PLANNED", faultCodeId: base.fault2.id, equipmentId: base.crusher.id, areaId: base.area2.id, assigneeId: base.worker2.id, createdAt: new Date(Date.now() - (60 + i) * DAY), closedAt: new Date(Date.now() - (60 + i) * DAY + HOUR) });
    const insight = (await buildAnomalies()).find((x) => x.type === "EXECUTOR_REPEAT_FAILURES");
    expect(insight).toMatchObject({ title: "Слесарь 1: повторные отказы после ремонта", evidence: { executorId: base.worker1.id, closed: 4, repeats: 4, restRate: 0 } });
  });

  it("повторные отказы бригады выше, чем у других бригад", async () => {
    const other = await prisma.brigade.create({ data: { name: "Бригада Б" } });
    const worker4 = await createUser({ login: "worker4", role: "EXECUTOR", fullName: "Слесарь 4", specialty: "Слесарь", brigadeId: other.id });
    for (const days of [40, 30, 20, 10]) {
      await closedAt({ type: "PLANNED", faultCodeId: base.fault.id, assigneeId: base.worker1.id, createdAt: new Date(Date.now() - (days + 1) * DAY), closedAt: new Date(Date.now() - days * DAY) });
      await closedAt({ type: "EMERGENCY", faultCodeId: base.fault.id, assigneeId: worker4.id, equipmentId: base.pump.id, createdAt: new Date(Date.now() - (days - 2) * DAY), closedAt: new Date(Date.now() - (days - 2) * DAY + HOUR) });
    }
    const insight = (await buildAnomalies()).find((x) => x.type === "BRIGADE_REPEAT_FAILURES");
    expect(insight).toMatchObject({ title: "Бригада А: повторные отказы выше, чем у других", evidence: { brigadeId: base.brigade.id, repeats: 4 } });
  });

  it("проблемный участок считается на единицу оборудования", async () => {
    for (let i = 0; i < 6; i++) await closedAt({ type: "EMERGENCY", createdAt: new Date(Date.now() - (i + 2) * DAY), actualDowntimeMinutes: 120 });
    for (let i = 0; i < 2; i++) await closedAt({ type: "EMERGENCY", equipmentId: base.crusher.id, areaId: base.area2.id, createdAt: new Date(Date.now() - (i + 2) * DAY), actualDowntimeMinutes: 60 });
    const insights = await buildAnomalies();
    expect(insights.find((x) => x.type === "AREA_HOTSPOT")).toMatchObject({ areaId: base.area.id, evidence: { emergenciesPerUnit: 6, units: 1 } });
    const filtered = await request(app).get(`/api/analytics/anomalies?areaId=${base.area2.id}`).set(bearer(base.manager));
    expect(filtered.body.every((x: any) => x.areaId === null || x.areaId === base.area2.id)).toBe(true);
    const run = await request(app).post("/api/analytics/anomalies/run").set(bearer(base.manager)).send({ areaId: base.area2.id });
    expect(run.body.insights.some((x: any) => x.type === "AREA_HOTSPOT")).toBe(false);
  });

  it("расход сравнивается с нормативом: разные работы с разной нормой не аномалия, превышение нормы — аномалия", async () => {
    const big = await prisma.workNormative.create({ data: { name: "Полная замена смазки", equipmentType: "Насос", hours: 4, materialNorms: { create: [{ materialId: base.grease.id, quantity: 10 }] } } });
    const small = await prisma.workNormative.create({ data: { name: "Подсмазка", equipmentType: "Насос", hours: 1, materialNorms: { create: [{ materialId: base.grease.id, quantity: 1 }] } } });
    for (const [i, [normativeId, quantity]] of ([[small.id, 1], [small.id, 1], [small.id, 1], [big.id, 10]] as const).entries()) {
      const o = await closedAt({ normativeId, createdAt: new Date(Date.now() - (i + 2) * DAY) });
      await prisma.materialUsage.create({ data: { workOrderId: o.id, materialId: base.grease.id, quantity } });
    }
    expect((await buildAnomalies()).some((x) => x.type === "MATERIAL_ANOMALY")).toBe(false);
    const o = await closedAt({ normativeId: small.id, createdAt: new Date(Date.now() - 2 * DAY) });
    await prisma.materialUsage.create({ data: { workOrderId: o.id, materialId: base.grease.id, quantity: 3 } });
    expect((await buildAnomalies()).find((x) => x.type === "MATERIAL_ANOMALY")!.description).toContain("списано до 10 при норме 10");
  });

  it("оборудование, которое ломается постоянно, не считается «отказывающим после ППР»", async () => {
    await closedAt({ type: "PLANNED", createdAt: new Date(Date.now() - 50 * DAY) });
    for (let day = 1; day < 89; day += 3) await closedAt({ type: "EMERGENCY", createdAt: new Date(Date.now() - day * DAY - HOUR) });
    await closedAt({ type: "PLANNED", equipmentId: base.conveyor.id, createdAt: new Date(Date.now() - 50 * DAY) });
    expect((await buildAnomalies()).some((x) => x.type === "FAILURE_AFTER_PLANNED_MAINTENANCE")).toBe(false);
  });

  it("дашборд: топ проблемных участков", async () => {
    for (let i = 0; i < 3; i++) await insertOrder(base, { type: "EMERGENCY", actualDowntimeMinutes: 30 });
    await insertOrder(base, { type: "PLANNED", equipmentId: base.crusher.id, areaId: base.area2.id });
    const res = await request(app).get("/api/analytics/dashboard").set(bearer(base.manager));
    expect(res.body.topAreas[0]).toMatchObject({ name: "Дробление", emergencies: 3, emergenciesPerUnit: 3, downtime: 90 });
  });
});

describe("6.6 рейтинг", () => {
  it("повторная поломка за 7 дней снижает рейтинг; пояснение показывает, где потеряны баллы", async () => {
    const repaired = await insertOrder(base, { status: "CLOSED", faultCodeId: base.fault.id, closedAt: new Date(Date.now() - 5 * DAY), createdAt: new Date(Date.now() - 6 * DAY), deadline: new Date(Date.now() - 4 * DAY) });
    await prisma.aiAssessment.create({ data: { workOrderId: repaired.id, verdict: "ACCEPTED", score: 5, explanation: "x" } });
    await insertOrder(base, { status: "IN_PROGRESS", type: "EMERGENCY", faultCodeId: base.fault.id, assigneeId: base.worker2.id, createdAt: new Date(Date.now() - 3 * DAY) });
    const res = await request(app).get("/api/reports/ratings").set(bearer(base.manager));
    const w1 = res.body.find((x: any) => x.id === base.worker1.id);
    // 45 + 25 + 0 (возврат) + 0.5 + 0 = 70.5
    expect(w1).toMatchObject({ score: 70.5, repeatFailureRate: 1, returnRate: 1, reworkRate: 0, points: { quality: 45, onTime: 25, noReturns: 0 } });
    expect(w1.explanation).toContain("без доработок и повторных поломок 0% → 0 из 15");
    expect(w1.explanation).toContain("Больше всего баллов можно добавить, если устранять причину поломки");
    const mine = await request(app).get("/api/reports/my-rating").set(bearer(base.worker1));
    expect(mine.body).toMatchObject({ id: base.worker1.id, score: 70.5 });
    expect((await request(app).get("/api/reports/my-rating").set(bearer(base.manager))).status).toBe(404);
    expect((await request(app).get("/api/reports/ratings").set(bearer(base.worker1))).status).toBe(403);
    expect((await request(app).get(`/api/reports/ratings?brigadeId=${base.brigade.id}&period=week`).set(bearer(base.manager))).body).toHaveLength(2);
  });

  it("возврат на доработку мастером учитывается, даже если итоговый вердикт «принято»", async () => {
    const o = await insertOrder(base, { status: "CLOSED", closedAt: new Date(), deadline: new Date(Date.now() + HOUR) });
    await prisma.aiAssessment.create({ data: { workOrderId: o.id, verdict: "ACCEPTED", score: 5, explanation: "x" } });
    await prisma.workOrderEvent.create({ data: { workOrderId: o.id, actorId: base.master.id, action: "SEND_TO_REWORK" } });
    const w1 = (await request(app).get("/api/reports/ratings").set(bearer(base.manager))).body.find((x: any) => x.id === base.worker1.id);
    expect(w1).toMatchObject({ reworkRate: 1, returnRate: 1 });
    const none = (await request(app).get("/api/reports/ratings").set(bearer(base.manager))).body.find((x: any) => x.id === base.worker3.id);
    expect(none.explanation).toBe("Закрытых нарядов за период нет. Рейтинг 0.");
  });
});

describe("7 отчёты", () => {
  it("отчёт за смену: отклонено, загрузка людей, простои", async () => {
    await insertOrder(base, { status: "REJECTED" });
    await insertOrder(base, { status: "IN_PROGRESS", assigneeId: base.worker2.id });
    await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", actualDowntimeMinutes: 40 });
    ollamaDown();
    const res = await request(app).get("/api/reports/shift").set(bearer(base.master));
    expect(res.body).toMatchObject({ issued: 3, rejected: 1, closed: 1, workload: { executorsOnShift: 2, busy: 1, free: 1 }, downtime: { minutes: 40, orders: 1 } });
    expect(res.body.load.find((x: any) => x.id === base.worker1.id)).toMatchObject({ assigned: 2, completed: 1, activeNow: 0 });
  });

  it("материалы: отклонение от нормы и группировка по участку", async () => {
    for (const quantity of [3, 5]) {
      const o = await insertOrder(base, { status: "CLOSED", normativeId: base.normative.id });
      await prisma.materialUsage.create({ data: { workOrderId: o.id, materialId: base.bearing.id, quantity } });
    }
    const res = await request(app).get("/api/reports/materials?groupBy=area").set(bearer(base.manager));
    expect(res.body[0]).toMatchObject({ group: { id: base.area.id, name: "Дробление" }, quantity: 8, count: 2, normQuantity: 4, deviationPercent: 100, overNormCount: 1 });
    expect((await request(app).get("/api/reports/materials?groupBy=nope").set(bearer(base.manager))).status).toBe(400);
  });

  it("простои: причины по шифрам, доля плановых и внеплановых", async () => {
    await insertOrder(base, { status: "CLOSED", type: "PLANNED", faultCodeId: base.fault.id, actualDowntimeMinutes: 60 });
    const em = await insertOrder(base, { status: "IN_PROGRESS", type: "EMERGENCY", faultCodeId: base.fault2.id });
    await prisma.equipmentDowntime.create({ data: { equipmentId: base.pump.id, workOrderId: em.id, startedAt: new Date(Date.now() - 30 * MIN) } });
    const res = await request(app).get("/api/reports/downtime").set(bearer(base.manager));
    expect(res.body.totals).toMatchObject({ minutes: 90, plannedMinutes: 60, unplannedMinutes: 30, ongoing: 1 });
    expect(res.body.byEquipment[0].byFaultCode.map((x: any) => [x.code, x.minutes])).toEqual([["М-01", 60], ["Э-02", 30]]);
  });

  it.each(["shift", "ratings", "brigades", "materials", "downtime", "anomalies", "orders"])("выгрузка %s в Excel и PDF", async (report) => {
    ollamaDown();
    const o = await insertOrder(base, { status: "CLOSED", type: "EMERGENCY", actualDowntimeMinutes: 10, faultCodeId: base.fault.id, normativeId: base.normative.id });
    await prisma.materialUsage.create({ data: { workOrderId: o.id, materialId: base.bearing.id, quantity: 2 } });
    const xlsx = await request(app).get(`/api/reports/export.xlsx?report=${report}`).set(bearer(base.master)).buffer(true).parse(binary);
    expect(xlsx.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body);
    expect(workbook.worksheets[0].rowCount).toBeGreaterThanOrEqual(1);
    const pdf = await request(app).get(`/api/reports/export.pdf?report=${report}`).set(bearer(base.master)).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("6.7 ассистент: участок и период", () => {
  it("«Сформируй отчёт за неделю по участку обогащения» → отчёт за 7 дней только по участку", async () => {
    ollamaDown();
    await insertOrder(base, { equipmentId: base.crusher.id, areaId: base.area2.id, createdAt: new Date(Date.now() - 2 * DAY) });
    await insertOrder(base, { equipmentId: base.crusher.id, areaId: base.area2.id, createdAt: new Date(Date.now() - 10 * DAY) });
    await insertOrder(base, { createdAt: new Date(Date.now() - 2 * DAY) });
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Сформируй отчёт за неделю по участку обогащения" });
    expect(res.body.intent).toMatchObject({ intent: "SHIFT_REPORT", periodDays: 7, area: "Обогащение" });
    expect(res.body.data).toMatchObject({ area: "Обогащение", periodDays: 7, issued: 1 });
  });

  it("«Покажи проблемы участка дробления за месяц» → аномалии за 30 дней по участку; период от модели проверяется", async () => {
    ollamaDown();
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Покажи проблемы участка дробления за месяц" });
    expect(res.body.intent).toMatchObject({ intent: "ANOMALIES", periodDays: 30, area: "Дробление" });
    mocks.ollama.handler = (body) => body.messages[0].content.startsWith("Определи намерение") ? ollamaReply({ intent: "OVERDUE", periodDays: "много", areaQuery: "обогащение" }) : ollamaReply({ answer: "Нет" });
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - HOUR) });
    const overdue = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Что просрочено на обогащении?" });
    expect(overdue.body.intent).toMatchObject({ intent: "OVERDUE", area: "Обогащение" });
    expect(overdue.body.intent.periodDays).toBeUndefined();
    expect(overdue.body.data).toEqual([]);
    mocks.ollama.handler = (body) => body.messages[0].content.startsWith("Определи намерение") ? ollamaReply({ intent: "FAILURE_FORECAST", areaQuery: "обогащение" }) : ollamaReply({ answer: "Нет" });
    await insertOrder(base, { type: "EMERGENCY", createdAt: new Date(Date.now() - DAY) });
    const forecast = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Прогноз по обогащению" });
    expect(forecast.body.data).toEqual([]);
  });
});
