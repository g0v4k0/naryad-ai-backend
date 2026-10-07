import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { bearer, insertOrder, seedBase, type Base } from "../helpers/db.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

let base: Base;
beforeEach(async () => { base = await seedBase(); });

/** Ollama mock that answers intent classification first, then the final answer. */
function scripted(intent: Record<string, unknown>, answer = "Готово") {
  mocks.ollama.handler = (body) => body.messages[0].content.startsWith("Определи намерение") ? ollamaReply(intent) : ollamaReply({ answer });
}

describe("AI-помощник мастера", () => {
  it("FREE_EXECUTORS с фильтром специальности", async () => {
    scripted({ intent: "FREE_EXECUTORS", specialty: "Электрик" }, "Свободен Электрик 2");
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Кто свободен из электриков?" });
    expect(res.body.data).toEqual([expect.objectContaining({ fullName: "Электрик 2" })]);
    expect(res.body.answer).toBe("Свободен Электрик 2");
    const finalPrompt = JSON.parse(mocks.ollama.calls[1].body.messages[1].content);
    expect(finalPrompt.FACTS.свободны).toEqual(["Электрик 2 (электрик, 4 разряд)"]); // ответ строится только на FACTS, без id
    expect(JSON.stringify(finalPrompt)).not.toMatch(/"id"/);
  });

  it("OVERDUE возвращает только незакрытые просроченные", async () => {
    scripted({ intent: "OVERDUE" });
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - 60_000) });
    await insertOrder(base, { status: "CLOSED", deadline: new Date(Date.now() - 60_000) });
    await insertOrder(base, { status: "IN_PROGRESS" });
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Что просрочено?" });
    expect(res.body.data).toHaveLength(1);
  });

  it("EQUIPMENT_HISTORY ищет оборудование по названию", async () => {
    scripted({ intent: "EQUIPMENT_HISTORY", equipmentQuery: "К-3" });
    await insertOrder(base, { equipmentId: base.conveyor.id });
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "История конвейера К-3" });
    expect(res.body.data).toHaveLength(1);
  });

  it.each([["SHIFT_REPORT"], ["ANOMALIES"], ["FAILURE_FORECAST"]])("%s отвечает 200", async (intent) => {
    scripted({ intent });
    expect((await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Сводка" })).status).toBe(200);
  });

  it.each([
    ["Кто свободен из электриков?", "FREE_EXECUTORS"], ["Что просрочено?", "OVERDUE"],
    ["Дай прогноз отказов", "FAILURE_FORECAST"], ["Покажи аномалии", "ANOMALIES"], ["Как прошла смена", "SHIFT_REPORT"],
    ["Что горит по времени?", "OVERDUE"], ["История ремонтов К-3", "EQUIPMENT_HISTORY"], ["Какое оборудование в зоне риска?", "FAILURE_FORECAST"],
    ["Где повторяются одни и те же поломки?", "ANOMALIES"], ["Мерзімі өтіп кеткен наряд қайсы?", "OVERDUE"]
  ])("без Ollama: «%s» → %s по ключевым словам", async (message, intent) => {
    mocks.ollama.handler = () => ({ status: 503 });
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message });
    expect(res.body.intent.intent).toBe(intent);
    // Without the model the answer is the exact template, never raw JSON.
    expect(res.body.fromModel).toBe(false);
    expect(res.body.answer).not.toMatch(/[{}\[\]]|Результат запроса/);
    expect(res.body.answer.length).toBeGreaterThan(10);
  });

  it("классификатор получает промпт с примерами по каждому намерению", async () => {
    scripted({ intent: "OVERDUE" });
    await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Что просрочено?" });
    const system = mocks.ollama.calls[0].body.messages[0].content;
    for (const intent of ["FREE_EXECUTORS", "OVERDUE", "EQUIPMENT_HISTORY", "SHIFT_REPORT", "ANOMALIES", "FAILURE_FORECAST"]) expect(system).toContain(`- ${intent} —`);
  });

  it("BUG-9: ответ модели массивом вместо строки не ломает помощника", async () => {
    mocks.ollama.handler = (body) => body.messages[0].content.startsWith("Определи намерение")
      ? ollamaReply({ intent: "FREE_EXECUTORS", specialty: "Электрик" })
      : ollamaReply({ answer: [{ id: base.worker2.id, fullName: "Электрик 2" }] });
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Кто свободен из электриков?" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Свободны на смене (1): Электрик 2 (электрик, 4 разряд).");
  });

  it("BUG-9: мусор в намерении (неизвестный intent, массив в specialty) → fallback по ключевым словам", async () => {
    mocks.ollama.handler = (body) => body.messages[0].content.startsWith("Определи намерение")
      ? ollamaReply({ intent: "DROP_TABLE", specialty: ["x"] })
      : ollamaReply({ answer: { text: "?" } });
    const res = await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Что просрочено?" });
    expect(res.status).toBe(200);
    expect(res.body.intent.intent).toBe("OVERDUE");
    expect(res.body.answer).toBe("Просроченных нарядов нет.");
  });

  it("история сохраняется по пользователю", async () => {
    scripted({ intent: "OVERDUE" }, "Нет просрочек");
    await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "Что просрочено?" });
    const res = await request(app).get("/api/assistant/history").set(bearer(base.master));
    expect(res.body.map((x: any) => x.role).sort()).toEqual(["assistant", "user"]);
    expect((await request(app).get("/api/assistant/history").set(bearer(base.manager))).body).toHaveLength(0);
  });

  it("валидация длины сообщения", async () => {
    expect((await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "a" })).status).toBe(400);
    expect((await request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message: "a".repeat(1001) })).status).toBe(400);
  });
});

