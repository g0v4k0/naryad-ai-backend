import { resultsDir } from "./env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { prisma } from "../src/lib/prisma.js";
import { reviewWorkOrder } from "../src/services/ai-review.js";
import { learnFromMasterDecision, reindexKnowledge } from "../src/services/rag.js";
import { suggestFaultAndNormative } from "../src/services/recommendations.js";

/**
 * R7. Self-learning through the RAG memory, on the real gpt-oss:20b + bge-m3.
 * A) AI review: 5 plant rules the prompt does not know (masters enforce them). The memory grows
 *    stage by stage — empty, seed history, then 1 / 2 / 4 master decisions per rule — and every stage
 *    is checked on unseen reports of the same rules plus the R1 held-out set (regression control).
 * B) Fault-code suggestion: 28 new problem descriptions, LLM without memory vs LLM + memory vs memory alone.
 */

type Decision = { problem: string; report: string; type: string; accepted: boolean; comment: string };
type Check = { id: string; problem: string; report: string; type: string; ok: boolean; group: string };

const rule = (id: string, comment: string, type: string, train: Array<[string, string, boolean]>, test: Array<[string, string, boolean, string]>) => ({
  id, comment,
  train: train.map(([problem, report, accepted]): Decision => ({ problem, report, accepted, type, comment: accepted ? "Принято" : comment })),
  test: test.map(([problem, report, ok, t], i): Check => ({ id: `${id}-${ok ? "G" : "B"}${i}`, problem, report, ok, type: t, group: id }))
});

// Train order matters: stage "1" takes the first decision of every rule, "2" the first two, "4" all.
const RULES = [
  rule("P1-вибрация", "После замены подшипника обязателен замер вибрации, укажите значение в мм/с", "Насос", [
    ["Гул подшипника насоса", "Заменил подшипник 6312, собрал узел, насос запущен", false],
    ["Гул подшипника насоса", "Заменил подшипник 6312, собрал узел, вибрация 2,3 мм/с, насос в работе", true],
    ["Стук подшипника дробилки", "Подшипник 22320 заменён, смазка заложена, дробилка в работе", false],
    ["Стук подшипника дробилки", "Подшипник 22320 заменён, вибрация после пуска 3,1 мм/с — в норме", true]
  ], [
    ["Шум подшипника вентилятора", "Поменял подшипник, вентилятор крутится ровно", false, "Компрессор"],
    ["Нагрев подшипника барабана сепаратора", "Заменён подшипник барабана, узел набит смазкой, сепаратор запущен", false, "Сепаратор"],
    ["Шум подшипника вентилятора", "Поменял подшипник, виброскорость 1,8 мм/с, вентилятор крутится ровно", true, "Компрессор"],
    ["Нагрев подшипника барабана сепаратора", "Заменён подшипник, после пуска вибрация 2,5 мм/с, температура 45 °C", true, "Сепаратор"]
  ]),
  rule("P2-опрессовка", "После замены РВД обязательна опрессовка рабочим давлением, укажите давление", "Погрузчик", [
    ["Течь масла из РВД погрузчика", "Заменил РВД 3/4, масло долил", false],
    ["Течь масла из РВД погрузчика", "Заменил РВД 3/4, долил масло, опрессовка 180 бар 10 мин — течи нет", true],
    ["Порыв РВД гидросистемы дробилки", "Порванный рукав заменён новым, гидросистема заправлена", false],
    ["Порыв РВД гидросистемы дробилки", "Рукав высокого давления заменён, опрессован на 200 бар, утечек нет", true]
  ], [
    ["Течь из рукава гидроцилиндра вагоноопрокидывателя", "Поставил новый рукав, течь прекратилась", false, "Вагоноопрокидыватель"],
    ["Порыв РВД на питателе", "РВД заменён, система работает", false, "Питатель"],
    ["Течь из рукава гидроцилиндра вагоноопрокидывателя", "Поставил новый рукав, опрессовал 160 бар, течи нет", true, "Вагоноопрокидыватель"],
    ["Порыв РВД на питателе", "РВД заменён, опрессовка рабочим давлением 150 бар выдержана", true, "Питатель"]
  ]),
  rule("P3-контроль шва", "Сварной шов несущей конструкции должен пройти УЗК или капиллярный контроль, укажите результат", "Грохот", [
    ["Трещина рамы грохота", "Трещину разделал, заварил, зачистил", false],
    ["Трещина рамы грохота", "Трещина разделана и заварена, капиллярный контроль шва — дефектов нет", true],
    ["Трещина в корпусе питателя", "Заварил трещину электродами УОНИ, покрасил", false],
    ["Трещина в корпусе питателя", "Трещина заварена УОНИ-13/55, УЗК шва без дефектов, окрашено", true]
  ], [
    ["Трещина металлоконструкции галереи", "Трещину заварили, шов зачищен и окрашен", false, "Конвейер"],
    ["Трещина балки вагоноопрокидывателя", "Сварка выполнена, шов проверил визуально", false, "Вагоноопрокидыватель"],
    ["Трещина металлоконструкции галереи", "Трещину заварили, УЗК шва — без дефектов", true, "Конвейер"],
    ["Трещина балки вагоноопрокидывателя", "Заварил, капиллярный контроль показал отсутствие трещин", true, "Вагоноопрокидыватель"]
  ]),
  rule("P4-мегаомметр", "После работ с двигателем или кабелем обязателен замер сопротивления изоляции мегаомметром", "Конвейер", [
    ["Двигатель конвейера не запускается", "Заменил двигатель на резервный, запустил", false],
    ["Двигатель конвейера не запускается", "Двигатель заменён на резервный, изоляция 500 МОм, пуск в норме", true],
    ["Повреждён кабель питания крана", "Заменил участок кабеля КГ 3×16, кран работает", false],
    ["Повреждён кабель питания крана", "Участок кабеля заменён, сопротивление изоляции мегаомметром 200 МОм, кран работает", true]
  ], [
    ["Перегрев электродвигателя мельницы", "Двигатель перемотан и установлен, пуск нормальный", false, "Мельница"],
    ["Пробой кабеля насоса", "Кабель заменил, насос качает", false, "Насос"],
    ["Перегрев электродвигателя мельницы", "Двигатель после перемотки установлен, изоляция 1000 МОм, пуск нормальный", true, "Мельница"],
    ["Пробой кабеля насоса", "Кабель заменил, мегаомметром 300 МОм, насос качает", true, "Насос"]
  ]),
  rule("P5-масло", "Укажите марку и объём залитого масла", "Классификатор", [
    ["Загрязнение масла редуктора", "Слил старое масло, промыл картер, залил новое, редуктор в работе", false],
    ["Загрязнение масла редуктора", "Слил старое масло, промыл картер, залил 20 л ТАп-15, редуктор в работе", true],
    ["Вода в масле гидросистемы", "Масло слито, бак промыт, залито новое, фильтр заменён", false],
    ["Вода в масле гидросистемы", "Масло слито, бак промыт, залито 40 л И-40А, фильтр заменён", true]
  ], [
    ["Потемнело масло компрессора", "Заменил масло и масляный фильтр, компрессор в работе", false, "Компрессор"],
    ["Масло в редукторе мельницы загрязнено", "Старое масло слили, картер промыли, залили свежее", false, "Мельница"],
    ["Потемнело масло компрессора", "Заменил масло (КС-19, 6 л) и масляный фильтр, компрессор в работе", true, "Компрессор"],
    ["Масло в редукторе мельницы загрязнено", "Старое масло слили, картер промыли, залили 120 л ТАп-15", true, "Мельница"]
  ])
];

