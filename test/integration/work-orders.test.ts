import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { bearer, insertOrder, seedBase, type Base } from "../helpers/db.js";

let base: Base;
beforeEach(async () => { base = await seedBase(); });

async function createOrder(overrides: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/work-orders").set(bearer(base.master)).send({
    type: "PLANNED", description: "Шум подшипника насоса", areaId: base.area.id, equipmentId: base.pump.id,
    assigneeId: base.worker1.id, priority: "NORMAL", normativeId: base.normative.id, ...overrides
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const act = (id: number, user: Base[keyof Base], body: Record<string, unknown>) =>
  request(app).post(`/api/work-orders/${id}/action`).set(bearer(user as any)).send(body);

describe("создание наряда", () => {
  it("мастер создаёт наряд: событие CREATE, уведомление, статус исполнителя, задание 1С", async () => {
    const order = await createOrder();
    expect(order).toMatchObject({ status: "ISSUED", assignee: { id: base.worker1.id } });
    expect(order.number).toMatch(/^N-\d{8}$/);
    const deadlineHours = (new Date(order.deadline).getTime() - new Date(order.createdAt).getTime()) / 3_600_000;
    expect(deadlineHours).toBeCloseTo(2, 1); // из норматива
    expect(await prisma.workOrderEvent.count({ where: { workOrderId: order.id, action: "CREATE" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: base.worker1.id, type: "NEW_ORDER" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: base.worker1.id } })).employeeStatus).toBe("QUEUED");
    expect(await prisma.integrationJob.count({ where: { localId: order.id, eventType: "CREATED" } })).toBe(1);
  });

  it("аварийный наряд открывает простой оборудования", async () => {
    const order = await createOrder({ type: "EMERGENCY", priority: "EMERGENCY" });
    const downtime = await prisma.equipmentDowntime.findUnique({ where: { workOrderId: order.id } });
    expect(downtime).toMatchObject({ equipmentId: base.pump.id, endedAt: null });
  });

  it.each([
    ["без срока и норматива", { normativeId: undefined }, 400],
    ["оборудование с другого участка", { equipmentId: base?.crusher?.id ?? 3 }, 400],
    ["исполнитель — не EXECUTOR", { assigneeId: 1 }, 400],
    ["несуществующий норматив", { normativeId: 999 }, 400],
    ["короткое описание", { description: "ab" }, 400],
    ["больше 5 фото до", { beforePhotoUrls: ["a", "b", "c", "d", "e", "f"] }, 400]
  ])("валидация: %s → %s", async (_name, overrides, status) => {
    const body = { type: "PLANNED", description: "Шум подшипника", areaId: base.area.id, equipmentId: base.pump.id, assigneeId: base.worker1.id, priority: "NORMAL", normativeId: base.normative.id, ...overrides };
    if ("equipmentId" in overrides) body.equipmentId = base.crusher.id;
    if ("assigneeId" in overrides) body.assigneeId = base.master.id;
    const res = await request(app).post("/api/work-orders").set(bearer(base.master)).send(body);
    expect(res.status).toBe(status);
  });

  it("исполнитель и начальник не создают наряды", async () => {
    for (const user of [base.worker1, base.manager]) {
      const res = await request(app).post("/api/work-orders").set(bearer(user)).send({});
      expect(res.status).toBe(403);
    }
  });
});

