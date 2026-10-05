import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { enqueueWorkOrderSync, processOneCJobs } from "../../src/services/one-c.js";
import { bearer, insertOrder, resetDb, seedBase, type Base } from "../helpers/db.js";
import { mocks } from "../helpers/mocks.js";

const key = { "x-1c-api-key": "test-1c-key-123456" };
const imp = (entity: string, items: unknown[], requestId = `req-${entity}-${Math.random()}`) =>
  request(app).post("/api/integrations/1c/import").set(key).send({ requestId, entity, items });

describe("1С: входящий импорт", () => {
  beforeEach(resetDb);

  it("ключ обязателен и сравнивается безопасно", async () => {
    expect((await request(app).get("/api/integrations/1c/ping")).status).toBe(401);
    expect((await request(app).get("/api/integrations/1c/ping").set({ "x-1c-api-key": "test-1c-key-12345X" })).status).toBe(401);
    expect((await request(app).get("/api/integrations/1c/ping").set(key)).body.status).toBe("ok");
  });

  it("цепочка справочников → наряд по externalId", async () => {
    expect((await imp("AREA", [{ externalId: "A1", name: "Дробление" }])).body.imported).toBe(1);
    await imp("BRIGADE", [{ externalId: "B1", name: "Бригада 1С" }]);
    await imp("FAULT_CODE", [{ externalId: "F1", code: "М-01", name: "Износ", category: "М" }]);
    await imp("MATERIAL", [{ externalId: "M1", name: "Подшипник", unit: "шт" }]);
    await imp("EQUIPMENT", [{ externalId: "E1", name: "Насос", inventoryNumber: "INV-9", type: "Насос", areaExternalId: "A1" }]);
    await imp("EMPLOYEE", [
      { externalId: "U1", login: "m1c", fullName: "Мастер 1С", role: "MASTER" },
      { externalId: "U2", login: "w1c", fullName: "Слесарь 1С", role: "EXECUTOR", brigadeExternalId: "B1", isOnShift: true }
    ]);
    await imp("NORMATIVE", [{ externalId: "N1", name: "Замена", equipmentExternalId: "E1", faultCodeExternalId: "F1", hours: 3 }]);
    const res = await imp("WORK_ORDER", [{ externalId: "WO1", number: "1C-0001", description: "Из 1С", deadline: "2030-01-01T00:00:00Z", areaExternalId: "A1", equipmentExternalId: "E1", creatorExternalId: "U1", assigneeExternalId: "U2" }]);
    expect(res.status).toBe(200);
    const order = await prisma.workOrder.findUniqueOrThrow({ where: { number: "1C-0001" }, include: { assignee: true } });
    expect(order.assignee.login).toBe("w1c");
    expect(await prisma.integrationMapping.count()).toBe(9);
    // обновление по тому же externalId меняет запись, а не создаёт новую
    await imp("AREA", [{ externalId: "A1", name: "Дробление-2" }]);
    expect((await prisma.area.findMany()).map((x) => x.name)).toEqual(["Дробление-2"]);
  });

  it("повтор requestId возвращает сохранённый ответ без повторного импорта", async () => {
    const a = await imp("AREA", [{ externalId: "A1", name: "X1" }], "same-request-1");
    await prisma.area.update({ where: { id: a.body.items[0].localId }, data: { name: "Изменено локально" } });
    const b = await imp("AREA", [{ externalId: "A1", name: "X1" }], "same-request-1");
    expect(b.body).toEqual(a.body);
    expect((await prisma.area.findFirstOrThrow()).name).toBe("Изменено локально");
  });

  it("ошибка элемента помечает задание FAILED", async () => {
    const res = await imp("EQUIPMENT", [{ externalId: "E9", name: "Без участка", inventoryNumber: "I", type: "T", areaExternalId: "NOPE" }], "fail-request-1");
    expect(res.status).toBe(500);
    expect(await prisma.integrationJob.findUnique({ where: { idempotencyKey: "1c:in:fail-request-1" } })).toMatchObject({ status: "FAILED", lastError: "Не найден участок 1С NOPE" });
  });

  it("валидация пакета", async () => {
    expect((await imp("AREA", [])).status).toBe(400);
    expect((await imp("UNKNOWN", [{ externalId: "x" }])).status).toBe(400);
  });
});

