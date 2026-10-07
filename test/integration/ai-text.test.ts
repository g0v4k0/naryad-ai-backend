import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { detectLang, normalizeAnswer, phrase, rejectReason } from "../../src/services/ai-text.js";
import { summarizeInsights } from "../../src/services/analytics.js";
import { bearer, insertOrder, seedBase, type Base } from "../helpers/db.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

// Проверка текстов ИИ: модель пересказывает факты, но не может выдумать числа, показать служебные поля или «не найти» данные.
let base: Base;
beforeEach(async () => { base = await seedBase(); });

describe("проверка ответа модели", () => {
  const facts = { наряды: [{ номер: "№Н-00513", просрочен: "45 мин" }], всего: 25 };

  it("отклоняет служебные поля, приблизительные и выдуманные числа, отказ при наличии данных, не тот язык", () => {
    expect(rejectReason("Просрочен №Н-00513 на 45 мин.", facts, "ru", true)).toBeNull();
    expect(rejectReason("", facts, "ru", true)).toBe("пустой ответ");
    expect(rejectReason("Участок (areaId 13): Н-00513", facts, "ru", true)).toBe("служебные поля в ответе");
    expect(rejectReason("Отказов более 25", facts, "ru", true)).toBe("приблизительные числа вместо точных");
    expect(rejectReason("Получено 63 наряда, 85% аварийные", facts, "ru", true)).toBe("числа не из данных: 63, 85");
    expect(rejectReason("Из данных неясно, кто свободен", facts, "ru", true)).toBe("отказ при наличии данных");
    expect(rejectReason("Нет данных", facts, "ru", false)).toBeNull();
    expect(rejectReason("Просрочен Н-00513", facts, "kk", true)).toBe("ответ не на казахском");
    expect(rejectReason("Н-00513 мерзімі өтті, 1 наряд", facts, "kk", true)).toBeNull();
  });

  it("номера нарядов — кириллицей, неразрывный дефис — обычный; язык вопроса", () => {
    expect(normalizeAnswer("Наряд N-00519 и  шифр М‑02")).toBe("Наряд Н-00519 и шифр М-02");
    expect(detectLang("Бос слесарьлар бар ма?")).toBe("kk");
    expect(detectLang("Мерзімі өтіп кеткен наряд қайсы?")).toBe("kk");
    expect(detectLang("Кто свободен из слесарей?")).toBe("ru");
  });

  it("плохой ответ → повтор с причиной; второй плохой → точный шаблон; недоступная модель → без повтора", async () => {
    const replies = [{ answer: "Отказов 63" }, { answer: "Всего 25 нарядов" }];
    mocks.ollama.handler = () => ollamaReply(replies.shift()!);
    expect(await phrase({ task: "t", facts, lang: "ru", hasData: true, fallback: "шаблон" })).toEqual({ text: "Всего 25 нарядов", fromModel: true });
    expect(mocks.ollama.calls[1].body.messages[1].content).toContain("Предыдущий ответ отклонён: числа не из данных: 63");
    mocks.ollama.reset();
    mocks.ollama.handler = () => ollamaReply({ answer: { text: "не строка" } });
    expect(await phrase({ task: "t", facts, lang: "ru", hasData: true, fallback: "шаблон" })).toEqual({ text: "шаблон", fromModel: false });
    expect(mocks.ollama.calls).toHaveLength(2);
    mocks.ollama.reset();
    mocks.ollama.handler = () => ({ status: 503 });
    expect((await phrase({ task: "t", facts, lang: "ru", hasData: true, fallback: "шаблон" })).text).toBe("шаблон");
    expect(mocks.ollama.calls).toHaveLength(1);
    mocks.ollama.reset();
    mocks.ollama.handler = () => ({ text: "не json" });
    expect((await phrase({ task: "t", facts, lang: "ru", hasData: true, fallback: "шаблон", key: "summary" })).text).toBe("шаблон");
    expect(mocks.ollama.calls).toHaveLength(2);
  });
});