describe("жизненный цикл", () => {
  it("полный путь до закрытия с AI-проверкой, материалами и оценкой мастера", async () => {
    const order = await createOrder({ type: "EMERGENCY", priority: "EMERGENCY" });
    expect((await act(order.id, base.worker1, { action: "ACCEPT" })).body.order.status).toBe("ACCEPTED");
    expect((await act(order.id, base.worker1, { action: "START" })).body.order.status).toBe("IN_PROGRESS");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: base.worker1.id } })).employeeStatus).toBe("BUSY");
    expect((await act(order.id, base.worker1, { action: "PAUSE", comment: "Нет допуска" })).body.order).toMatchObject({ status: "PAUSED", pauseReason: "Нет допуска" });
    expect((await act(order.id, base.worker1, { action: "RESUME" })).body.order.status).toBe("IN_PROGRESS");
    const done = await act(order.id, base.worker1, {
      action: "COMPLETE", completionText: "Заменён подшипник, проверена вибрация", faultCodeId: base.fault.id,
      afterPhotoUrls: ["https://cdn/after.jpg"], materials: [{ materialId: base.bearing.id, quantity: 2 }]
    });
    expect(done.status).toBe(200);
    expect(done.body.order.status).toBe("AI_REVIEW");
    expect(done.body.assessment).toMatchObject({ verdict: expect.any(String), score: expect.any(Number) });
    expect(done.body.order.materialUsages).toHaveLength(1);
    const closed = await act(order.id, base.master, { action: "CLOSE", masterScore: 5, comment: "Отлично", actualDowntimeMinutes: 75 });
    expect(closed.body.order).toMatchObject({ status: "CLOSED", actualDowntimeMinutes: 75 });
    const assessment = await prisma.aiAssessment.findUniqueOrThrow({ where: { workOrderId: order.id } });
    expect(assessment).toMatchObject({ masterScore: 5, reviewedById: base.master.id });
    expect((await prisma.equipmentDowntime.findUniqueOrThrow({ where: { workOrderId: order.id } })).endedAt).not.toBeNull();
    const actions = (await prisma.workOrderEvent.findMany({ where: { workOrderId: order.id }, orderBy: { id: "asc" } })).map((x) => x.action);
    expect(actions).toEqual(["CREATE", "ACCEPT", "START", "PAUSE", "RESUME", "COMPLETE", "AI_REVIEW", "CLOSE"]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: base.worker1.id } })).employeeStatus).toBe("AVAILABLE");
  });

  it("доработка: SEND_TO_REWORK → START повторно, startedAt сохраняется", async () => {
    const order = await createOrder();
    await act(order.id, base.worker1, { action: "ACCEPT" });
    const started = (await act(order.id, base.worker1, { action: "START" })).body.order.startedAt;
    await act(order.id, base.worker1, { action: "COMPLETE", completionText: "Сделано", faultCodeId: base.fault.id });
    expect((await act(order.id, base.master, { action: "SEND_TO_REWORK", comment: "Нет фото" })).body.order.status).toBe("REWORK");
    const again = (await act(order.id, base.worker1, { action: "START" })).body.order;
    expect(again.status).toBe("IN_PROGRESS");
    expect(again.startedAt).toBe(started);
  });

  it("очередь: QUEUE → ACCEPT; отказ требует причину", async () => {
    const a = await createOrder();
    expect((await act(a.id, base.worker1, { action: "QUEUE" })).body.order.status).toBe("QUEUED");
    expect((await act(a.id, base.worker1, { action: "ACCEPT" })).body.order.status).toBe("ACCEPTED");
    const b = await createOrder();
    expect((await act(b.id, base.worker1, { action: "REJECT" })).status).toBe(400);
    expect((await act(b.id, base.worker1, { action: "PAUSE" })).status).toBe(400);
    expect((await act(b.id, base.worker1, { action: "REJECT", comment: "Нет материала" })).body.order).toMatchObject({ status: "REJECTED", rejectionReason: "Нет материала" });
  });

  it("недопустимый переход → 409", async () => {
    const order = await createOrder();
    const res = await act(order.id, base.worker1, { action: "COMPLETE" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("недоступен");
  });

  it("чужой наряд → 403, действия мастера недоступны исполнителю", async () => {
    const order = await createOrder();
    expect((await act(order.id, base.worker2, { action: "ACCEPT" })).status).toBe(403);
    expect((await act(order.id, base.worker1, { action: "CANCEL" })).status).toBe(403);
    expect((await request(app).get(`/api/work-orders/${order.id}`).set(bearer(base.worker2))).status).toBe(403);
    expect((await act(999_999, base.worker1, { action: "ACCEPT" })).status).toBe(404);
  });

  it("мастер отменяет наряд", async () => {
    const order = await createOrder();
    expect((await act(order.id, base.master, { action: "CANCEL", comment: "Дубль" })).body.order.status).toBe("CANCELLED");
  });
});

describe("офлайн-идемпотентность", () => {
  it("повтор clientActionId не меняет данные второй раз", async () => {
    const order = await createOrder();
    const first = await act(order.id, base.worker1, { action: "ACCEPT", clientActionId: "offline-123456" });
    expect(first.body.replayed).toBeUndefined();
    const second = await act(order.id, base.worker1, { action: "ACCEPT", clientActionId: "offline-123456" });
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(await prisma.workOrderEvent.count({ where: { workOrderId: order.id, action: "ACCEPT" } })).toBe(1);
  });

  it("20 параллельных повторов одного действия → одно событие, все ответы 200", async () => {
    const order = await createOrder();
    const results = await Promise.all(Array.from({ length: 20 }, () => act(order.id, base.worker1, { action: "ACCEPT", clientActionId: "burst-abcdefgh" })));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(results.filter((r) => r.body.replayed).length).toBe(19);
    expect(await prisma.workOrderEvent.count({ where: { workOrderId: order.id, action: "ACCEPT" } })).toBe(1);
  });
});

