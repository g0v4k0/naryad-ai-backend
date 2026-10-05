import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { buildAnomalies, predictFailures } from "./analytics.js";

type Intent = { intent: "FREE_EXECUTORS" | "OVERDUE" | "EQUIPMENT_HISTORY" | "SHIFT_REPORT" | "ANOMALIES" | "FAILURE_FORECAST"; areaId?: number; equipmentId?: number; equipmentQuery?: string; specialty?: string };

// Examples resolve the boundaries the model confused in R2 (anomalies vs history vs forecast).
const CLASSIFY_PROMPT = `Определи намерение вопроса мастера смены (русский или казахский). Никогда не создавай SQL.
Верни только JSON: intent и необязательные specialty (Слесарь, Электрик, Сварщик), equipmentQuery (название или номер оборудования).
Намерения:
- FREE_EXECUTORS — кто свободен, кого отправить. «Есть свободные слесари?», «Кого можно отправить на насос?», «Бос электриктер бар ма?»
- OVERDUE — наряды с истёкшим сроком, опоздания. «Что просрочено?», «Что горит по времени?», «Мерзімі өтіп кеткен наряд қайсы?»
- EQUIPMENT_HISTORY — ремонты конкретного оборудования. «История К-3», «Покажи все наряды по дробилке Д-2», «Что чинили на насосе Н-1?»
- SHIFT_REPORT — итоги смены, сколько сделано. «Как прошла смена?», «Сколько закрыли сегодня?», «Ауысым қалай өтті?»
- ANOMALIES — подозрительное по всему парку: повторы одних поломок, отказы после ППР, перерасход материалов. «Где повторяются одни и те же поломки?», «Какие отказы после ППР?», «Ауытқуларды көрсет»
- FAILURE_FORECAST — что сломается в будущем, риск. «Какое оборудование в зоне риска?», «Что сломается в ближайший месяц?», «Ақаулар болжамын бер»`;

const KEYWORDS: Array<[Intent["intent"], RegExp]> = [
  ["FREE_EXECUTORS", /свобод|без работы|доступн|отправить|бос /],
  ["OVERDUE", /просроч|срок|опазд|дедлайн|горит|мерзім/],
  ["FAILURE_FORECAST", /прогноз|риск|сломает|вероятн|ожидать|болжам/],
  ["ANOMALIES", /аномал|проблем|подозрит|странност|повторя|после ппр|ауытқу/],
  ["EQUIPMENT_HISTORY", /истори|чинили|ремонтировал|наряды по|тарих/],
  ["SHIFT_REPORT", /смен|сводк|итог|отчёт|отчет|закрыли|ауысым/]
];

export async function classify(message: string): Promise<Intent> {
  try {
    return await askOllama<Intent>(CLASSIFY_PROMPT, message);
  } catch {
    const lower = message.toLowerCase();
    const intent = KEYWORDS.find(([, pattern]) => pattern.test(lower))?.[0] ?? "SHIFT_REPORT";
    if (intent === "FREE_EXECUTORS") return { intent, specialty: lower.includes("электрик") ? "Электрик" : lower.includes("слесар") ? "Слесарь" : lower.includes("сварщик") ? "Сварщик" : undefined };
    if (intent === "EQUIPMENT_HISTORY") return { intent, equipmentQuery: message.match(/[A-ZА-ЯЁ]-?\d+/u)?.[0] };
    return { intent };
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
