import { AiVerdict, WorkOrderStatus } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { analyzeOrderPhotos } from "./photo-analysis.js";

type Review = {
  verdict: AiVerdict;
  score: number;
  explanation: string;
  strengths: string[];
  improvements: string[];
};

export async function reviewWorkOrder(workOrderId: number) {
  const order = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { equipment: true, faultCode: true, normative: { include: { materialNorms: true } }, materialUsages: { include: { material: true } }, photos: true }
  });

  const missing: string[] = [];
  if (!order.completionText?.trim()) missing.push("описание выполненных работ");
  if (!order.faultCodeId) missing.push("шифр неисправности");
  if (order.type === "EMERGENCY" && !order.photos.some((p) => p.type === "AFTER")) missing.push("фото после");
  const materialWarnings = order.materialUsages.flatMap((usage) => {
    const norm = order.normative?.materialNorms.find((x) => x.materialId === usage.materialId);
    return norm && Number(usage.quantity) > Number(norm.quantity) * 1.5 ? [`${usage.material.name}: расход выше нормы`] : [];
  });

  const photoReview = await analyzeOrderPhotos(workOrderId);
  let review: Review;
  try {
    review = await askOllama<Review>(
      "Ты контролёр промышленных ремонтных нарядов. Верни только JSON: verdict (ACCEPTED, ACCEPTED_WITH_COMMENTS или REWORK_REQUIRED), score 1..5, explanation, strengths[], improvements[]. Не выдумывай факты.",
      JSON.stringify({
        problem: order.description,
        completed: order.completionText,
        equipment: order.equipment.name,
        faultCode: order.faultCode?.code,
        materials: order.materialUsages.map((x) => ({ name: x.material.name, quantity: x.quantity.toString() })),
        hasAfterPhoto: order.photos.some((p) => p.type === "AFTER"),
        photoReview,
        normativeHours: order.normative ? Number(order.normative.hours) : null,
        actualHours: order.startedAt && order.completedAt ? (order.completedAt.getTime() - order.startedAt.getTime()) / 3_600_000 : null,
        materialWarnings,
        missing
      })
    );
  } catch (error) {
    if (config.AI_STRICT) throw error;
    review = missing.length
      ? { verdict: AiVerdict.REWORK_REQUIRED, score: 2, explanation: `Не заполнено: ${missing.join(", ")}`, strengths: [], improvements: missing }
      : { verdict: AiVerdict.ACCEPTED_WITH_COMMENTS, score: 4, explanation: "Базовая проверка пройдена; Ollama временно недоступна", strengths: ["Обязательные поля заполнены"], improvements: ["Проверить результат мастером"] };
  }

  if (missing.length) {
    review.verdict = AiVerdict.REWORK_REQUIRED;
    review.score = Math.min(review.score, 2);
    review.explanation = `${review.explanation}. Не заполнено: ${missing.join(", ")}`;
  }
  if (materialWarnings.length && review.verdict === AiVerdict.ACCEPTED) {
    review.verdict = AiVerdict.ACCEPTED_WITH_COMMENTS;
    review.explanation = `${review.explanation}. ${materialWarnings.join("; ")}`;
  }
  if (photoReview.duplicate || photoReview.score <= 2) {
    review.verdict = AiVerdict.REWORK_REQUIRED;
    review.score = Math.min(review.score, 2);
    review.explanation = `${review.explanation}. Фото: ${photoReview.comment}`;
  }
  review.score = Math.max(1, Math.min(5, Math.round(review.score)));

  return prisma.$transaction(async (tx) => {
    const assessment = await tx.aiAssessment.upsert({
      where: { workOrderId },
      create: { workOrderId, ...review, confidence: photoReview.confidence, photoScore: photoReview.score, photoComment: photoReview.comment, rawResponse: { review, photoReview } },
      update: { ...review, confidence: photoReview.confidence, photoScore: photoReview.score, photoComment: photoReview.comment, rawResponse: { review, photoReview } }
    });
    await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.AI_REVIEW } });
    await tx.workOrderEvent.create({
      data: { workOrderId, actorId: order.creatorId, action: "AI_REVIEW", fromStatus: WorkOrderStatus.COMPLETED, toStatus: WorkOrderStatus.AI_REVIEW, comment: review.explanation }
    });
    return assessment;
  });
}
