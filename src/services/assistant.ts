import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { askOllama } from "./ollama.js";
import { buildAnomalies, predictFailures } from "./analytics.js";
import { buildShiftReport } from "./reports.js";
import { detectLang, phrase, type Lang } from "./ai-text.js";
import type { WorkOrderStatus } from "@prisma/client";
import { shortName, STATUS_LABELS } from "../lib/labels.js";
import { formatDuration, formatLocal } from "../lib/time.js";

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

const periodLabel = (days: number, lang: Lang) => {
  const labels: Record<string, [string, string]> = { "0.5": ["за смену", "ауысымда"], "1": ["за сутки", "тәулікте"], "7": ["за неделю", "аптада"], "30": ["за месяц", "айда"], "90": ["за квартал", "тоқсанда"] };
  const label = labels[String(days)];
  return label ? label[lang === "kk" ? 1 : 0] : lang === "kk" ? `${days} күнде` : `за ${days} дн.`;
};
const list = (items: string[]) => items.join("; ");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Answerable = { facts: Record<string, unknown>; hasData: boolean; template: Record<Lang, string> };

/** Facts for the model (no ids, numbers precomputed) and an exact answer if the model fails. */
async function factsFor(intent: Intent, data: unknown, area: { id: number; name: string } | null, days: number): Promise<Answerable> {
  if (intent.intent === "FREE_EXECUTORS") {
    const people = (data as Array<{ fullName: string; specialty: string | null; grade: number | null }>).map((x) => `${x.fullName} (${(x.specialty ?? "исполнитель").toLowerCase()}${x.grade ? `, ${x.grade} разряд` : ""})`);
    const who = intent.specialty ? intent.specialty.toLowerCase() : "исполнителей";
    return {
      facts: { специальность: intent.specialty ?? "любая", свободны: people, количество: people.length },
      hasData: people.length > 0,
      template: people.length
        ? { ru: `Свободны на смене (${people.length}): ${list(people)}.`, kk: `Ауысымда бос (${people.length}): ${list(people)}.` }
        : { ru: `Свободных ${who} на смене нет.`, kk: `Ауысымда бос ${who} жоқ.` }
    };
  }
  if (intent.intent === "OVERDUE") {
    const orders = (data as Array<{ number: string; deadline: Date; status: WorkOrderStatus; equipment: { name: string }; area: { name: string }; assignee: { fullName: string } }>).map((x) => ({
      номер: `№${x.number}`, оборудование: x.equipment.name, участок: x.area.name, исполнитель: shortName(x.assignee.fullName),
      статус: STATUS_LABELS[x.status], просрочен: formatDuration(Math.max(0, Math.floor((Date.now() - x.deadline.getTime()) / 60_000)))
    }));
    const lines = orders.map((x) => `${x.номер} — ${x.оборудование}, ${x.исполнитель}, ${x.статус}, просрочен на ${x.просрочен}`);
    const kkLines = orders.map((x) => `${x.номер} — ${x.оборудование}, ${x.исполнитель}, ${x.просрочен} кешікті`);
    return {
      facts: { участок: area?.name ?? "все участки", просрочено: orders.length, наряды: orders },
      hasData: orders.length > 0,
      template: orders.length
        ? { ru: `Просрочено нарядов: ${orders.length}. ${list(lines)}.`, kk: `Мерзімі өткен наряд: ${orders.length}. ${list(kkLines)}.` }
        : { ru: "Просроченных нарядов нет.", kk: "Мерзімі өткен наряд жоқ." }
    };
  }
  if (intent.intent === "EQUIPMENT_HISTORY") {
    const history = data as { equipment: string; orders: Array<{ number: string; type: string; createdAt: Date; description: string; status: WorkOrderStatus; faultCode: { code: string; name: string } | null }> } | null;
    if (!history) return { facts: { оборудование: "не найдено" }, hasData: false, template: { ru: "Оборудование не найдено. Уточните название или номер, например «К-3».", kk: "Жабдық табылмады. Атауын немесе нөмірін нақтылаңыз, мысалы «К-3»." } };
    const all = history.orders;
    const codes = new Map<string, { name: string; count: number }>();
    for (const order of all) if (order.faultCode) codes.set(order.faultCode.code, { name: order.faultCode.name, count: (codes.get(order.faultCode.code)?.count ?? 0) + 1 });
    const top = [...codes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([code, x]) => `${code} «${x.name}» — ${x.count}`);
    const emergencies = all.filter((x) => x.type === "EMERGENCY").length;
    const last = all[0];
    const facts = {
      оборудование: history.equipment, нарядов: all.length, аварийных: emergencies, плановых: all.length - emergencies,
      доля_аварийных_процентов: all.length ? Math.round(emergencies / all.length * 100) : 0,
      период_с: all.length ? formatLocal(all[all.length - 1].createdAt).slice(0, 10) : null, период_по: last ? formatLocal(last.createdAt).slice(0, 10) : null,
      частые_шифры: top,
      последний_наряд: last ? { номер: `№${last.number}`, дата: formatLocal(last.createdAt).slice(0, 10), описание: last.description, статус: STATUS_LABELS[last.status] } : null
    };
    if (!all.length) return { facts, hasData: false, template: { ru: `${history.equipment}: нарядов не было.`, kk: `${history.equipment}: наряд болмаған.` } };
    return {
      facts, hasData: true,
      template: {
        ru: `${history.equipment}: ${all.length} нарядов с ${facts.период_с} по ${facts.период_по}, из них аварийных ${emergencies} (${facts.доля_аварийных_процентов}%). Чаще всего: ${list(top)}. Последний: ${facts.последний_наряд!.номер} от ${facts.последний_наряд!.дата} — ${last.description}, ${STATUS_LABELS[last.status]}.`,
        kk: `${history.equipment}: ${facts.период_с} – ${facts.период_по} аралығында ${all.length} наряд, оның ${emergencies} апаттық (${facts.доля_аварийных_процентов}%). Жиі ақаулар: ${list(top)}. Соңғы наряд: ${facts.последний_наряд!.номер}, ${facts.последний_наряд!.дата} — ${last.description}.`
      }
    };
  }
  if (intent.intent === "ANOMALIES") {
    const insights = (data as Array<{ title: string; description: string; recommendation: string; severity: number }>).slice(0, 6);
    const items = insights.map((x) => ({ вывод: x.title, факты: x.description, рекомендация: x.recommendation }));
    const ru = insights.map((x, i) => `${i + 1}) ${x.title}: ${x.description}. ${x.recommendation}`);
    return {
      facts: { участок: area?.name ?? "все участки", период: periodLabel(days, "ru"), найдено: (data as unknown[]).length, выводы: items },
      hasData: insights.length > 0,
      template: insights.length
        ? { ru: `${area ? `Участок «${area.name}», ${periodLabel(days, "ru")}` : capitalize(periodLabel(days, "ru"))} найдено: ${(data as unknown[]).length}. ${ru.join(" ")}`, kk: `${area ? `«${area.name}» учаскесі, ${periodLabel(days, "kk")}` : capitalize(periodLabel(days, "kk"))} ${(data as unknown[]).length} ауытқу табылды. ${ru.join(" ")}` }
        : { ru: area ? `На участке «${area.name}» ${periodLabel(days, "ru")} аномалий не найдено.` : `${capitalize(periodLabel(days, "ru"))} аномалий не найдено.`, kk: `${capitalize(periodLabel(days, "kk"))} ауытқу табылмады.` }
    };
  }
  if (intent.intent === "FAILURE_FORECAST") {
    const top = (data as Array<{ equipment: string; probability: number; recentFailures: number }>).slice(0, 5).map((x) => ({ оборудование: x.equipment, вероятность_отказа_процентов: Math.round(x.probability * 100), аварий_за_30_дней: x.recentFailures }));
    const lines = top.map((x) => `${x.оборудование} — ${x.вероятность_отказа_процентов}%`);
    return {
      facts: { участок: area?.name ?? "все участки", горизонт_дней: 30, в_зоне_риска: top },
      hasData: top.length > 0,
      template: top.length
        ? { ru: `Вероятность отказа в ближайшие 30 дней: ${list(lines)}.`, kk: `Алдағы 30 күнде істен шығу ықтималдығы: ${list(lines)}.` }
        : { ru: "Оборудования в зоне риска нет.", kk: "Қауіп аймағында жабдық жоқ." }
    };
  }
  const report = data as { issued: number; completed: number; closed: number; overdue: number; rejected: number; workload: { executorsOnShift: number; busy: number; free: number }; downtime: { minutes: number; equipmentInDowntimeNow: number } };
  const where = area?.name ?? "все участки";
  return {
    facts: { участок: where, период: periodLabel(days, "ru"), выдано: report.issued, выполнено: report.completed, закрыто: report.closed, просрочено: report.overdue, отклонено: report.rejected, исполнителей_на_смене: report.workload.executorsOnShift, заняты: report.workload.busy, свободны: report.workload.free, простой_минут: report.downtime.minutes, сейчас_в_простое_единиц: report.downtime.equipmentInDowntimeNow },
    hasData: true,
    template: {
      ru: `${area ? `Участок «${area.name}»` : "Все участки"}, ${periodLabel(days, "ru")}: выдано ${report.issued}, выполнено ${report.completed}, просрочено ${report.overdue}, отклонено ${report.rejected}. На смене ${report.workload.executorsOnShift} исполнителей, заняты ${report.workload.busy}. Простой ${report.downtime.minutes} мин, сейчас в простое ${report.downtime.equipmentInDowntimeNow}.`,
      kk: `${area ? `«${area.name}» учаскесі` : "Барлық учаскелер"}, ${periodLabel(days, "kk")}: берілді ${report.issued}, орындалды ${report.completed}, мерзімі өтті ${report.overdue}, бас тартылды ${report.rejected}. Ауысымда ${report.workload.executorsOnShift} орындаушы, ${report.workload.busy} бос емес. Тоқтап тұру ${report.downtime.minutes} мин.`
    }
  };
}

