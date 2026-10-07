import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { buildAnomalies, predictFailures } from "./analytics.js";
import { buildShiftReport } from "./reports.js";

const INTENTS = ["FREE_EXECUTORS", "OVERDUE", "EQUIPMENT_HISTORY", "SHIFT_REPORT", "ANOMALIES", "FAILURE_FORECAST"] as const;
const optionalText = z.preprocess((v) => typeof v === "string" && v.trim() ? v.trim() : undefined, z.string().optional());
// Model output is untrusted: values reach Prisma filters, so anything off-schema is dropped.
const intentSchema = z.object({
  intent: z.enum(INTENTS),
  equipmentId: z.preprocess((v) => typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined, z.number().optional()),
  equipmentQuery: optionalText,
  specialty: optionalText,
  areaQuery: optionalText,
  periodDays: z.preprocess((v) => typeof v === "string" ? Number(v) : v, z.number().positive().max(366)).optional().catch(undefined)
});
type Intent = z.infer<typeof intentSchema>;

/** The model sometimes returns the answer as the raw data array instead of text. */
function answerText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    if (!value.length) return "Ничего не найдено.";
    return value.map((item) => item && typeof item === "object"
      ? String((item as Record<string, unknown>).fullName ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).number ?? JSON.stringify(item))
      : String(item)).join(", ");
  }
  return null;
}

// Examples resolve the boundaries the model confused in R2 (anomalies vs history vs forecast).
const CLASSIFY_PROMPT = `Определи намерение вопроса мастера смены (русский или казахский). Никогда не создавай SQL.
Верни только JSON: intent и необязательные specialty (Слесарь, Электрик, Сварщик), equipmentQuery (название или номер оборудования), areaQuery (участок, например «дробление», «обогащение»), periodDays (период в днях: смена 0.5, сутки 1, неделя 7, месяц 30).
Намерения:
- FREE_EXECUTORS — кто свободен, кого отправить. «Есть свободные слесари?», «Кого можно отправить на насос?», «Бос электриктер бар ма?»
- OVERDUE — наряды с истёкшим сроком, опоздания. «Что просрочено?», «Что горит по времени?», «Мерзімі өтіп кеткен наряд қайсы?»
- EQUIPMENT_HISTORY — ремонты конкретного оборудования. «История К-3», «Покажи все наряды по дробилке Д-2», «Что чинили на насосе Н-1?»
- SHIFT_REPORT — итоги смены или периода, отчёт, сколько сделано. «Как прошла смена?», «Сколько закрыли сегодня?», «Сформируй отчёт за неделю по участку обогащения» (periodDays 7, areaQuery «обогащение»), «Ауысым қалай өтті?»
- ANOMALIES — подозрительное и проблемы: повторы одних поломок, отказы после ППР, перерасход материалов, проблемные участки. «Где повторяются одни и те же поломки?», «Какие отказы после ППР?», «Покажи проблемы участка дробления за месяц» (periodDays 30, areaQuery «дробление»), «Ауытқуларды көрсет»
- FAILURE_FORECAST — что сломается в будущем, риск. «Какое оборудование в зоне риска?», «Что сломается в ближайший месяц?», «Ақаулар болжамын бер»`;

const KEYWORDS: Array<[Intent["intent"], RegExp]> = [
  ["FREE_EXECUTORS", /свобод|без работы|доступн|отправить|бос /],
  ["OVERDUE", /просроч|срок|опазд|дедлайн|горит|мерзім/],
  ["FAILURE_FORECAST", /прогноз|риск|сломает|вероятн|ожидать|болжам/],
  ["ANOMALIES", /аномал|проблем|подозрит|странност|повторя|после ппр|ауытқу/],
  ["EQUIPMENT_HISTORY", /истори|чинили|ремонтировал|наряды по|тарих/],
  ["SHIFT_REPORT", /смен|сводк|итог|отчёт|отчет|закрыли|ауысым/]
];

const PERIODS: Array<[RegExp, number]> = [
  [/квартал|3 месяц|три месяц|90 дн/, 90], [/месяц|30 дн|\bай\b/, 30], [/недел|апта|7 дн/, 7], [/сутк|сегодня|за день|бүгін/, 1], [/смен|ауысым/, 0.5]
];

/** Period in days named in the question, if any. */
export function periodFromText(lower: string) {
  return PERIODS.find(([pattern]) => pattern.test(lower))?.[1];
}

