import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { prisma } from "../../src/lib/prisma.js";
import { PRECEDENTS_PROMPT, REVIEW_PROMPT, reviewWorkOrder } from "../../src/services/ai-review.js";
import { learnFromMasterDecision, recall } from "../../src/services/rag.js";
import { bearer, insertOrder, seedBase, type Base } from "../helpers/db.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

let base: Base;
beforeEach(async () => {
  base = await seedBase();
  config.OLLAMA_EMBED_MODEL = "test-embed";
  config.RAG_MIN_SIMILARITY = 0.6;
});
afterEach(() => { config.OLLAMA_EMBED_MODEL = ""; });

/** Bag of word stems hashed into 64 dims: texts sharing words are close, like a real embedding model. */
function fakeEmbedding(text: string) {
  const vector = new Array(64).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\d]+/gu) ?? []) {
    let h = 0;
    for (const ch of word.slice(0, 5)) h = (h * 31 + ch.charCodeAt(0)) % 64;
    vector[h] += 1;
  }
  return vector;
}

const accepted = { verdict: "ACCEPTED", score: 5, explanation: "Работа выполнена", strengths: [], improvements: [] };
const rework = { verdict: "REWORK_REQUIRED", score: 2, explanation: "Нет замера вибрации", strengths: [], improvements: [] };

function ollama(chat: unknown = accepted, embed: "ok" | "down" = "ok") {
  mocks.ollama.handler = (body, req) => {
    if (req.url === "/api/embed") return embed === "ok" ? { json: { embeddings: body.input.map(fakeEmbedding) } } : { status: 500, text: "down" };
    return ollamaReply(chat);
  };
}
const chatCalls = () => mocks.ollama.calls.filter((x) => x.path === "/api/chat");
const embedCalls = () => mocks.ollama.calls.filter((x) => x.path === "/api/embed");

const BEARING = "Шум подшипника насоса";
const NO_VIBRATION = "Заменил подшипник 6205 насоса, шум пропал";

/** An order in AI_REVIEW with an AI assessment, as left by reviewWorkOrder. */
async function inReview(completionText = NO_VIBRATION, description = BEARING, verdict: "ACCEPTED" | "REWORK_REQUIRED" = "ACCEPTED") {
  const order = await insertOrder(base, { status: "AI_REVIEW", description, completionText, faultCodeId: base.fault.id, normativeId: base.normative.id, startedAt: new Date(Date.now() - 3 * 3_600_000), completedAt: new Date(Date.now() - 3_600_000) });
  await prisma.aiAssessment.create({ data: { workOrderId: order.id, verdict, score: verdict === "ACCEPTED" ? 5 : 2, explanation: "AI", rawResponse: {} } });
  return order;
}

const act = (id: number, body: Record<string, unknown>) => request(app).post(`/api/work-orders/${id}/action`).set(bearer(base.master)).send(body);
const waitForCases = (count: number) => vi.waitFor(async () => expect(await prisma.knowledgeCase.count()).toBe(count), { timeout: 5000 });

async function completed(completionText: string, description = BEARING) {
  return insertOrder(base, { status: "COMPLETED", description, completionText, faultCodeId: base.fault.id, startedAt: new Date(Date.now() - 2 * 3_600_000), completedAt: new Date() });
}