describe("рекомендации", () => {
  it("исполнители ранжируются: доступность 50, рейтинг×8, очередь −3", async () => {
    const done = await insertOrder(base, { status: "CLOSED", equipmentId: base.pump.id, assigneeId: base.worker2.id });
    await prisma.aiAssessment.create({ data: { workOrderId: done.id, verdict: "ACCEPTED", score: 3, masterScore: 5, explanation: "x" } });
    await insertOrder(base, { status: "IN_PROGRESS", assigneeId: base.worker1.id });
    await prisma.user.update({ where: { id: base.worker1.id }, data: { employeeStatus: "BUSY" } });
    const res = await request(app).get(`/api/recommendations/executors?equipmentId=${base.pump.id}`).set(bearer(base.master));
    expect(res.body.map((x: any) => x.fullName)).toEqual(["Электрик 2", "Слесарь 1"]); // worker3 не на смене
    expect(res.body[0]).toMatchObject({ score: 90, equipmentRating: 5, queue: 0 });
    expect(res.body[1]).toMatchObject({ score: 21, equipmentRating: 3, queue: 1 });
  });

  it("рекомендация шифра: несуществующие id от модели отбрасываются", async () => {
    mocks.ollama.handler = () => ollamaReply({ faultCodeId: 9999, normativeId: "abc", estimatedHours: -1, explanation: ["x"] });
    const res = await request(app).post("/api/recommendations/work").set(bearer(base.master)).send({ description: "Гул", equipmentId: base.pump.id });
    expect(res.body).toEqual({ faultCodeId: null, normativeId: null, estimatedHours: 2, explanation: "Рекомендация по справочнику" });
  });

  it("шифр и норматив: LLM-ответ и fallback по справочнику", async () => {
    mocks.ollama.handler = () => ollamaReply({ faultCodeId: base.fault.id, normativeId: base.normative.id, estimatedHours: 2, explanation: "Типовой износ" });
    const ok = await request(app).post("/api/recommendations/work").set(bearer(base.master)).send({ description: "Гул подшипника", equipmentId: base.pump.id });
    expect(ok.body).toMatchObject({ faultCodeId: base.fault.id, normativeId: base.normative.id });
    expect(JSON.parse(mocks.ollama.calls[0].body.messages[1].content).normatives).toHaveLength(1);
    mocks.ollama.handler = () => ({ status: 500 });
    const fb = await request(app).post("/api/recommendations/work").set(bearer(base.master)).send({ description: "Гул подшипника", equipmentId: base.pump.id });
    expect(fb.body).toMatchObject({ normativeId: base.normative.id, estimatedHours: 2, explanation: "Базовая рекомендация по справочнику" });
  });

  it("BUG-6: рекомендации без equipmentId → 400, с несуществующим → 404", async () => {
    expect((await request(app).get("/api/recommendations/executors").set(bearer(base.master))).status).toBe(400);
    expect((await request(app).get("/api/recommendations/executors?equipmentId=999999").set(bearer(base.master))).status).toBe(404);
  });
});
