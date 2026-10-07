import { askOllama } from "./ollama.js";

export type Lang = "ru" | "kk";

// Letters that exist in Kazakh but not in Russian, plus frequent Kazakh words written without them.
const KAZAKH = /[әғқңөұүһі]|(^|\s)(бар ма|бос|кім|қай|мерзім|ауысым|көрсет|бер|жоқ|апта|ай бойы)(\s|\?|$)/i;

/** Language of the question: the answer must be in the same language. */
export function detectLang(text: string): Lang {
  return KAZAKH.test(text) ? "kk" : "ru";
}

// Technical words that must never reach a master: ids, JSON, nulls.
const TECHNICAL = /\b[a-z]+Id\b|\bid\b|\bnull\b|\bundefined\b|\bjson\b|\bfacts\b/i;
// "более 25" where the data says exactly 25: approximations of exact figures are not allowed.
const APPROXIMATE = /(более|свыше|около|примерно|почти|порядка|не менее)\s+\d/i;
// "неясно, кто свободен" while the facts list three people.
const REFUSAL = /неясно|не ясно|не удалось|нет (доступных )?данных|недостаточно данных|не могу|нет информации|не указан/i;

function numbersIn(text: string) {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(",", "."));
}

/** Every number in the answer must come from the facts (or be 0/1): the model must not compute or invent figures. */
function unknownNumbers(text: string, facts: unknown) {
  const allowed = new Set(numbersIn(JSON.stringify(facts)).flatMap((x) => [x, String(Number(x)), String(Math.round(Number(x)))]));
  return numbersIn(text).filter((x) => !allowed.has(x) && !allowed.has(String(Number(x))) && !["0", "1"].includes(x));
}

/** Order numbers are Cyrillic «Н-00513»; the model sometimes writes a Latin N. */
export function normalizeAnswer(text: string) {
  return text.replace(/[\u2010\u2011]/g, "-").replace(/\bN-(\d{3,})/g, "Н-$1").replace(/\s+/g, " ").trim();
}

/** Why an answer cannot be shown, or null when it is fine. */
export function rejectReason(text: string, facts: unknown, lang: Lang, hasData: boolean) {
  if (!text) return "пустой ответ";
  if (TECHNICAL.test(text)) return "служебные поля в ответе";
  if (APPROXIMATE.test(text)) return "приблизительные числа вместо точных";
  const unknown = unknownNumbers(text, facts);
  if (unknown.length) return `числа не из данных: ${unknown.slice(0, 3).join(", ")}`;
  if (hasData && REFUSAL.test(text)) return "отказ при наличии данных";
  if (lang === "kk" && !/[әғқңөұүһі]/i.test(text)) return "ответ не на казахском";
  return null;
}

const RULES = {
  ru: "Отвечай на русском языке.",
  kk: "Отвечай на казахском языке (қазақ тілінде), имена, номера и названия оборудования оставляй как в FACTS."
};

/**
 * Asks the model to phrase `facts` and checks the result; one retry with the reason, then `fallback`.
 * Returns the text and whether it came from the model.
 */
export async function phrase(input: { task: string; question?: string; facts: unknown; lang: Lang; hasData: boolean; fallback: string; key?: string }) {
  const key = input.key ?? "answer";
  const system = `${input.task}
${RULES[input.lang]}
Правила:
- используй только имена, номера, названия и числа из FACTS; ничего не вычисляй и не добавляй от себя;
- называй числа точно, без «более», «около», «примерно»;
- не упоминай идентификаторы, поля и слова FACTS, JSON;
- номера нарядов пиши как в FACTS (кириллицей, «Н-00513»);
- если в FACTS пусто — прямо скажи, что ничего не найдено.
Верни только JSON вида {"${key}": "текст ответа"}.`;
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await askOllama<Record<string, unknown>>(system, JSON.stringify({ question: input.question, FACTS: input.facts }) + feedback);
      const value = raw?.[key];
      const text = typeof value === "string" ? normalizeAnswer(value) : "";
      const reason = rejectReason(text, input.facts, input.lang, input.hasData);
      if (!reason) return { text, fromModel: true };
      feedback = `\nПредыдущий ответ отклонён: ${reason}. Исправь.`;
    } catch (error) {
      // Only a malformed answer is worth a retry; an unavailable model is not.
      if (!(error instanceof SyntaxError)) break;
      feedback = `\nПредыдущий ответ не был JSON вида {"${key}": "текст"}.`;
    }
  }
  return { text: input.fallback, fromModel: false };
}