// R1 held-out set (research/r1-ai-review.ts): general criteria, must not get worse with the memory.
// HG3 (weld checked only visually) and HG4 (oil replaced, no grade) break rules P3 and P5: once the masters
// teach those rules, "rework" is the right answer there, so charts.py reports them apart from the control.
const CONTROL: Check[] = ([
  ["HG1", "Не запускается насос", "Заменён пускатель КМ1, проверено сопротивление обмоток, насос запущен, давление 4 бар", true],
  ["HG2", "Скрип барабана конвейера", "Заменены подшипники натяжного барабана, барабан выставлен, скрип отсутствует", true],
  ["HG3", "Трещина рамы дробилки", "Трещина разделана и заварена электродами УОНИ, шов зачищен, проверен визуально и молотком", true],
  ["HG4", "Плановая ревизия редуктора", "Вскрыт редуктор, зацепление в норме, заменены прокладки и масло, утечек нет", true],
  ["HG5", "Нет освещения на галерее", "Поменял два прожектора, свет есть", true],
  ["HG6", "Пробуксовка ленты", "Подтянул натяжку, буксовки нет", true],
  ["HB1", "Не запускается насос", "Готово", false],
  ["HB2", "Скрип барабана конвейера", "Смазал, скрип остался, нужен подшипник", false],
  ["HB3", "Трещина рамы дробилки", "Нет сварщика, перенёс на следующую смену", false],
  ["HB4", "Срабатывает концевик ленты", "Замкнул концевик накоротко, лента работает", false],
  ["HB5", "Перегрев двигателя", "Покрасил ограждение", false],
  ["HB6", "Плановая ревизия редуктора", "Проверил снаружи, вроде норм", false]
] as Array<[string, string, string, boolean]>).map(([id, problem, report, ok]) => ({ id, problem, report, ok, type: "Насос", group: "R1-контроль" }));