export async function answerAssistant(userId: number, message: string) {
  const intent = await classify(message);
  const lang = detectLang(message);
  // The area is looked up in the question itself too: the model may skip it.
  const area = await resolveArea(intent.areaQuery) ?? await resolveArea(message);
  const days = (fallback: number) => intent.periodDays ?? fallback;
  const since = (fallbackDays: number) => new Date(Date.now() - days(fallbackDays) * 86_400_000);
  let data: unknown;
  let history: { equipment: string; orders: Array<{ number: string; type: string; createdAt: Date; description: string; status: WorkOrderStatus; faultCode: { code: string; name: string } | null }> } | null = null;
  let period = days(0.5);
  if (intent.intent === "FREE_EXECUTORS") data = await prisma.user.findMany({ where: { role: "EXECUTOR", isOnShift: true, employeeStatus: "AVAILABLE", ...(intent.specialty ? { specialty: intent.specialty } : {}) }, select: { id: true, fullName: true, specialty: true, grade: true } });
  else if (intent.intent === "OVERDUE") data = await prisma.workOrder.findMany({ where: { deadline: { lt: new Date() }, status: { notIn: ["CLOSED", "CANCELLED", "REJECTED", "COMPLETED", "AI_REVIEW"] }, ...(area ? { areaId: area.id } : {}) }, include: { equipment: true, area: true, assignee: { select: { fullName: true } } }, orderBy: { deadline: "asc" }, take: 50 });
  else if (intent.intent === "EQUIPMENT_HISTORY") {
    const equipment = intent.equipmentId
      ? await prisma.equipment.findUnique({ where: { id: intent.equipmentId } })
      : intent.equipmentQuery ? await prisma.equipment.findFirst({ where: { name: { contains: intent.equipmentQuery } } }) : null;
    data = equipment ? await prisma.workOrder.findMany({ where: { equipmentId: equipment.id }, include: { faultCode: true, aiAssessment: true }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
    // Statistics over the whole history, not just the 50 rows returned to the client.
    const all = equipment ? await prisma.workOrder.findMany({ where: { equipmentId: equipment.id }, select: { number: true, type: true, createdAt: true, description: true, status: true, faultCode: { select: { code: true, name: true } } }, orderBy: { createdAt: "desc" } }) : [];
    history = equipment ? { equipment: equipment.name, orders: all } : null;
  }
  else if (intent.intent === "ANOMALIES") { period = days(90); data = await buildAnomalies(since(90), new Date(), { areaId: area?.id }); }
  else if (intent.intent === "FAILURE_FORECAST") {
    const forecast = await predictFailures();
    const areaEquipment = area ? new Set((await prisma.equipment.findMany({ where: { areaId: area.id }, select: { id: true } })).map((x) => x.id)) : null;
    data = areaEquipment ? forecast.filter((x) => areaEquipment.has(x.equipmentId)) : forecast;
  }
  else {
    const { load, ...report } = await buildShiftReport({ from: since(0.5), to: new Date(), areaId: area?.id });
    data = { ...report, area: area?.name ?? "все участки", periodDays: days(0.5), busiestExecutors: load.sort((a, b) => b.assigned - a.assigned).slice(0, 5) };
  }

  const { facts, hasData, template } = await factsFor(intent, intent.intent === "EQUIPMENT_HISTORY" ? history : data, area, period);
  // The local model writes Kazakh with wrong words («3 шеше» — "3 mothers"), so Kazakh questions get the checked template.
  const { text: answer, fromModel } = lang === "kk"
    ? { text: template.kk, fromModel: false }
    : await phrase({
      task: "Ты помощник мастера смены горно-обогатительного предприятия. Кратко (1–4 предложения) ответь на вопрос мастера по данным FACTS.",
      question: message, facts, lang, hasData, fallback: template.ru
    });
  await prisma.assistantMessage.createMany({ data: [
    { userId, role: "user", content: message },
    { userId, role: "assistant", content: answer, sources: { intent, areaId: area?.id ?? null, lang, fromModel } }
  ] });
  return { answer, intent: { ...intent, ...(area ? { areaId: area.id, area: area.name } : {}) }, lang, fromModel, data };
}
