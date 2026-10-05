import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { insertOrder, seedBase, type Base } from "../helpers/db.js";
import { saveUpload, scene } from "../helpers/images.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

// Отдельный файл: config читается один раз при импорте, здесь включаем vision-модель.
process.env.OLLAMA_VISION_MODEL = "vision-test";
const { analyzeOrderPhotos } = await import("../../src/services/photo-analysis.js");

let base: Base;
beforeEach(async () => { base = await seedBase(); });

async function orderWithPhotos(seed: number) {
  const order = await insertOrder(base, { status: "COMPLETED" });
  for (const [type, s] of [["BEFORE", seed], ["AFTER", seed + 1]] as const) {
    await prisma.photo.create({ data: { workOrderId: order.id, authorId: base.worker1.id, type, fileUrl: await saveUpload(`v${s}.jpg`, await scene(s)) } });
  }
  return order;
}

describe("vision-модель", () => {
  it("отправляет оба фото в base64 и возвращает оценку модели", async () => {
    mocks.ollama.handler = () => ollamaReply({ score: 5, confidence: 0.9, comment: "Узел заменён", sameEquipment: true, problemFixed: true, safetyIssues: [] });
    const r = await analyzeOrderPhotos((await orderWithPhotos(100)).id);
    expect(r).toMatchObject({ score: 5, confidence: 0.9, duplicate: false });
    const body = mocks.ollama.calls[0].body;
    expect(body.model).toBe("vision-test");
    expect(body.messages[0].images).toHaveLength(2);
  });

  it("другое оборудование → score 1", async () => {
    mocks.ollama.handler = () => ollamaReply({ score: 4, confidence: 0.8, comment: "ok", sameEquipment: false });
    const r = await analyzeOrderPhotos((await orderWithPhotos(110)).id);
    expect(r.score).toBe(1);
    expect(r.comment).toContain("другое оборудование");
  });

  it("замечания безопасности ограничивают score ≤ 2", async () => {
    mocks.ollama.handler = () => ollamaReply({ score: 5, confidence: 0.8, comment: "ok", sameEquipment: true, safetyIssues: ["снят защитный кожух"] });
    const r = await analyzeOrderPhotos((await orderWithPhotos(120)).id);
    expect(r.score).toBe(2);
    expect(r.comment).toContain("снят защитный кожух");
  });

  it("сбой vision-модели → эвристика score 4", async () => {
    mocks.ollama.handler = () => ({ json: { message: { content: "{broken" } } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await analyzeOrderPhotos((await orderWithPhotos(130)).id);
    spy.mockRestore();
    expect(r).toMatchObject({ score: 4, confidence: 0.55 });
  });
});