describe("1С: исходящая очередь", () => {
  let base: Base;
  beforeEach(async () => { base = await seedBase(); });

  it("успешная отправка: заголовки, идемпотентный ключ, сохранение externalId", async () => {
    const order = await insertOrder(base);
    const job = await enqueueWorkOrderSync(order.id, "CREATED");
    expect(await processOneCJobs()).toMatchObject({ processed: 1, succeeded: 1 });
    const call = mocks.oneC.calls[0];
    expect(call.path).toBe("/hs/naryad-ai/events");
    expect(call.headers["x-1c-api-key"]).toBe("test-1c-key-123456");
    expect(call.headers["x-idempotency-key"]).toBe(job.idempotencyKey);
    expect(call.body).toMatchObject({ eventType: "CREATED", entity: "WORK_ORDER", data: { number: order.number, equipment: { name: "Насос Н-1" } } });
    expect(await prisma.integrationMapping.findFirst({ where: { entity: "WORK_ORDER", localId: order.id } })).toMatchObject({ externalId: "1C-ORDER-1" });
  });

  it("ошибка 1С → FAILED с экспоненциальной задержкой, после MAX попыток → DEAD", async () => {
    mocks.oneC.handler = () => ({ status: 500, text: "1C down" });
    const order = await insertOrder(base);
    const job = await enqueueWorkOrderSync(order.id, "CREATED");
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await prisma.integrationJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
      const t = Date.now();
      await processOneCJobs();
      const row = await prisma.integrationJob.findUniqueOrThrow({ where: { id: job.id } });
      delays.push(Math.round((row.nextAttemptAt.getTime() - t) / 60_000));
      expect(row.status).toBe(attempt < 3 ? "FAILED" : "DEAD");
      expect(row.lastError).toContain("1С HTTP 500");
    }
    expect(delays).toEqual([2, 4, 8]);
    await prisma.integrationJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
    expect((await processOneCJobs()).processed).toBe(0);
  });

  it("ручной retry и push пакета нарядов через API", async () => {
    const order = await insertOrder(base);
    const pushed = await request(app).post("/api/integrations/1c/push/orders").set(bearer(base.admin)).send({ ids: [order.id] });
    expect(pushed.status).toBe(202);
    expect(pushed.body.queued).toBe(1);
    const again = await request(app).post("/api/integrations/1c/push/orders").set(bearer(base.admin)).send({ ids: [order.id] });
    expect(again.body.jobIds).toEqual(pushed.body.jobIds); // тот же updatedAt → тот же ключ
    await prisma.integrationJob.update({ where: { id: pushed.body.jobIds[0] }, data: { status: "DEAD", attempts: 3 } });
    const retry = await request(app).post(`/api/integrations/1c/jobs/${pushed.body.jobIds[0]}/retry`).set(bearer(base.admin));
    expect(retry.body).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await request(app).post("/api/integrations/1c/run").set(bearer(base.admin))).body).toMatchObject({ succeeded: 1 });
    expect((await request(app).get("/api/integrations/1c/jobs?status=SUCCESS").set(bearer(base.admin))).body).toHaveLength(1);
    expect((await request(app).get("/api/integrations/1c/mappings?entity=WORK_ORDER").set(bearer(base.admin))).body).toHaveLength(1);
    expect((await request(app).get("/api/integrations/orders").set(bearer(base.manager))).body).toHaveLength(1);
    expect((await request(app).post("/api/integrations/1c/jobs/999999/retry").set(bearer(base.admin))).status).toBe(404);
  });
});
