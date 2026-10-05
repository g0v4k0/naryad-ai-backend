import { resultsDir } from "./env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { classify } from "../src/services/assistant.js";

const set: Array<[string, string, string]> = [
  ["Кто свободен из электриков?", "FREE_EXECUTORS", "ru"], ["Есть свободные слесари?", "FREE_EXECUTORS", "ru"],
  ["Кого можно отправить на насос прямо сейчас?", "FREE_EXECUTORS", "ru"], ["Кто сейчас без работы?", "FREE_EXECUTORS", "ru"],
  ["Покажи доступных сварщиков", "FREE_EXECUTORS", "ru"], ["Бос электриктер бар ма?", "FREE_EXECUTORS", "kk"],
  ["Что просрочено?", "OVERDUE", "ru"], ["Какие наряды не закрыты в срок?", "OVERDUE", "ru"],
  ["Где опаздываем по срокам?", "OVERDUE", "ru"], ["Список нарядов с истёкшим дедлайном", "OVERDUE", "ru"],
  ["Что горит по времени?", "OVERDUE", "ru"], ["Мерзімі өтіп кеткен наряд қайсы?", "OVERDUE", "kk"],
  ["История ремонтов конвейера К-3", "EQUIPMENT_HISTORY", "ru"], ["Что чинили на насосе Н-1?", "EQUIPMENT_HISTORY", "ru"],
  ["Покажи все наряды по дробилке Д-2", "EQUIPMENT_HISTORY", "ru"], ["Как часто ломался Оборудование 5?", "EQUIPMENT_HISTORY", "ru"],
  ["Когда последний раз ремонтировали К-3?", "EQUIPMENT_HISTORY", "ru"], ["К-3 конвейерінің жөндеу тарихы", "EQUIPMENT_HISTORY", "kk"],
  ["Как прошла смена?", "SHIFT_REPORT", "ru"], ["Дай сводку за смену", "SHIFT_REPORT", "ru"],
  ["Сколько нарядов закрыли сегодня?", "SHIFT_REPORT", "ru"], ["Итоги смены", "SHIFT_REPORT", "ru"],
  ["Отчёт по выполненным работам за 12 часов", "SHIFT_REPORT", "ru"], ["Ауысым қалай өтті?", "SHIFT_REPORT", "kk"],
  ["Покажи аномалии", "ANOMALIES", "ru"], ["Есть ли подозрительный расход материалов?", "ANOMALIES", "ru"],
  ["Где повторяются одни и те же поломки?", "ANOMALIES", "ru"], ["Найди странности в ремонтах", "ANOMALIES", "ru"],
  ["Какие отказы после ППР?", "ANOMALIES", "ru"], ["Ауытқуларды көрсет", "ANOMALIES", "kk"],
  ["Дай прогноз отказов", "FAILURE_FORECAST", "ru"], ["Что сломается в ближайший месяц?", "FAILURE_FORECAST", "ru"],
  ["Какое оборудование в зоне риска?", "FAILURE_FORECAST", "ru"], ["Вероятность поломки конвейеров", "FAILURE_FORECAST", "ru"],
  ["Где ждать следующую аварию?", "FAILURE_FORECAST", "ru"], ["Ақаулар болжамын бер", "FAILURE_FORECAST", "kk"]
];
const mode = process.env.FORCE_OLLAMA_URL ? "keywords" : "llm";
const rows = [];
for (const [message, expected, lang] of set) {
  const t = performance.now();
  const intent = await classify(message);
  const ms = Math.round(performance.now() - t);
  rows.push({ message, expected, lang, predicted: intent.intent, correct: intent.intent === expected, ms, raw: intent });
  console.log(`${intent.intent === expected ? "✓" : "✗"} ${expected} → ${intent.intent} ${ms}ms  ${message}`);
}
writeFileSync(join(resultsDir, `r2-intents-${mode}.json`), JSON.stringify(rows, null, 2));
await prisma.$disconnect();
