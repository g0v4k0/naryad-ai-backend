// A/B: same payload as services/ai-review.ts, alternative system prompt with explicit rejection criteria.
import { resultsDir } from "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askOllama } from "../src/services/ollama.js";

const PROMPT_B = `Ты контролёр промышленных ремонтных нарядов горно-обогатительного предприятия. Отвечай только на русском.
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

const cases = JSON.parse(readFileSync(join(resultsDir, "r1-ai-review.json"), "utf8")).filter((r: any) => r.run === 0);
const RUNS = 3;
const rows = [];
for (const c of cases) {
  for (let run = 0; run < RUNS; run++) {
    const payload = {
      problem: c.problem, completed: c.done, equipment: "Оборудование 1", faultCode: "М-01", materials: [], hasAfterPhoto: true,
      photoReview: { score: 4, confidence: 0.55, comment: "Фото отличаются; требуется окончательная проверка мастером", duplicate: false },
      normativeHours: null, actualHours: 2, materialWarnings: [], missing: []
    };
    const t = performance.now();
    let verdict = "ERROR", score = 0, explanation = "";
    try {
      const r = await askOllama<{ verdict: string; score: number; explanation: string }>(PROMPT_B, JSON.stringify(payload));
      ({ verdict, score, explanation } = r);
    } catch (e) { explanation = String(e); }
    const ms = Math.round(performance.now() - t);
    const accepted = verdict !== "REWORK_REQUIRED";
    rows.push({ id: c.id, kind: c.kind, ok: c.ok, run, verdict, score, accepted, correct: accepted === c.ok, ms, explanation });
    console.log(`${c.id}#${run} ${verdict} ${ms}ms ${accepted === c.ok ? "✓" : "✗"}`);
  }
}
writeFileSync(join(resultsDir, "r1b-prompt-ab.json"), JSON.stringify(rows, null, 2));