describe("RAG-память: обучение на решениях мастера", () => {
  it("возврат на доработку сохраняет отчёт с причиной мастера и вердиктом ИИ", async () => {
    ollama();
    const order = await inReview();
    expect((await act(order.id, { action: "SEND_TO_REWORK", comment: "Нет замера вибрации после замены подшипника" })).status).toBe(200);
    await waitForCases(1);
    const memory = await prisma.knowledgeCase.findFirstOrThrow();
    expect(memory).toMatchObject({ kind: "REVIEW", workOrderId: order.id, accepted: false, aiVerdict: "ACCEPTED", masterComment: "Нет замера вибрации после замены подшипника", problem: BEARING, report: NO_VIBRATION, equipmentType: "Насос", model: "test-embed" });
    expect(memory.embedding.byteLength).toBe(64 * 4);
    expect(embedCalls()[0].body.input[0]).toBe(`Оборудование: Насос\nПроблема: ${BEARING}\nОтчёт: ${NO_VIBRATION}`);
  });

  it("закрытие сохраняет отчёт (принят, оценка мастера) и шифр с фактическими часами", async () => {
    ollama();
    const order = await inReview("Заменил подшипник, вибрация 2 мм/с");
    expect((await act(order.id, { action: "CLOSE", masterScore: 4, comment: "Хорошо" })).status).toBe(200);
    await waitForCases(2);
    expect(await prisma.knowledgeCase.findFirstOrThrow({ where: { kind: "REVIEW" } })).toMatchObject({ accepted: true, masterScore: 4, masterComment: "Хорошо", aiVerdict: "ACCEPTED" });
    expect(await prisma.knowledgeCase.findFirstOrThrow({ where: { kind: "FAULT" } })).toMatchObject({ faultCodeId: base.fault.id, normativeId: base.normative.id, actualHours: 2, report: null });
  });

  it("повторное решение по тому же тексту обновляет запись, новый текст после доработки — новая запись", async () => {
    ollama();
    const order = await inReview();
    await prisma.workOrder.update({ where: { id: order.id }, data: { status: "REWORK" } });
    await learnFromMasterDecision(order.id);
    await learnFromMasterDecision(order.id);
    expect(await prisma.knowledgeCase.count()).toBe(1);
    await prisma.workOrder.update({ where: { id: order.id }, data: { status: "CLOSED", completionText: "Заменил подшипник, вибрация 2 мм/с" } });
    await learnFromMasterDecision(order.id);
    expect(await prisma.knowledgeCase.count({ where: { kind: "REVIEW" } })).toBe(2);
  });

  it("оценка мастера без AI-проверки не считается мнением ИИ", async () => {
    ollama();
    const order = await insertOrder(base, { status: "CLOSED", description: BEARING, completionText: NO_VIBRATION });
    await prisma.aiAssessment.create({ data: { workOrderId: order.id, verdict: "ACCEPTED", score: 4, masterScore: 4, explanation: "Оценка мастера без AI-проверки" } });
    await learnFromMasterDecision(order.id);
    expect((await prisma.knowledgeCase.findFirstOrThrow()).aiVerdict).toBeNull();
  });

  it("незакрытый наряд и наряд без отчёта ничего не добавляют", async () => {
    ollama();
    expect(await learnFromMasterDecision((await insertOrder(base, { status: "IN_PROGRESS", completionText: "x" })).id)).toBe(0);
    expect(await learnFromMasterDecision((await insertOrder(base, { status: "REWORK", completionText: " " })).id)).toBe(0);
    expect(embedCalls()).toHaveLength(0);
  });

  it("без модели эмбеддингов память выключена: ни одного запроса к /api/embed", async () => {
    config.OLLAMA_EMBED_MODEL = "";
    ollama();
    const order = await inReview();
    await act(order.id, { action: "SEND_TO_REWORK", comment: "Нет замера" });
    await reviewWorkOrder((await completed(NO_VIBRATION)).id);
    expect(embedCalls()).toHaveLength(0);
    expect(await prisma.knowledgeCase.count()).toBe(0);
    expect(chatCalls()[0].body.messages[0].content).toBe(REVIEW_PROMPT);
  });
});

