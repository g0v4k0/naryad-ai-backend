import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { findSafetyViolation, REVIEW_PROMPT, reviewWorkOrder } from "../../src/services/ai-review.js";
import { analyzeOrderPhotos } from "../../src/services/photo-analysis.js";
import { insertOrder, seedBase, type Base } from "../helpers/db.js";
import { saveUpload, scene } from "../helpers/images.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

let base: Base;
beforeEach(async () => { base = await seedBase(); });

const good = { verdict: "ACCEPTED", score: 5, explanation: "Работа выполнена качественно", strengths: ["Полное описание"], improvements: [] };

async function completedOrder(data: Record<string, unknown> = {}, photos: Array<{ type: "BEFORE" | "AFTER"; url: string }> = []) {
  const now = Date.now();
  const order = await insertOrder(base, {
    status: "COMPLETED", completionText: "Заменён подшипник 6205, вибрация в норме", faultCodeId: base.fault.id,
    normativeId: base.normative.id, startedAt: new Date(now - 2 * 3_600_000), completedAt: new Date(now), ...data
  });
  for (const p of photos) await prisma.photo.create({ data: { workOrderId: order.id, authorId: base.worker1.id, type: p.type, fileUrl: p.url } });
  return order;
}

describe("AI-проверка закрытия", () => {
  it("передаёт в LLM факты наряда и сохраняет оценку, наряд → AI_REVIEW", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const before = await saveUpload("b1.jpg", await scene(1));
    const after = await saveUpload("a1.jpg", await scene(2));
    const order = await completedOrder({}, [{ type: "BEFORE", url: before }, { type: "AFTER", url: after }]);
    await prisma.materialUsage.create({ data: { workOrderId: order.id, materialId: base.bearing.id, quantity: 2 } });
    const assessment = await reviewWorkOrder(order.id);
    expect(assessment).toMatchObject({ verdict: "ACCEPTED", score: 5, photoScore: 4 });
    const prompt = JSON.parse(mocks.ollama.calls[0].body.messages[1].content);
    expect(prompt).toMatchObject({ faultCode: "М-01", hasAfterPhoto: true, normativeHours: 2, missing: [], materialWarnings: [] });
    expect(prompt.actualHours).toBeCloseTo(2, 1);
    expect((await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("AI_REVIEW");
    expect(await prisma.workOrderEvent.count({ where: { workOrderId: order.id, action: "AI_REVIEW" } })).toBe(1);
  });

  it("незаполненные поля принудительно дают REWORK_REQUIRED и score ≤ 2, даже если LLM доволен", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const order = await completedOrder({ completionText: " ", faultCodeId: null, type: "EMERGENCY" });
    const a = await reviewWorkOrder(order.id);
    expect(a.verdict).toBe("REWORK_REQUIRED");
    expect(a.score).toBeLessThanOrEqual(2);
    expect(a.explanation).toContain("описание выполненных работ");
    expect(a.explanation).toContain("шифр неисправности");
    expect(a.explanation).toContain("фото после");
  });

  it("перерасход материала > 150% нормы понижает ACCEPTED до ACCEPTED_WITH_COMMENTS", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const before = await saveUpload("b2.jpg", await scene(3));
    const after = await saveUpload("a2.jpg", await scene(4));
    const order = await completedOrder({}, [{ type: "BEFORE", url: before }, { type: "AFTER", url: after }]);
    await prisma.materialUsage.create({ data: { workOrderId: order.id, materialId: base.bearing.id, quantity: 4 } });
    const a = await reviewWorkOrder(order.id);
    expect(a.verdict).toBe("ACCEPTED_WITH_COMMENTS");
    expect(a.explanation).toContain("Подшипник 6205: расход выше нормы");
  });

  it("Ollama недоступна, AI_STRICT=false → детерминированный fallback", async () => {
    mocks.ollama.handler = () => ({ status: 503, text: "down" });
    const before = await saveUpload("b3.jpg", await scene(5));
    const after = await saveUpload("a3.jpg", await scene(6));
    const order = await completedOrder({}, [{ type: "BEFORE", url: before }, { type: "AFTER", url: after }]);
    const a = await reviewWorkOrder(order.id);
    expect(a).toMatchObject({ verdict: "ACCEPTED_WITH_COMMENTS", score: 4 });
    expect(a.explanation).toContain("Ollama временно недоступна");
  });

  it("score от LLM вне диапазона нормализуется в 1..5", async () => {
    mocks.ollama.handler = () => ollamaReply({ ...good, score: 9.7 });
    const before = await saveUpload("b4.jpg", await scene(7));
    const after = await saveUpload("a4.jpg", await scene(8));
    const order = await completedOrder({}, [{ type: "BEFORE", url: before }, { type: "AFTER", url: after }]);
    expect((await reviewWorkOrder(order.id)).score).toBe(5);
  });

  it("BUG-8: лишние ключи и неверные типы в ответе LLM не ломают сохранение", async () => {
    mocks.ollama.handler = () => ollamaReply({ verdict: "ACCEPTED", score: "4", explanation: "ok", strengths: "Описание полное", improvements: null, comment: "лишнее поле", confidence: 0.9 });
    const a = await reviewWorkOrder((await completedOrder()).id);
    expect(a).toMatchObject({ verdict: "ACCEPTED", score: 4, strengths: ["Описание полное"], improvements: [] });
  });

  it("BUG-8: неизвестный вердикт LLM → ACCEPTED_WITH_COMMENTS (решает мастер)", async () => {
    mocks.ollama.handler = () => ollamaReply({ verdict: "MAYBE", score: null });
    const a = await reviewWorkOrder((await completedOrder()).id);
    expect(a).toMatchObject({ verdict: "ACCEPTED_WITH_COMMENTS", score: 3 });
  });

  it("BUG-5: плановый наряд без фото не уходит в доработку автоматически", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const order = await completedOrder({ type: "PLANNED" });
    expect((await reviewWorkOrder(order.id)).verdict).toBe("ACCEPTED");
  });

  it("аварийный наряд без фото после — по-прежнему доработка", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const order = await completedOrder({ type: "EMERGENCY" });
    const a = await reviewWorkOrder(order.id);
    expect(a.verdict).toBe("REWORK_REQUIRED");
    expect(a.explanation).toContain("фото после");
  });

  it("в LLM уходит промпт с критериями доработки и требованием русского языка", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    await reviewWorkOrder((await completedOrder()).id);
    const system = mocks.ollama.calls[0].body.messages[0].content;
    expect(system).toBe(REVIEW_PROMPT);
    expect(system).toContain("Отвечай только на русском");
    expect(system).toContain("«сделано»");
  });

  it.each([
    "Отключил защиту, двигатель теперь работает",
    "Поставил перемычку на концевик, конвейер работает",
    "Работали без наряда-допуска, всё заменили",
    "Замкнул концевик накоротко, лента работает"
  ])("нарушение безопасности «%s» → доработка, балл 1, даже если LLM принял", async (text) => {
    mocks.ollama.handler = () => ollamaReply(good);
    const a = await reviewWorkOrder((await completedOrder({ completionText: text })).id);
    expect(a).toMatchObject({ verdict: "REWORK_REQUIRED", score: 1 });
    expect(a.explanation).toContain("Нарушение безопасности");
  });

  it.each([
    "Отключил питание, заменил автомат 16А, включил",
    "Снят защитный кожух, заменён ремень, кожух установлен",
    "Проверены токи, защита больше не срабатывает",
    "Замкнул контакты пускателя после зачистки, двигатель запущен"
  ])("нормальная процедура «%s» не считается нарушением", (text) => {
    expect(findSafetyViolation(text)).toBeNull();
  });
});

