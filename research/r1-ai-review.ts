import { resultsDir } from "./env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { reviewWorkOrder } from "../src/services/ai-review.js";
import { scene } from "../test/helpers/images.js";
import { saveUpload } from "../test/helpers/images.js";

// label: true = работу следует принять, false = требуется доработка
const cases: Array<{ id: string; problem: string; done: string; ok: boolean; kind: string }> = [
  { id: "G01", problem: "Шум подшипника насоса", done: "Заменён подшипник 6205 на приводной стороне, произведена центровка муфты, вибрация 2,1 мм/с — в норме, утечек нет", ok: true, kind: "полный отчёт" },
  { id: "G02", problem: "Течь сальника насоса", done: "Заменена сальниковая набивка, подтянута грундбукса, течь устранена, насос проверен под нагрузкой 30 минут", ok: true, kind: "полный отчёт" },
  { id: "G03", problem: "Не включается двигатель конвейера", done: "Обнаружен сгоревший предохранитель в цепи управления, заменён, изоляция двигателя проверена мегаомметром — 500 МОм, конвейер запущен", ok: true, kind: "полный отчёт" },
  { id: "G04", problem: "Сход ленты конвейера", done: "Отрегулированы натяжной и отклоняющий барабаны, заменены 2 роликоопоры, лента идёт по центру на холостом ходу и под нагрузкой", ok: true, kind: "полный отчёт" },
  { id: "G05", problem: "Повышенная вибрация дробилки", done: "Подтянуты анкерные болты рамы, заменены 4 амортизатора, вибрация снизилась с 9 до 3 мм/с", ok: true, kind: "полный отчёт" },
  { id: "G06", problem: "Перегрев редуктора", done: "Заменено масло в редукторе (12 л И-40), очищен сапун, температура после 1 ч работы 58 °C", ok: true, kind: "полный отчёт" },
  { id: "G07", problem: "Плановое ТО насоса", done: "Выполнено ТО-1: осмотр, смазка подшипников, проверка затяжки, замер вибрации и температуры — все параметры в норме", ok: true, kind: "полный отчёт" },
  { id: "G08", problem: "Износ футеровки дробилки", done: "Заменены 6 плит футеровки, выставлен зазор разгрузочной щели 25 мм, дробилка запущена", ok: true, kind: "полный отчёт" },
  { id: "G09", problem: "Срабатывание защиты электродвигателя", done: "Проверены токи по фазам, найден ослабленный контакт в клеммной коробке, контакт зачищен и протянут, токи симметричны, защита больше не срабатывает", ok: true, kind: "полный отчёт" },
  { id: "G10", problem: "Порыв ленты конвейера", done: "Выполнена горячая вулканизация стыка ленты длиной 1,2 м, стык проверен, конвейер в работе", ok: true, kind: "полный отчёт" },
  { id: "G11", problem: "Утечка масла из гидросистемы", done: "Заменён РВД высокого давления и уплотнительные кольца, долито 5 л масла, при рабочем давлении утечек нет", ok: true, kind: "полный отчёт" },
  { id: "G12", problem: "Шум подшипника насоса", done: "Заменил подшипник, шум пропал", ok: true, kind: "краткий, но по существу" },
  { id: "B01", problem: "Шум подшипника насоса", done: "Сделано", ok: false, kind: "пустая отписка" },
  { id: "B02", problem: "Течь сальника насоса", done: "Всё ок", ok: false, kind: "пустая отписка" },
  { id: "B03", problem: "Перегрев редуктора", done: "Работа выполнена", ok: false, kind: "пустая отписка" },
  { id: "B04", problem: "Не включается двигатель конвейера", done: "Не успел, доделаю завтра", ok: false, kind: "работа не выполнена" },
  { id: "B05", problem: "Износ футеровки дробилки", done: "Футеровку не менял, плит нет на складе", ok: false, kind: "работа не выполнена" },
  { id: "B06", problem: "Сход ленты конвейера", done: "Заменил лампочку в бытовке", ok: false, kind: "не относится к задаче" },
  { id: "B07", problem: "Повышенная вибрация дробилки", done: "Посмотрел, вроде нормально", ok: false, kind: "нет действий" },
  { id: "B08", problem: "Сход ленты конвейера", done: "Отрегулировал барабан, но лента продолжает сходить", ok: false, kind: "проблема не устранена" },
  { id: "B09", problem: "Утечка масла из гидросистемы", done: "Долил масло, течь осталась", ok: false, kind: "проблема не устранена" },
  { id: "B10", problem: "Срабатывание защиты электродвигателя", done: "Отключил защиту, двигатель теперь работает", ok: false, kind: "нарушение безопасности" },
  { id: "B11", problem: "Порыв ленты конвейера", done: "asdf jkl", ok: false, kind: "мусор" },
  { id: "B12", problem: "Перегрев редуктора", done: "Залил воду вместо масла, греться перестал", ok: false, kind: "нарушение технологии" }
];
const RUNS = Number(process.env.RUNS ?? 3);

const master = await prisma.user.findUniqueOrThrow({ where: { login: "master" } });
const worker = await prisma.user.findUniqueOrThrow({ where: { login: "worker2" } });
const equipment = await prisma.equipment.findFirstOrThrow();
const fault = await prisma.faultCode.findFirstOrThrow();
const before = await saveUpload("r1-before.jpg", await scene(501));
const rows = [];
for (const c of cases) {
  for (let run = 0; run < RUNS; run++) {
    const after = await saveUpload(`r1-after-${c.id}-${run}.jpg`, await scene(Number(process.env.SEED_OFFSET ?? 1000) + rows.length));
    const order = await prisma.workOrder.create({ data: {
      number: `R1-${c.id}-${run}-${Date.now()}`, type: "PLANNED", description: c.problem, priority: "NORMAL",
      deadline: new Date(Date.now() + 3_600_000), status: "COMPLETED", completionText: c.done, faultCodeId: fault.id,
      startedAt: new Date(Date.now() - 2 * 3_600_000), completedAt: new Date(),
      areaId: equipment.areaId, equipmentId: equipment.id, creatorId: master.id, assigneeId: worker.id,
      photos: { create: [{ type: "BEFORE", fileUrl: before, authorId: worker.id }, { type: "AFTER", fileUrl: after, authorId: worker.id }] }
    } });
    const t = performance.now();
    const a = await reviewWorkOrder(order.id);
    const ms = Math.round(performance.now() - t);
    const accepted = a.verdict !== "REWORK_REQUIRED";
    rows.push({ ...c, run, verdict: a.verdict, score: a.score, accepted, correct: accepted === c.ok, ms, explanation: a.explanation });
    console.log(`${c.id}#${run} ${a.verdict} score=${a.score} ${ms}ms ${accepted === c.ok ? "✓" : "✗"}`);
  }
}
writeFileSync(join(resultsDir, `r1-ai-review${process.env.FORCE_OLLAMA_URL ? "-fallback" : ""}.json`), JSON.stringify(rows, null, 2));
await prisma.$disconnect();