describe("RAG-память: прецеденты в AI-проверке", () => {
  async function teachRework() {
    const order = await inReview();
    await prisma.workOrder.update({ where: { id: order.id }, data: { status: "REWORK" } });
    await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: base.master.id, action: "SEND_TO_REWORK", fromStatus: "AI_REVIEW", toStatus: "REWORK", comment: "Нет замера вибрации" } });
    await learnFromMasterDecision(order.id);
    return order;
  }

  it("похожий отчёт получает решение мастера как прецедент, промпт дополняется правилом", async () => {
    ollama(rework);
    await teachRework();
    const order = await completed("Заменил подшипник насоса 6205, шум пропал");
    const a = await reviewWorkOrder(order.id);
    const [call] = chatCalls();
    expect(call.body.messages[0].content).toBe(REVIEW_PROMPT + PRECEDENTS_PROMPT);
    const prompt = JSON.parse(call.body.messages[1].content);
    expect(prompt.precedents).toEqual([expect.objectContaining({ problem: BEARING, report: NO_VIBRATION, masterDecision: "ВОЗВРАЩЕНО НА ДОРАБОТКУ", masterComment: "Нет замера вибрации" })]);
    expect(prompt.precedents[0].similarity).toBeGreaterThan(0.9);
    expect(a).toMatchObject({ verdict: "REWORK_REQUIRED", ragPrecedents: 1, needsMasterReview: false });
    expect((a.rawResponse as any).rag).toEqual([expect.objectContaining({ accepted: false })]);
  });

  it("непохожий отчёт идёт с базовым промптом, без прецедентов", async () => {
    ollama();
    await teachRework();
    const a = await reviewWorkOrder((await completed("Вулканизировал стык ленты конвейера", "Порыв ленты конвейера")).id);
    expect(chatCalls()[0].body.messages[0].content).toBe(REVIEW_PROMPT);
    expect(JSON.parse(chatCalls()[0].body.messages[1].content).precedents).toBeUndefined();
    expect(a.ragPrecedents).toBe(0);
  });

  it("ИИ против почти такого же решения мастера — наряд помечается для мастера", async () => {
    ollama(accepted);
    await teachRework();
    const a = await reviewWorkOrder((await completed(NO_VIBRATION)).id);
    expect(a.verdict).toBe("ACCEPTED");
    expect(a.needsMasterReview).toBe(true);
    expect(a.explanation).toMatch(/^Нужна проверка мастером\./);
    expect(a.explanation).toContain("Почти такой же отчёт мастер ранее вернул на доработку: «Нет замера вибрации»");
  });

  it("собственный наряд не служит себе прецедентом (повторная проверка после доработки)", async () => {
    ollama(rework);
    const order = await teachRework();
    await prisma.workOrder.update({ where: { id: order.id }, data: { status: "COMPLETED" } });
    const a = await reviewWorkOrder(order.id);
    expect(a.ragPrecedents).toBe(0);
  });

  it("сбой эмбеддингов не ломает проверку", async () => {
    ollama(accepted);
    await teachRework();
    ollama(accepted, "down");
    const a = await reviewWorkOrder((await completed(NO_VIBRATION)).id);
    expect(a).toMatchObject({ verdict: "ACCEPTED", ragPrecedents: 0 });
  });

  it("порог сходства и top-k из настроек", async () => {
    ollama();
    for (let i = 0; i < 6; i++) {
      const o = await insertOrder(base, { status: "REWORK", description: BEARING, completionText: `${NO_VIBRATION} ${i}` });
      await learnFromMasterDecision(o.id);
    }
    expect(await recall("REVIEW", `Оборудование: Насос\nПроблема: ${BEARING}\nОтчёт: ${NO_VIBRATION}`)).toHaveLength(4);
    config.RAG_MIN_SIMILARITY = 0;
    expect(await recall("REVIEW", BEARING, { k: 10 })).toHaveLength(6);
    config.RAG_MIN_SIMILARITY = 0.99;
    expect(await recall("REVIEW", "совсем другой текст")).toHaveLength(0);
  });

  it("новое решение мастера сразу видно следующему поиску (кеш обновляется)", async () => {
    ollama();
    const query = `Оборудование: Насос\nПроблема: ${BEARING}\nОтчёт: ${NO_VIBRATION}`;
    expect(await recall("REVIEW", query)).toHaveLength(0);
    await teachRework();
    expect(await recall("REVIEW", query)).toHaveLength(1);
    await prisma.knowledgeCase.deleteMany();
    expect(await recall("REVIEW", query)).toHaveLength(0);
  });
});