const RUNS = Number(process.env.RUNS ?? 2);
const EMBED_MODEL = config.OLLAMA_EMBED_MODEL;
const master = await prisma.user.findFirstOrThrow({ where: { role: "MASTER" } });
const worker = await prisma.user.findFirstOrThrow({ where: { role: "EXECUTOR" } });
const equipmentOf = async (type: string) => (await prisma.equipment.findFirst({ where: { type } })) ?? prisma.equipment.findFirstOrThrow();
const tag = Date.now();
let seq = 0;

async function order(problem: string, report: string, type: string, status: "COMPLETED" | "CLOSED" | "REWORK", faultCodeId?: number | null) {
  const equipment = await equipmentOf(type);
  return prisma.workOrder.create({ data: {
    number: `R7-${tag}-${seq++}`, type: "PLANNED", description: problem, priority: "NORMAL", deadline: new Date(Date.now() + 3_600_000),
    status, completionText: report, faultCodeId: faultCodeId === undefined ? (await prisma.faultCode.findFirstOrThrow()).id : faultCodeId,
    startedAt: new Date(Date.now() - 2 * 3_600_000), completedAt: new Date(),
    areaId: equipment.areaId, equipmentId: equipment.id, creatorId: master.id, assigneeId: worker.id
  } });
}

/** A master decision as it arrives from the API: the AI accepted, the master decided (and said why). */
async function teach(d: Decision) {
  // No fault code: these decisions teach the review only and must not leak into the fault-code memory (part B).
  const o = await order(d.problem, d.report, d.type, d.accepted ? "CLOSED" : "REWORK", null);
  await prisma.aiAssessment.create({ data: { workOrderId: o.id, verdict: "ACCEPTED", score: 4, explanation: "AI", rawResponse: {}, masterScore: d.accepted ? 5 : null, masterComment: d.accepted ? d.comment : null } });
  if (!d.accepted) await prisma.workOrderEvent.create({ data: { workOrderId: o.id, actorId: master.id, action: "SEND_TO_REWORK", fromStatus: "AI_REVIEW", toStatus: "REWORK", comment: d.comment } });
  await learnFromMasterDecision(o.id);
  return o.id;
}