/** Area named in the question: matched by the stem of its name («дробления» → «Дробление»). */
async function resolveArea(text: string | undefined) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const areas = await prisma.area.findMany({ select: { id: true, name: true } });
  return areas.find((area) => area.name.toLowerCase().split(/[\s-]+/).some((word) => word.length >= 4 && lower.includes(word.slice(0, Math.max(4, word.length - 3))))) ?? null;
}

export async function classify(message: string): Promise<Intent> {
  const lower = message.toLowerCase();
  try {
    const intent = intentSchema.parse(await askOllama<unknown>(CLASSIFY_PROMPT, message));
    return { ...intent, periodDays: intent.periodDays ?? periodFromText(lower) };
  } catch {
    const intent = KEYWORDS.find(([, pattern]) => pattern.test(lower))?.[0] ?? "SHIFT_REPORT";
    const periodDays = periodFromText(lower);
    if (intent === "FREE_EXECUTORS") return { intent, specialty: lower.includes("электрик") ? "Электрик" : lower.includes("слесар") ? "Слесарь" : lower.includes("сварщик") ? "Сварщик" : undefined };
    if (intent === "EQUIPMENT_HISTORY") return { intent, equipmentQuery: message.match(/[A-ZА-ЯЁ]-?\d+/u)?.[0] };
    return { intent, periodDays };
  }
}

export async function answerAssistant(userId: number, message: string) {
  const intent = await classify(message);
  // The area is looked up in the question itself too: the model may skip it.
  const area = await resolveArea(intent.areaQuery) ?? await resolveArea(message);
  const days = (fallback: number) => intent.periodDays ?? fallback;
  const since = (fallbackDays: number) => new Date(Date.now() - days(fallbackDays) * 86_400_000);
  let data: unknown;
  if (intent.intent === "FREE_EXECUTORS") data = await prisma.user.findMany({ where: { role: "EXECUTOR", isOnShift: true, employeeStatus: "AVAILABLE", ...(intent.specialty ? { specialty: intent.specialty } : {}) }, select: { id: true, fullName: true, specialty: true, grade: true } });
  else if (intent.intent === "OVERDUE") data = await prisma.workOrder.findMany({ where: { deadline: { lt: new Date() }, status: { notIn: ["CLOSED", "CANCELLED", "REJECTED", "COMPLETED", "AI_REVIEW"] }, ...(area ? { areaId: area.id } : {}) }, include: { equipment: true, assignee: { select: { fullName: true } } }, take: 50 });
  else if (intent.intent === "EQUIPMENT_HISTORY") {
    const equipment = intent.equipmentId
      ? await prisma.equipment.findUnique({ where: { id: intent.equipmentId } })
      : intent.equipmentQuery ? await prisma.equipment.findFirst({ where: { name: { contains: intent.equipmentQuery } } }) : null;
    data = equipment ? await prisma.workOrder.findMany({ where: { equipmentId: equipment.id }, include: { faultCode: true, aiAssessment: true }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
  }
  else if (intent.intent === "ANOMALIES") data = await buildAnomalies(since(90), new Date(), { areaId: area?.id });
  else if (intent.intent === "FAILURE_FORECAST") {
    const forecast = await predictFailures();
    const areaEquipment = area ? new Set((await prisma.equipment.findMany({ where: { areaId: area.id }, select: { id: true } })).map((x) => x.id)) : null;
    data = areaEquipment ? forecast.filter((x) => areaEquipment.has(x.equipmentId)) : forecast;
  }
  else {
    const { load, ...report } = await buildShiftReport({ from: since(0.5), to: new Date(), areaId: area?.id });
    data = { ...report, area: area?.name ?? "все участки", periodDays: days(0.5), busiestExecutors: load.sort((a, b) => b.assigned - a.assigned).slice(0, 5) };
  }

  let answer: string;
  try {
    const result = await askOllama<{ answer?: unknown }>("Ты помощник мастера смены. Ответь кратко по-русски только на основании DATA. Не выдумывай. Верни JSON: answer — строка с ответом.", JSON.stringify({ question: message, intent, data }));
    const text = answerText(result.answer);
    if (!text) throw new Error("Пустой ответ помощника");
    answer = text;
  } catch {
    answer = `Результат запроса ${intent.intent}: ${JSON.stringify(data)}`;
  }
  await prisma.assistantMessage.createMany({ data: [
    { userId, role: "user", content: message },
    { userId, role: "assistant", content: answer, sources: { intent, areaId: area?.id ?? null } }
  ] });
  return { answer, intent: { ...intent, ...(area ? { areaId: area.id, area: area.name } : {}) }, data };
}