describe("списки, правка, переназначение", () => {
  it("пагинация: limit, offset, x-total-count, компактный вид без фото и материалов", async () => {
    for (let i = 0; i < 5; i++) await insertOrder(base, { priority: "NORMAL" });
    const page = await request(app).get("/api/work-orders?limit=2&offset=1").set(bearer(base.master));
    expect(page.headers["x-total-count"]).toBe("5");
    expect(page.body).toHaveLength(2);
    const all = (await request(app).get("/api/work-orders").set(bearer(base.master))).body;
    expect(page.body.map((x: any) => x.id)).toEqual(all.slice(1, 3).map((x: any) => x.id));
    const compact = (await request(app).get("/api/work-orders?compact=1").set(bearer(base.master))).body;
    expect(compact[0].photos).toBeUndefined();
    expect(compact[0].materialUsages).toBeUndefined();
    expect(compact[0].equipment.name).toBeDefined();
    expect((await request(app).get("/api/work-orders?limit=501").set(bearer(base.master))).status).toBe(400);
  });

  it("исполнитель видит только свои наряды; фильтр по статусу; сортировка по приоритету", async () => {
    await insertOrder(base, { priority: "PLANNED", assigneeId: base.worker1.id });
    await insertOrder(base, { priority: "EMERGENCY", assigneeId: base.worker1.id });
    await insertOrder(base, { priority: "HIGH", assigneeId: base.worker2.id, status: "IN_PROGRESS" });
    const mine = await request(app).get("/api/work-orders").set(bearer(base.worker1));
    expect(mine.body).toHaveLength(2);
    expect(mine.body[0].priority).toBe("EMERGENCY");
    const all = await request(app).get("/api/work-orders?status=IN_PROGRESS").set(bearer(base.master));
    expect(all.body).toHaveLength(1);
    expect((await request(app).get(`/api/work-orders?assigneeId=${base.worker2.id}`).set(bearer(base.master))).body).toHaveLength(1);
  });

  it("GET /:id отдаёт журнал событий; 404 для отсутствующего", async () => {
    const order = await createOrder();
    const res = await request(app).get(`/api/work-orders/${order.id}`).set(bearer(base.worker1));
    expect(res.body.events[0].action).toBe("CREATE");
    expect((await request(app).get("/api/work-orders/999999").set(bearer(base.master))).status).toBe(404);
  });

  it("PATCH меняет приоритет и пишет EDIT", async () => {
    const order = await createOrder();
    const res = await request(app).patch(`/api/work-orders/${order.id}`).set(bearer(base.master)).send({ priority: "EMERGENCY", comment: "Срочно" });
    expect(res.body.priority).toBe("EMERGENCY");
    expect(await prisma.workOrderEvent.count({ where: { workOrderId: order.id, action: "EDIT" } })).toBe(1);
  });

  it("переназначение уведомляет нового исполнителя и пересчитывает статусы", async () => {
    const order = await createOrder();
    const res = await request(app).post(`/api/work-orders/${order.id}/reassign`).set(bearer(base.master)).send({ assigneeId: base.worker2.id });
    expect(res.body).toMatchObject({ status: "ISSUED", assigneeId: base.worker2.id });
    expect(await prisma.notification.count({ where: { userId: base.worker2.id, type: "NEW_ORDER" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: base.worker1.id } })).employeeStatus).toBe("AVAILABLE");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: base.worker2.id } })).employeeStatus).toBe("QUEUED");
  });
});

describe("исправленные дефекты", () => {
  it.each(["COMPLETED", "AI_REVIEW", "CLOSED", "CANCELLED"] as const)("BUG-1: наряд в статусе %s нельзя переназначить (409)", async (status) => {
    const order = await insertOrder(base, { status });
    const res = await request(app).post(`/api/work-orders/${order.id}/reassign`).set(bearer(base.master)).send({ assigneeId: base.worker2.id });
    expect(res.status).toBe(409);
    expect((await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } })).assigneeId).toBe(base.worker1.id);
  });

  it("BUG-1: отклонённый наряд можно переназначить; несуществующий → 404", async () => {
    const order = await insertOrder(base, { status: "REJECTED" });
    expect((await request(app).post(`/api/work-orders/${order.id}/reassign`).set(bearer(base.master)).send({ assigneeId: base.worker2.id })).body.status).toBe("ISSUED");
    expect((await request(app).post("/api/work-orders/999999/reassign").set(bearer(base.master)).send({ assigneeId: base.worker2.id })).status).toBe(404);
  });

  it("BUG-2: переназначение на не-исполнителя → 400", async () => {
    const order = await createOrder();
    const res = await request(app).post(`/api/work-orders/${order.id}/reassign`).set(bearer(base.master)).send({ assigneeId: base.manager.id });
    expect(res.status).toBe(400);
  });

  it("BUG-3: PATCH несуществующего наряда → 404", async () => {
    const res = await request(app).patch("/api/work-orders/999999").set(bearer(base.master)).send({ priority: "HIGH" });
    expect(res.status).toBe(404);
  });

  it("BUG-4: CLOSE с masterScore без AI-оценки сохраняет оценку мастера", async () => {
    const order = await insertOrder(base, { status: "AI_REVIEW" });
    const res = await act(order.id, base.master, { action: "CLOSE", masterScore: 4, comment: "Импорт из 1С" });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("CLOSED");
    expect(await prisma.aiAssessment.findUniqueOrThrow({ where: { workOrderId: order.id } })).toMatchObject({ masterScore: 4, score: 4, reviewedById: base.master.id, explanation: "Оценка мастера без AI-проверки" });
  });
});