describe("ассистент: ответы по фактам", () => {
  const ask = (message: string) => request(app).post("/api/assistant/chat").set(bearer(base.master)).send({ message });
  const scripted = (intent: object, answer: unknown) => {
    mocks.ollama.handler = (body) => body.messages[0].content.startsWith("Определи намерение") ? ollamaReply(intent) : ollamaReply({ answer });
  };

  it("вопрос на казахском → проверенный шаблон на казахском, без вызова модели для ответа", async () => {
    scripted({ intent: "FREE_EXECUTORS", specialty: "Слесарь" }, "3 шеше бар");
    const res = await ask("Бос слесарьлар бар ма?");
    expect(res.body).toMatchObject({ lang: "kk", fromModel: false, answer: "Ауысымда бос (1): Слесарь 1 (слесарь, 5 разряд)." });
    expect(mocks.ollama.calls).toHaveLength(1);
  });

  it("выдуманные числа в истории оборудования → точный шаблон по всей истории, а не по 50 строкам", async () => {
    for (let i = 0; i < 55; i++) await insertOrder(base, { equipmentId: base.conveyor.id, type: i < 44 ? "EMERGENCY" : "PLANNED", faultCodeId: i < 40 ? base.fault.id : null, createdAt: new Date(Date.now() - (i + 1) * 3_600_000) });
    scripted({ intent: "EQUIPMENT_HISTORY", equipmentQuery: "К-3" }, "Конвейер К-3 получил 63 наряда, 85% аварийные");
    const res = await ask("История конвейера К-3");
    expect(res.body.data).toHaveLength(50);
    expect(res.body.fromModel).toBe(false);
    expect(res.body.answer).toMatch(/^Конвейер К-3: 55 нарядов с .+, из них аварийных 44 \(80%\)\. Чаще всего: М-01 «Износ подшипника» — 40\. Последний: №T-/);
    const facts = JSON.parse(mocks.ollama.calls[1].body.messages[1].content).FACTS;
    expect(facts).toMatchObject({ нарядов: 55, аварийных: 44, доля_аварийных_процентов: 80 });
  });

  it("неизвестное оборудование и пустые данные — честный ответ", async () => {
    mocks.ollama.handler = () => ({ status: 503 });
    expect((await ask("История дробилки Х-999")).body.answer).toBe("Оборудование не найдено. Уточните название или номер, например «К-3».");
    expect((await ask("Покажи аномалии")).body.answer).toBe("За квартал аномалий не найдено.");
    expect((await ask("Дай прогноз отказов")).body.answer).toBe("Оборудования в зоне риска нет.");
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - 50 * 60_000) });
    expect((await ask("Что просрочено?")).body.answer).toMatch(/^Просрочено нарядов: 1\. №T-.+ — Насос Н-1, Слесарь 1\., в работе, просрочен на 50 мин\.$/);
  });
});

describe("сводки ИИ", () => {
  const insights = [
    { title: "Насос Н-1: отказы после ППР", description: "4 аварийных наряда за 7 дней после ППР", recommendation: "Проверить ППР", severity: 5 },
    { title: "Конвейер К-3: частые ремонты", description: "12 нарядов", recommendation: "Анализ первопричины", severity: 4 },
    { title: "Аварии чаще в ночную смену", description: "80% ночью", recommendation: "Обходы ночью", severity: 3 }
  ];

  it("сводка аномалий должна назвать главные выводы; обёртка data снимается; плохие рекомендации отбрасываются", async () => {
    mocks.ollama.handler = () => ollamaReply({ data: [{ summary: "Насос Н-1: 4 аварии после ППР. Конвейер К-3: 12 нарядов. Аварии чаще в ночную смену: 80%.", recommendations: ["Проверить ППР насоса Н-1", "Заменить 99 подшипников"] }] });
    expect(await summarizeInsights(insights)).toEqual({ summary: "Насос Н-1: 4 аварии после ППР. Конвейер К-3: 12 нарядов. Аварии чаще в ночную смену: 80%.", recommendations: ["Проверить ППР насоса Н-1"] });
    mocks.ollama.reset();
    mocks.ollama.handler = () => ollamaReply({ summary: "Насос Н-1 отказывает после ППР.", recommendations: ["x"] });
    const partial = await summarizeInsights(insights);
    expect(partial.summary).toMatch(/^Найдено закономерностей: 3\. Насос Н-1: отказы после ППР — 4 аварийных наряда/);
    expect(mocks.ollama.calls).toHaveLength(3);
    expect(mocks.ollama.calls[1].body.messages[1].content).toContain("не упомянуты важные выводы: конвейер к-3, аварии чаще в ночную смену");
  });

  it("сводка смены: цифры всегда точные, модель добавляет только замечание без чисел", async () => {
    await insertOrder(base, { status: "IN_PROGRESS" });
    const figures = "За период выдано 1, закрыто 0, просрочено 0, отклонено 0. Простой оборудования 0 мин, сейчас в простое 0. На смене 2 исполнителей, заняты 1.";
    const shift = async () => (await request(app).get("/api/reports/shift").set(bearer(base.master))).body.aiSummary;
    mocks.ollama.handler = () => ollamaReply({ выдано: 1, простои: { минут: 0 } });
    expect(await shift()).toBe(figures);
    mocks.ollama.handler = () => ollamaReply({ note: "6 из 7 нарядов не выполнены" });
    expect(await shift()).toBe(figures);
    mocks.ollama.handler = () => ollamaReply({ note: "У Слесаря 1. остались невыполненные наряды, а свободных исполнителей можно подключить." });
    expect(await shift()).toBe(`${figures} Обратите внимание: у Слесаря 1. остались невыполненные наряды, а свободных исполнителей можно подключить.`);
    const facts = JSON.parse(mocks.ollama.calls.at(-1)!.body.messages[1].content).FACTS;
    expect(facts).toEqual({ есть_просроченные_наряды: false, есть_отклонённые_наряды: false, оборудование_сейчас_в_простое: false, есть_свободные_исполнители: true, исполнители_с_невыполненными_нарядами: ["Слесарь 1."] });
  });
});