describe("RAG-память: подбор шифра по похожим нарядам", () => {
  async function teachFault(description: string, faultCodeId: number) {
    const o = await insertOrder(base, { status: "CLOSED", description, completionText: "Сделано по технологии", faultCodeId, startedAt: new Date(Date.now() - 3_600_000), completedAt: new Date() });
    await learnFromMasterDecision(o.id);
  }

  it("LLM получает похожие закрытые наряды с их шифрами", async () => {
    ollama({ faultCodeId: base.fault2.id, normativeId: null, estimatedHours: 1, explanation: "Как в похожих нарядах" });
    await teachFault("Нет питания на двигателе насоса", base.fault2.id);
    const res = await request(app).post("/api/recommendations/work").set(bearer(base.master)).send({ description: "Нет питания на двигателе насоса после грозы", equipmentId: base.pump.id });
    expect(res.body).toMatchObject({ faultCodeId: base.fault2.id, basedOn: 1 });
    const call = chatCalls().at(-1)!;
    expect(call.body.messages[0].content).toContain("similarOrders");
    expect(JSON.parse(call.body.messages[1].content).similarOrders).toEqual([expect.objectContaining({ faultCodeId: base.fault2.id, problem: "Нет питания на двигателе насоса" })]);
  });

  it("без LLM шифр выбирается голосованием похожих нарядов, а не первым из справочника", async () => {
    ollama();
    await teachFault("Нет питания на двигателе насоса", base.fault2.id);
    await teachFault("Нет питания на двигателе насоса, выбило автомат", base.fault2.id);
    mocks.ollama.handler = (body, req) => req.url === "/api/embed" ? { json: { embeddings: body.input.map(fakeEmbedding) } } : { status: 500, text: "down" };
    const res = await request(app).post("/api/recommendations/work").set(bearer(base.master)).send({ description: "Нет питания на двигателе насоса", equipmentId: base.pump.id });
    expect(res.body).toMatchObject({ faultCodeId: base.fault2.id, basedOn: 2, explanation: "По похожим закрытым нарядам предприятия" });
  });

  it("удалённый из справочника шифр не предлагается", async () => {
    ollama();
    const old = await prisma.faultCode.create({ data: { code: "Х-99", name: "Старый", category: "М" } });
    await teachFault("Нет питания на двигателе насоса", old.id);
    await prisma.workOrder.updateMany({ where: { faultCodeId: old.id }, data: { faultCodeId: null } });
    await prisma.faultCode.delete({ where: { id: old.id } });
    mocks.ollama.handler = (body, req) => req.url === "/api/embed" ? { json: { embeddings: body.input.map(fakeEmbedding) } } : { status: 500, text: "down" };
    const res = await request(app).post("/api/recommendations/work").set(bearer(base.master)).send({ description: "Нет питания на двигателе насоса", equipmentId: base.pump.id });
    expect(res.body).toMatchObject({ faultCodeId: base.fault.id, basedOn: 0 });
  });
});

describe("RAG-память: API", () => {
  it("статистика: согласие ИИ с мастером по месяцам и доля проверок с прецедентами", async () => {
    ollama();
    const agreed = await inReview("Заменил подшипник, вибрация 2 мм/с", BEARING, "ACCEPTED");
    await act(agreed.id, { action: "CLOSE", masterScore: 5 });
    const overridden = await inReview(NO_VIBRATION, BEARING, "ACCEPTED");
    await act(overridden.id, { action: "SEND_TO_REWORK", comment: "Нет замера" });
    await waitForCases(3);
    await reviewWorkOrder((await completed(NO_VIBRATION)).id);
    const res = await request(app).get("/api/ai/knowledge/stats").set(bearer(base.manager));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, model: "test-embed", cases: { review: 2, fault: 1 }, masterAgreementPct: 50, masterOverrides: 1 });
    expect(res.body.byMonth).toEqual([{ month: new Date().toISOString().slice(0, 7), decisions: 2, agreementPct: 50 }]);
    // 3 AI reviews in 30 days (2 fixtures + 1 real), the real one used precedents.
    expect(res.body).toMatchObject({ reviewsLast30Days: 3, reviewsWithPrecedentsPct: 33.3 });
    expect((await request(app).get("/api/ai/knowledge/stats").set(bearer(base.worker1))).status).toBe(403);
  });

  it("переиндексация из истории — только админ; записи старой модели удаляются", async () => {
    ollama();
    await insertOrder(base, { status: "CLOSED", description: BEARING, completionText: "Заменил подшипник", faultCodeId: base.fault.id });
    await insertOrder(base, { status: "REWORK", description: BEARING, completionText: NO_VIBRATION });
    await insertOrder(base, { status: "IN_PROGRESS", description: BEARING, completionText: "x" });
    expect((await request(app).post("/api/ai/knowledge/reindex").set(bearer(base.master))).status).toBe(403);
    config.OLLAMA_EMBED_MODEL = "old-embed";
    await request(app).post("/api/ai/knowledge/reindex").set(bearer(base.admin));
    config.OLLAMA_EMBED_MODEL = "test-embed";
    const res = await request(app).post("/api/ai/knowledge/reindex").set(bearer(base.admin));
    expect(res.body).toEqual({ orders: 2, cases: 3 });
    expect(await prisma.knowledgeCase.groupBy({ by: ["model"], _count: { _all: true } })).toEqual([{ model: "test-embed", _count: { _all: 3 } }]);
  });
});