describe("анализ фото", () => {
  it("нет фото после → score 1", async () => {
    const order = await completedOrder();
    expect(await analyzeOrderPhotos(order.id)).toMatchObject({ score: 1, duplicate: false });
  });

  it("только фото после → score 3, низкая уверенность", async () => {
    const order = await completedOrder({}, [{ type: "AFTER", url: await saveUpload("only.jpg", await scene(10)) }]);
    expect(await analyzeOrderPhotos(order.id)).toMatchObject({ score: 3, confidence: 0.45 });
  });

  it("одинаковые фото до/после → дубликат", async () => {
    const img = await scene(11);
    const order = await completedOrder({}, [{ type: "BEFORE", url: await saveUpload("same1.jpg", img) }, { type: "AFTER", url: await saveUpload("same2.jpg", img) }]);
    expect(await analyzeOrderPhotos(order.id)).toMatchObject({ score: 1, duplicate: true });
  });

  it("пережатое то же фото (визуально идентичное) → дубликат по перцептивному хешу", async () => {
    const img = await scene(12);
    const recompressed = await sharp(img).resize(600).jpeg({ quality: 55 }).toBuffer();
    const order = await completedOrder({}, [{ type: "BEFORE", url: await saveUpload("p1.jpg", img) }, { type: "AFTER", url: await saveUpload("p2.jpg", recompressed) }]);
    const r = await analyzeOrderPhotos(order.id);
    expect(r.duplicate).toBe(true);
    expect("visualSimilarity" in r && r.visualSimilarity).toBeGreaterThan(0.98);
  });

  it("похожие (0.88–0.98) фото до/после → подозрение для мастера, без автоматической доработки", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const img = await scene(17);
    const brighter = await sharp(img).modulate({ brightness: 1.25 }).jpeg().toBuffer();
    const order = await completedOrder({}, [{ type: "BEFORE", url: await saveUpload("s1.jpg", img) }, { type: "AFTER", url: await saveUpload("s2.jpg", brighter) }]);
    const r = await analyzeOrderPhotos(order.id);
    expect(r).toMatchObject({ score: 3, duplicate: false, suspicious: true });
    expect(r.comment).toContain("очень похожи");
    expect((await reviewWorkOrder(order.id)).verdict).not.toBe("REWORK_REQUIRED");
  });

  it("фото после похоже на фото из прошлого наряда по тому же оборудованию → подозрение", async () => {
    const old = await scene(18);
    const first = await completedOrder({}, [{ type: "AFTER", url: await saveUpload("o1.jpg", old) }]);
    await analyzeOrderPhotos(first.id);
    const cropped = await sharp(old).extract({ left: 16, top: 12, width: 608, height: 456 }).jpeg({ quality: 60 }).toBuffer();
    const second = await completedOrder({}, [{ type: "BEFORE", url: await saveUpload("o0.jpg", await scene(19)) }, { type: "AFTER", url: await saveUpload("o2.jpg", cropped) }]);
    const r = await analyzeOrderPhotos(second.id);
    expect(r).toMatchObject({ score: 3, suspicious: true });
    expect(r.comment).toContain(`наряда ${first.id}`);
  });

  it("фото после уже использовано в другом наряде → дубликат и REWORK", async () => {
    mocks.ollama.handler = () => ollamaReply(good);
    const reused = await scene(13);
    const first = await completedOrder({}, [{ type: "AFTER", url: await saveUpload("r1.jpg", reused) }]);
    await analyzeOrderPhotos(first.id);
    const second = await completedOrder({}, [{ type: "BEFORE", url: await saveUpload("r0.jpg", await scene(14)) }, { type: "AFTER", url: await saveUpload("r2.jpg", reused) }]);
    const r = await analyzeOrderPhotos(second.id);
    expect(r).toMatchObject({ duplicate: true, score: 1 });
    expect(r.comment).toContain(`наряде ${first.id}`);
    expect((await reviewWorkOrder(second.id)).verdict).toBe("REWORK_REQUIRED");
  });

  it("разные фото без vision-модели → score 4, требуется мастер; хеш и метаданные сохранены", async () => {
    const order = await completedOrder({}, [{ type: "BEFORE", url: await saveUpload("d1.jpg", await scene(15)) }, { type: "AFTER", url: await saveUpload("d2.jpg", await scene(16)) }]);
    const r = await analyzeOrderPhotos(order.id);
    expect(r).toMatchObject({ score: 4, confidence: 0.55, duplicate: false });
    const photo = await prisma.photo.findFirstOrThrow({ where: { workOrderId: order.id, type: "AFTER" } });
    expect(photo.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(photo.metadata).toMatchObject({ width: 640, height: 480, format: "jpeg" });
  });

  it("внешние URL (не /uploads) пропускаются", async () => {
    const order = await completedOrder({}, [{ type: "AFTER", url: "https://example.com/x.jpg" }]);
    expect((await analyzeOrderPhotos(order.id)).score).toBe(1);
  });
});
