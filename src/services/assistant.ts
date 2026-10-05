import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { buildAnomalies, predictFailures } from "./analytics.js";

type Intent = { intent: "FREE_EXECUTORS" | "OVERDUE" | "EQUIPMENT_HISTORY" | "SHIFT_REPORT" | "ANOMALIES" | "FAILURE_FORECAST"; areaId?: number; equipmentId?: number; equipmentQuery?: string; specialty?: string };

export async function classify(message: string): Promise<Intent> {
  try {
    return await askOllama<Intent>("Определи намерение. Верни только JSON intent из FREE_EXECUTORS, OVERDUE, EQUIPMENT_HISTORY, SHIFT_REPORT, ANOMALIES, FAILURE_FORECAST и необязательные specialty, equipmentQuery. Никогда не создавай SQL.", message);
  } catch {
    const lower = message.toLowerCase();
    if (lower.includes("свобод")) return { intent: "FREE_EXECUTORS", specialty: lower.includes("электрик") ? "Электрик" : undefined };
    if (lower.includes("просроч")) return { intent: "OVERDUE" };
    if (lower.includes("прогноз")) return { intent: "FAILURE_FORECAST" };
    if (lower.includes("аномал") || lower.includes("проблем")) return { intent: "ANOMALIES" };
    return { intent: "SHIFT_REPORT" };
  }
}

export async function answerAssistant(userId: number, message: string) {
  const intent = await classify(message);
  let data: unknown;
  if (intent.intent === "FREE_EXECUTORS") data = await prisma.user.findMany({ where: { role: "EXECUTOR", isOnShift: true, employeeStatus: "AVAILABLE", ...(intent.specialty ? { specialty: intent.specialty } : {}) }, select: { id: true, fullName: true, specialty: true, grade: true } });
  else if (intent.intent === "OVERDUE") data = await prisma.workOrder.findMany({ where: { deadline: { lt: new Date() }, status: { notIn: ["CLOSED", "CANCELLED", "REJECTED"] } }, include: { equipment: true, assignee: { select: { fullName: true } } }, take: 50 });
  else if (intent.intent === "EQUIPMENT_HISTORY") {
    const equipment = intent.equipmentId
      ? await prisma.equipment.findUnique({ where: { id: intent.equipmentId } })
      : intent.equipmentQuery ? await prisma.equipment.findFirst({ where: { name: { contains: intent.equipmentQuery } } }) : null;
    data = equipment ? await prisma.workOrder.findMany({ where: { equipmentId: equipment.id }, include: { faultCode: true, aiAssessment: true }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
  }
  else if (intent.intent === "ANOMALIES") data = await buildAnomalies();
  else if (intent.intent === "FAILURE_FORECAST") data = await predictFailures();
  else data = await prisma.workOrder.groupBy({ by: ["status"], where: { createdAt: { gte: new Date(Date.now() - 12 * 3_600_000) } }, _count: true });

  let answer: string;
  try {
    const result = await askOllama<{ answer: string }>("Ты помощник мастера смены. Ответь кратко по-русски только на основании DATA. Не выдумывай. Верни JSON answer.", JSON.stringify({ question: message, intent, data }));
    answer = result.answer;
  } catch {
    answer = `Результат запроса ${intent.intent}: ${JSON.stringify(data)}`;
  }
  await prisma.assistantMessage.createMany({ data: [
    { userId, role: "user", content: message },
    { userId, role: "assistant", content: answer, sources: { intent } }
  ] });
  return { answer, intent, data };
}
