import { AiVerdict, WorkOrderStatus } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { analyzeOrderPhotos } from "./photo-analysis.js";
import { recall, reviewText } from "./rag.js";

type Review = z.infer<typeof reviewSchema>;

const textList = z.preprocess((v) => typeof v === "string" ? [v] : v, z.array(z.coerce.string())).catch([]);
// The model's JSON is untrusted: unknown keys (e.g. "comment") or wrong types must not reach Prisma.
const reviewSchema = z.object({
  verdict: z.enum(AiVerdict).catch(AiVerdict.ACCEPTED_WITH_COMMENTS),
  score: z.preprocess((v) => typeof v === "string" && v.trim() ? Number(v) : v, z.number().finite()).catch(3),
  explanation: z.coerce.string().catch("Модель не дала объяснения"),
  strengths: textList,
  improvements: textList
});

// Measured on 24 labelled closures × 3 runs (docs/TESTING_AND_RESEARCH.md, R1) with the real pipeline;
// the previous one-line prompt scored 77.8% and accepted "Сделано"-style reports.
export const REVIEW_PROMPT = `Ты контролёр промышленных ремонтных нарядов горно-обогатительного предприятия. Отвечай только на русском.
Оцени, устранена ли заявленная проблема, по тексту отчёта исполнителя (поле completed).
REWORK_REQUIRED, если хотя бы одно верно:
- отчёт не описывает конкретных действий (например «сделано», «всё ок», «работа выполнена»);
- работа не выполнена, отложена или выполнена частично;
- отчёт не относится к заявленной проблеме;
- проблема осталась (течь осталась, лента продолжает сходить и т.п.);
- нарушена безопасность или технология (отключена защита, неверные материалы);
- текст бессмысленный.
ACCEPTED — конкретные действия устраняют проблему, есть проверка результата. ACCEPTED_WITH_COMMENTS — проблема устранена, но отчёт неполный.
Фото-оценка вторична: не принимай работу только из-за фото.
Верни только JSON: verdict, score 1..5, explanation, strengths[], improvements[]. Не выдумывай факты.`;

// Appended only when the RAG memory found similar decisions, so the base prompt stays the measured one.
export const PRECEDENTS_PROMPT = `
precedents — решения мастеров этого предприятия по похожим отчётам (similarity 0..1).
Требования предприятия — только masterComment у прецедентов «ВОЗВРАЩЕНО НА ДОРАБОТКУ»: если в текущем отчёте нет того же (замер, проверка, испытание, марка материала), — REWORK_REQUIRED и назови это требование; если есть — этот прецедент не применяй.
Прецеденты «ПРИНЯТО» лишь показывают допустимый отчёт и новых требований не создают: не возвращай отчёт только за то, что он короче или проще принятого.
Прецеденты не отменяют критерии доработки выше.`;

// A near-identical report the master decided the other way: the AI must not overrule the master alone.
const STRONG_PRECEDENT = 0.9;

// Safety bypasses must never depend on the LLM: the model caught "отключил защиту" in only 2 of 3 runs.
const SAFETY_VIOLATION = /(отключ|обош|обход|замкн|перемкн|перемычк|шунтир|заблокир)\S*\s+(\S+\s+){0,2}(защит|блокировк|заземлен|концевик)|без\s+(заземлен|допуск|наряда-допуска)/i;

export function findSafetyViolation(text: string | null | undefined) {
  return text ? SAFETY_VIOLATION.exec(text)?.[0] ?? null : null;
}

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

  const safetyViolation = findSafetyViolation(order.completionText);
  const photoReview = await analyzeOrderPhotos(workOrderId);
  const precedents = order.completionText?.trim()
    ? await recall("REVIEW", reviewText(order.equipment.type, order.description, order.completionText), { exclude: workOrderId })
    : [];
  let review: Review;
  let llmAvailable = true;
  try {
    review = reviewSchema.parse(await askOllama<unknown>(
      precedents.length ? REVIEW_PROMPT + PRECEDENTS_PROMPT : REVIEW_PROMPT,
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
        missing,
        ...(precedents.length ? {
          precedents: precedents.map((p) => ({ problem: p.problem, report: p.report, masterDecision: p.accepted ? "ПРИНЯТО" : "ВОЗВРАЩЕНО НА ДОРАБОТКУ", masterComment: p.masterComment, similarity: p.similarity }))
        } : {})
      })
    ));
  } catch (error) {
    if (config.AI_STRICT) throw error;
    llmAvailable = false;
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
  if (safetyViolation) {
    review.verdict = AiVerdict.REWORK_REQUIRED;
    review.score = 1;
    review.explanation = `${review.explanation}. Нарушение безопасности в отчёте: «${safetyViolation}»`;
  }
  // A missing after-photo is already handled by `missing` (required for emergency orders only).
  if (photoReview.duplicate || photoReview.stale || (photoReview.score <= 2 && !photoReview.missing)) {
    review.verdict = AiVerdict.REWORK_REQUIRED;
    review.score = Math.min(review.score, 2);
    review.explanation = `${review.explanation}. Фото: ${photoReview.comment}`;
  }
  review.score = Math.max(1, Math.min(5, Math.round(review.score)));
  // 6.3.4: when the AI is unsure it flags the order for the master instead of deciding alone.
  const strong = precedents[0]?.similarity >= STRONG_PRECEDENT ? precedents[0] : undefined;
  const contradictsMaster = Boolean(strong && strong.accepted !== (review.verdict !== AiVerdict.REWORK_REQUIRED));
  if (contradictsMaster) review.explanation = `${review.explanation}. Почти такой же отчёт мастер ранее ${strong!.accepted ? "принял" : "вернул на доработку"}${strong!.masterComment ? `: «${strong!.masterComment}»` : ""}`;
  const needsMasterReview = !llmAvailable || contradictsMaster || Boolean(photoReview.suspicious) || Boolean(photoReview.lowConfidence);
  if (needsMasterReview) review.explanation = `Нужна проверка мастером. ${review.explanation}`;
  const rag = precedents.map((p) => ({ id: p.id, workOrderId: p.workOrderId, accepted: p.accepted, similarity: p.similarity }));

  return prisma.$transaction(async (tx) => {
    const assessment = await tx.aiAssessment.upsert({
      where: { workOrderId },
      create: { workOrderId, ...review, needsMasterReview, confidence: photoReview.confidence, photoScore: photoReview.score, photoComment: photoReview.comment, ragPrecedents: rag.length, rawResponse: { review, photoReview, rag } },
      update: { ...review, needsMasterReview, confidence: photoReview.confidence, photoScore: photoReview.score, photoComment: photoReview.comment, ragPrecedents: rag.length, rawResponse: { review, photoReview, rag } }
    });
    await tx.workOrder.update({ where: { id: workOrderId }, data: { status: WorkOrderStatus.AI_REVIEW } });
    await tx.workOrderEvent.create({
      data: { workOrderId, actorId: order.creatorId, action: "AI_REVIEW", fromStatus: WorkOrderStatus.COMPLETED, toStatus: WorkOrderStatus.AI_REVIEW, comment: review.explanation }
    });
    return assessment;
  });
}