async function runPart(part: "review" | "fault") {
  // Orders of earlier (also interrupted) runs would leak into the "history" memory through reindex; children cascade.
  await prisma.workOrder.deleteMany({ where: { number: { startsWith: "R7-" } } });
  await prisma.knowledgeCase.deleteMany();
  if (part === "review") {
    const trainOrders = new Map<number, string>();
    const stages: Array<{ name: string; prepare: () => Promise<void> }> = [
      { name: "без памяти", prepare: async () => { config.OLLAMA_EMBED_MODEL = ""; } },
      { name: "история завода", prepare: async () => { config.OLLAMA_EMBED_MODEL = EMBED_MODEL; console.log("reindex", await reindexKnowledge()); } },
      ...[1, 2, 4].map((n, i, all) => ({
        name: `+${n} решения мастера на правило`,
        prepare: async () => {
          const from = i ? all[i - 1] : 0;
          for (const r of RULES) for (const d of r.train.slice(from, n)) trainOrders.set(await teach(d), r.id);
        }
      }))
    ];
    const rows = [];
    for (const stage of stages) {
      await stage.prepare();
      const memory = await prisma.knowledgeCase.count({ where: { kind: "REVIEW" } });
      for (const c of [...RULES.flatMap((r) => r.test), ...CONTROL]) {
        for (let run = 0; run < RUNS; run++) {
          const o = await order(c.problem, c.report, c.type, "COMPLETED");
          const t = performance.now();
          const a = await reviewWorkOrder(o.id);
          const ms = Math.round(performance.now() - t);
          const rag = ((a.rawResponse as { rag?: Array<{ workOrderId: number; similarity: number; accepted: boolean }> }).rag) ?? [];
          const accepted = a.verdict !== "REWORK_REQUIRED";
          rows.push({
            stage: stage.name, memory, ...c, run, verdict: a.verdict, accepted, correct: accepted === c.ok, ms, needsMasterReview: a.needsMasterReview,
            precedents: rag.length, topRule: rag[0] ? trainOrders.get(rag[0].workOrderId) ?? "история" : null, topSimilarity: rag[0]?.similarity ?? null, explanation: a.explanation
          });
          console.log(`[${stage.name}] ${c.id}#${run} ${a.verdict} prec=${rag.length} ${ms}ms ${accepted === c.ok ? "✓" : "✗"}`);
        }
      }
    }
    writeFileSync(join(resultsDir, "r7-rag-review.json"), JSON.stringify(rows, null, 2));
  } else {
    const codes = new Map((await prisma.faultCode.findMany()).map((x) => [x.code, x.id]));
    const byId = new Map([...codes].map(([code, id]) => [id, code]));
    // New wording, not seed phrases; expected = the code the plant uses for such failures in its history.
    const cases: Array<[string, string, string]> = [
      ["Подшипник гудит и греется на приводе", "Конвейер", "М-02"], ["Узел подшипника стучит, температура 80 градусов", "Дробилка", "М-02"],
      ["Рама ходуном ходит, болты ослабли", "Грохот", "М-05"], ["Сильно трясёт раму питателя", "Питатель", "М-05"],
      ["Отвалилась бронеплита", "Мельница", "М-01"], ["Стучит футеровка в барабане", "Мельница", "М-01"],
      ["Лента порвалась на стыке", "Конвейер", "М-03"], ["Ролики не крутятся, лента уходит в сторону", "Конвейер", "М-06"],
      ["Шестерни редуктора стучат", "Классификатор", "М-04"], ["Трещина в раме вибропитателя", "Питатель", "М-07"],
      ["Двигатель греется и отключается", "Насос", "Э-01"], ["Пропало питание на приводе сепаратора", "Сепаратор", "Э-02"],
      ["Автомат выбивает при пуске", "Сгуститель", "Э-03"], ["Датчик скорости не даёт сигнал", "Конвейер", "Э-04"],
      ["Кабель крана повреждён, пробой на корпус", "Кран", "Э-05"], ["Течёт масло из шланга высокого давления", "Погрузчик", "Г-01"],
      ["Гидравлика не держит давление, насос не качает", "Погрузчик", "Г-02"], ["Подтекает сальник насоса", "Насос", "Г-03"],
      ["Шипит воздух в пневмолинии", "Компрессор", "П-01"], ["Цилиндр не дожимает ход", "Погрузчик", "П-02"],
      ["Пневмоклапан травит", "Компрессор", "П-03"], ["Скрип, узел сухой", "Сепаратор", "С-01"],
      ["В масле вода, оно мутное", "Насос", "С-02"], ["Станция смазки не подаёт смазку", "Мельница", "С-03"],
      ["Двигатель не стартует, выбивает защиту", "Конвейер", "Э-01"], ["Вибрация, подшипник горячий", "Грохот", "М-02"],
      ["Перегрев узла, смазки нет", "Дробилка", "С-01"], ["Нет сигнала с датчика", "Погрузчик", "Э-04"]
    ];
    console.log("reindex", await reindexKnowledge());
    const rows = [];
    const model = config.OLLAMA_MODEL;
    const conditions: Array<{ name: string; runs: number; set: () => void }> = [
      { name: "LLM без памяти", runs: RUNS, set: () => { config.OLLAMA_EMBED_MODEL = ""; config.OLLAMA_MODEL = model; } },
      { name: "LLM + память", runs: RUNS, set: () => { config.OLLAMA_EMBED_MODEL = EMBED_MODEL; config.OLLAMA_MODEL = model; } },
      // Unknown chat model → the LLM call fails → the similarity-weighted vote of the memory decides.
      { name: "только память (LLM недоступна)", runs: 1, set: () => { config.OLLAMA_EMBED_MODEL = EMBED_MODEL; config.OLLAMA_MODEL = "no-such-model"; } }
    ];
    for (const condition of conditions) {
      condition.set();
      for (const [description, type, expected] of cases) {
        for (let run = 0; run < condition.runs; run++) {
          const equipment = await equipmentOf(type);
          const t = performance.now();
          const s = await suggestFaultAndNormative(description, equipment.id);
          const ms = Math.round(performance.now() - t);
          const got = s.faultCodeId ? byId.get(s.faultCodeId) ?? null : null;
          rows.push({ condition: condition.name, description, type, expected, got, correct: got === expected, basedOn: s.basedOn, run, ms });
          console.log(`[${condition.name}] ${description} → ${got} (${expected}) ${got === expected ? "✓" : "✗"} ${ms}ms`);
        }
      }
    }
    config.OLLAMA_MODEL = model;
    writeFileSync(join(resultsDir, "r7-rag-fault.json"), JSON.stringify(rows, null, 2));
  }
}

for (const part of (process.env.PART ?? "review,fault").split(",") as Array<"review" | "fault">) await runPart(part);
await prisma.knowledgeCase.deleteMany();
await prisma.$disconnect();
