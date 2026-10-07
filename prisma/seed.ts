import "dotenv/config";
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { hashPassword } from "../src/lib/password.js";
import { AiVerdict, EmployeeStatus, Prisma, Priority, PrismaClient, Role, WorkOrderStatus, WorkType } from "@prisma/client";

/**
 * Demo plant for the case (section 8): 4 areas, 25 equipment units, 2 masters, 15 executors in 3 brigades,
 * 21 fault codes, 40 materials, normatives and 90 days of history (500+ orders) with planted patterns:
 *  1. Конвейер К-3 breaks ~3× more often than the rest, mostly with М-02 (bearing) — frequent + repeated fault;
 *  2. Жумабаев Д. — after his repairs the same fault returns within 7 days — executor repeat failures;
 *  3. Насос ГрАТ 1400/40 fails 4 times within days after every planned maintenance — quality of ППР;
 *  4. Мельница МШЦ-4500 — liner bolts written off far above the usual — material anomaly;
 *  5. Most breakdowns happen at night, peak 00:00–06:00 — shift / time-of-day dependency.
 * Plus a live shift for the demo: orders in progress, one overdue with a comment, free fitters on shift.
 */

const prisma = new PrismaClient();
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const PLANT_UTC_OFFSET_HOURS = 5; // Asia/Qostanay

// Deterministic pseudo-random numbers: the same history on every seed.
let state = 20261016;
const rnd = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(items: readonly T[]) => items[Math.floor(rnd() * items.length)];
const between = (min: number, max: number) => min + rnd() * (max - min);

const AREAS = ["Дробление", "Обогащение", "Ремонтно-механический цех", "Склад и транспорт"] as const;

// [name, inventory, type, criticality 1..5, area index]
const EQUIPMENT: Array<[string, string, string, number, number]> = [
  ["Дробилка ККД-1500 (Д-1)", "INV-1001", "Дробилка", 5, 0],
  ["Дробилка КМД-1750 (Д-2)", "INV-1002", "Дробилка", 5, 0],
  ["Дробилка КСД-2200 (Д-3)", "INV-1003", "Дробилка", 4, 0],
  ["Конвейер К-1", "INV-1011", "Конвейер", 4, 0],
  ["Конвейер К-2", "INV-1012", "Конвейер", 4, 0],
  ["Конвейер К-3", "INV-1013", "Конвейер", 5, 0],
  ["Питатель пластинчатый П-1", "INV-1021", "Питатель", 3, 0],
  ["Грохот ГИТ-71 (Г-1)", "INV-1031", "Грохот", 3, 0],
  ["Мельница МШЦ-4500 (М-1)", "INV-2001", "Мельница", 5, 1],
  ["Мельница МШЦ-3600 (М-2)", "INV-2002", "Мельница", 5, 1],
  ["Классификатор КСН-24 (КЛ-1)", "INV-2011", "Классификатор", 3, 1],
  ["Гидроциклон ГЦ-710 (ГЦ-1)", "INV-2021", "Гидроциклон", 3, 1],
  ["Сепаратор ПБМ-120 (С-1)", "INV-2031", "Сепаратор", 4, 1],
  ["Сепаратор ПБМ-90 (С-2)", "INV-2032", "Сепаратор", 4, 1],
  ["Насос ГрАТ 1400/40 (Н-1)", "INV-2041", "Насос", 4, 1],
  ["Насос ГрАТ 700/40 (Н-2)", "INV-2042", "Насос", 4, 1],
  ["Сгуститель П-30 (СГ-1)", "INV-2051", "Сгуститель", 3, 1],
  ["Станок токарный 16К20 (ТС-1)", "INV-3001", "Станок", 2, 2],
  ["Кран мостовой 20 т (КР-1)", "INV-3011", "Кран", 4, 2],
  ["Компрессор ВК-30 (КМ-1)", "INV-3021", "Компрессор", 3, 2],
  ["Сварочный пост ВДМ-1202 (СВ-1)", "INV-3031", "Сварочный пост", 2, 2],
  ["Погрузчик ТО-18 (ПГ-1)", "INV-4001", "Погрузчик", 3, 3],
  ["Конвейер склада К-7", "INV-4011", "Конвейер", 3, 3],
  ["Вагоноопрокидыватель ВРС-125 (ВО-1)", "INV-4021", "Вагоноопрокидыватель", 4, 3],
  ["Насос дренажный ГНОМ 50-25 (Н-3)", "INV-4031", "Насос", 2, 3]
];

// [code, name, category]
const FAULT_CODES: Array<[string, string, string]> = [
  ["М-01", "Износ футеровки / бронеплит", "М"], ["М-02", "Разрушение подшипника", "М"], ["М-03", "Порыв конвейерной ленты", "М"],
  ["М-04", "Износ зубчатой передачи", "М"], ["М-05", "Ослабление крепежа, вибрация", "М"], ["М-06", "Износ роликоопор", "М"],
  ["М-07", "Трещина металлоконструкции", "М"],
  ["Э-01", "Отказ электродвигателя", "Э"], ["Э-02", "Обрыв цепи питания", "Э"], ["Э-03", "Отказ пускателя / автомата", "Э"],
  ["Э-04", "Неисправность датчика", "Э"], ["Э-05", "Пробой изоляции кабеля", "Э"],
  ["Г-01", "Течь масла, повреждение РВД", "Г"], ["Г-02", "Отказ гидронасоса", "Г"], ["Г-03", "Течь сальника / уплотнения", "Г"],
  ["П-01", "Утечка сжатого воздуха", "П"], ["П-02", "Отказ пневмоцилиндра", "П"], ["П-03", "Неисправность пневмоклапана", "П"],
  ["С-01", "Недостаток смазки, перегрев узла", "С"], ["С-02", "Загрязнение масла", "С"], ["С-03", "Отказ системы смазки", "С"]
];

const MATERIALS: Array<[string, string]> = [
  ["Подшипник 22320", "шт"], ["Подшипник 3636", "шт"], ["Подшипник 6312", "шт"], ["Подшипник 1318", "шт"],
  ["Лента конвейерная 1200 мм", "м"], ["Ролик конвейерный 133 мм", "шт"], ["Клей для стыковки лент", "кг"],
  ["Масло индустриальное И-40А", "л"], ["Масло трансмиссионное ТАп-15", "л"], ["Смазка Литол-24", "кг"], ["Смазка ЦИАТИМ-203", "кг"],
  ["Сальниковая набивка АП-31", "кг"], ["Манжета уплотнительная", "шт"], ["Кольцо уплотнительное", "шт"],
  ["РВД 1/2\"", "шт"], ["РВД 3/4\"", "шт"], ["Болт футеровочный М36", "шт"], ["Плита футеровочная", "шт"], ["Броня дробилки", "шт"],
  ["Электроды УОНИ-13/55", "кг"], ["Проволока сварочная Св-08Г2С", "кг"], ["Кабель ВВГ 3×2,5", "м"], ["Кабель КГ 3×16", "м"],
  ["Автоматический выключатель 63 А", "шт"], ["Пускатель ПМЛ-2100", "шт"], ["Контактор КТ-6023", "шт"], ["Датчик температуры ТСМ", "шт"],
  ["Датчик скорости ДКС", "шт"], ["Изолента ПВХ", "шт"], ["Термоусадочная трубка", "м"], ["Ремень клиновой В-2240", "шт"],
  ["Муфта упругая МУВП", "шт"], ["Шпонка 22×14", "шт"], ["Фильтр масляный", "шт"], ["Пневмоцилиндр", "шт"], ["Клапан пневматический", "шт"],
  ["Шланг пневматический 16 мм", "м"], ["Ветошь", "кг"], ["Растворитель", "л"], ["Эмаль ПФ-115", "кг"]
];

// Typical repair per fault: [hours, materials with normal quantity, report text]
const REPAIRS: Record<string, [number, Array<[string, number]>, string]> = {
  "М-01": [6, [["Болт футеровочный М36", 24], ["Плита футеровочная", 4]], "Заменены изношенные плиты футеровки, болты протянуты динамометрическим ключом, проверен зазор"],
  "М-02": [3, [["Подшипник 22320", 2], ["Смазка Литол-24", 1]], "Заменён подшипник, узел промыт и заполнен смазкой, проверены нагрев и вибрация на холостом ходу"],
  "М-03": [5, [["Лента конвейерная 1200 мм", 12], ["Клей для стыковки лент", 3]], "Вырезан повреждённый участок ленты, выполнена стыковка, натяжение отрегулировано, лента центрирована"],
  "М-04": [8, [["Масло трансмиссионное ТАп-15", 20], ["Шпонка 22×14", 1]], "Заменена изношенная шестерня, выставлено зацепление, редуктор залит свежим маслом"],
  "М-05": [2, [["Ветошь", 1]], "Подтянуты ослабленные болтовые соединения рамы, вибрация после пуска в норме"],
  "М-06": [3, [["Ролик конвейерный 133 мм", 4]], "Заменены заклинившие ролики роликоопор, проверен ход ленты"],
  "М-07": [4, [["Электроды УОНИ-13/55", 3], ["Эмаль ПФ-115", 1]], "Трещина разделана и заварена, шов зачищен и окрашен"],
  "Э-01": [5, [["Подшипник 6312", 2], ["Кабель КГ 3×16", 5]], "Электродвигатель заменён на резервный, проверено сопротивление изоляции мегаомметром, пуск в норме"],
  "Э-02": [2, [["Кабель ВВГ 3×2,5", 10], ["Термоусадочная трубка", 2]], "Найден и устранён обрыв в цепи питания, соединение изолировано"],
  "Э-03": [1.5, [["Пускатель ПМЛ-2100", 1]], "Заменён неисправный пускатель, проверена работа схемы управления"],
  "Э-04": [1.5, [["Датчик скорости ДКС", 1]], "Заменён датчик, выполнена настройка и проверка срабатывания"],
  "Э-05": [3, [["Кабель КГ 3×16", 15], ["Изолента ПВХ", 2]], "Повреждённый участок кабеля заменён, изоляция проверена мегаомметром"],
  "Г-01": [2, [["РВД 3/4\"", 1], ["Масло индустриальное И-40А", 10]], "Заменён повреждённый РВД, долито масло, течь устранена, проверено под давлением"],
  "Г-02": [6, [["Масло индустриальное И-40А", 40], ["Фильтр масляный", 1]], "Гидронасос заменён, система промыта, заменён фильтр, давление в норме"],
  "Г-03": [2, [["Сальниковая набивка АП-31", 1], ["Манжета уплотнительная", 2]], "Заменена сальниковая набивка и манжеты, течь устранена"],
  "П-01": [1, [["Шланг пневматический 16 мм", 3]], "Заменён повреждённый участок пневмошланга, утечка устранена"],
  "П-02": [2, [["Пневмоцилиндр", 1]], "Заменён пневмоцилиндр, отрегулирован ход"],
  "П-03": [1, [["Клапан пневматический", 1]], "Заменён пневмоклапан, проверено срабатывание"],
  "С-01": [1, [["Смазка Литол-24", 2]], "Узел очищен и смазан, температура после пуска в норме"],
  "С-02": [2, [["Масло индустриальное И-40А", 20], ["Фильтр масляный", 1]], "Масло заменено, фильтр заменён"],
  "С-03": [3, [["Смазка ЦИАТИМ-203", 2], ["Шланг пневматический 16 мм", 2]], "Восстановлена подача смазки к узлам, проверена работа станции"]
};

// Faults typical for each equipment type.
const TYPE_FAULTS: Record<string, string[]> = {
  "Дробилка": ["М-01", "М-02", "М-04", "Г-01", "Э-01", "С-01", "М-05"],
  "Конвейер": ["М-02", "М-03", "М-06", "Э-01", "Э-04", "М-05"],
  "Питатель": ["М-05", "М-07", "Г-01", "Э-03", "С-01"],
  "Грохот": ["М-02", "М-05", "М-07", "Э-01", "С-01"],
  "Мельница": ["М-01", "М-02", "М-04", "С-03", "Э-01", "Г-03"],
  "Классификатор": ["М-04", "М-05", "Э-03", "С-01"],
  "Гидроциклон": ["М-01", "Г-03", "Э-04", "М-05"],
  "Сепаратор": ["М-02", "Э-02", "Э-04", "М-05", "С-01"],
  "Насос": ["Г-03", "М-02", "Э-01", "Г-01", "С-02"],
  "Сгуститель": ["М-04", "Э-03", "Г-01", "С-01"],
  "Станок": ["Э-03", "М-04", "С-02", "Э-02"],
  "Кран": ["Э-03", "Э-05", "М-02", "М-05"],
  "Компрессор": ["П-01", "П-03", "С-02", "Э-01"],
  "Сварочный пост": ["Э-02", "Э-05", "Э-03"],
  "Погрузчик": ["Г-01", "Г-02", "Э-04", "П-02"],
  "Вагоноопрокидыватель": ["Г-01", "Г-02", "М-07", "Э-03", "П-02"]
};

const PROBLEMS: Record<string, string[]> = {
  "М-01": ["Сильный износ футеровки, стук при работе", "Отвалилась плита футеровки"],
  "М-02": ["Гул и нагрев подшипникового узла", "Повышенная вибрация, подшипник греется", "Заклинило подшипник, стук"],
  "М-03": ["Порыв ленты на стыке", "Продольный порез ленты"],
  "М-04": ["Шум в редукторе, стук шестерён", "Износ зубьев, рывки при работе"],
  "М-05": ["Сильная вибрация рамы", "Ослабли болты крепления"],
  "М-06": ["Заклинили ролики, лента сходит", "Посторонний звук роликоопор"],
  "М-07": ["Трещина на раме", "Трещина в корпусе питателя"],
  "Э-01": ["Двигатель не запускается, срабатывает защита", "Перегрев электродвигателя"],
  "Э-02": ["Нет питания на приводе", "Пропадает питание"],
  "Э-03": ["Не включается пускатель", "Выбивает автомат"],
  "Э-04": ["Ложные срабатывания датчика", "Нет сигнала с датчика скорости"],
  "Э-05": ["Пробой кабеля, срабатывает защита", "Повреждён кабель питания"],
  "Г-01": ["Течь масла из гидросистемы", "Порыв РВД, течь масла"],
  "Г-02": ["Падение давления в гидросистеме", "Гидронасос не создаёт давление"],
  "Г-03": ["Течь через сальник", "Течь по уплотнению вала"],
  "П-01": ["Утечка воздуха, шипение", "Падает давление в пневмосети"],
  "П-02": ["Пневмоцилиндр не отрабатывает ход", "Залипание пневмоцилиндра"],
  "П-03": ["Не срабатывает пневмоклапан", "Клапан травит воздух"],
  "С-01": ["Перегрев узла, нет смазки", "Сухой ход, скрип"],
  "С-02": ["Масло загрязнено, потемнело", "Вода в масле"],
  "С-03": ["Не работает станция смазки", "Нет подачи смазки к узлам"]
};

const SPECIALTY_BY_CATEGORY: Record<string, string> = { "М": "Слесарь", "Г": "Слесарь", "П": "Слесарь", "С": "Слесарь", "Э": "Электрик" };

// [full name, specialty, grade, brigade index, on shift]
const EXECUTORS: Array<[string, string, number, number, boolean]> = [
  ["Ахметов Ерлан Серикович", "Слесарь", 6, 0, true],
  ["Жумабаев Данияр Ерланович", "Слесарь", 4, 0, true],
  ["Петров Андрей Викторович", "Электрик", 5, 0, true],
  ["Сагинтаев Нурлан Маратович", "Сварщик", 5, 0, false],
  ["Ким Вадим Олегович", "Слесарь", 5, 0, true],
  ["Оспанов Бауыржан Канатович", "Слесарь", 5, 1, true],
  ["Иванов Сергей Николаевич", "Электрик", 6, 1, true],
  ["Тулегенов Арман Болатович", "Слесарь", 4, 1, true],
  ["Мухамеджанов Ержан Талгатович", "Сварщик", 4, 1, true],
  ["Шевченко Олег Петрович", "Электрик", 4, 1, false],
  ["Касымов Руслан Айдарович", "Слесарь", 5, 2, true],
  ["Абдрахманов Тимур Нурланович", "Электрик", 5, 2, true],
  ["Литвиненко Игорь Васильевич", "Слесарь", 3, 2, false],
  ["Есенов Медет Жанатович", "Сварщик", 6, 2, false],
  ["Смагулов Айбек Кайратович", "Электрик", 3, 2, false]
];
const WEAK_EXECUTOR = "Жумабаев Данияр Ерланович";

const STAFF: Array<[string, string, Role, string]> = [
  ["master", "+77000000001", Role.MASTER, "Нурланов Арман Болатович"],
  ["manager", "+77000000002", Role.MANAGER, "Исмаилов Тимур Кайратович"],
  ["admin", "+77000000003", Role.ADMIN, "Администратор системы"],
  ["master2", "+77000000004", Role.MASTER, "Ковалёв Сергей Петрович"]
];

/** A time of day for a breakdown: half of them between 00:00 and 06:00, ~80% at night. */
function breakdownHour() {
  const r = rnd();
  if (r < 0.5) return between(0, 6);
  if (r < 0.82) return rnd() < 0.67 ? between(20, 24) : between(6, 8);
  return between(8, 20);
}

/** UTC timestamp for a plant-local hour on the day `daysAgo` before now. */
function atLocal(now: number, daysAgo: number, hour: number) {
  const localMidnight = Math.floor((now + PLANT_UTC_OFFSET_HOURS * HOUR) / DAY) * DAY - PLANT_UTC_OFFSET_HOURS * HOUR;
  return localMidnight - daysAgo * DAY + hour * HOUR;
}

type Draft = {
  number: string; type: WorkType; priority: Priority; equipment: number; fault: string | null; createdAt: number; executor: string;
  description: string; status: WorkOrderStatus; spike?: boolean; reworked?: boolean; rejected?: string; master: number;
};

async function main() {
  for (const model of ["assistantMessage", "pushDevice", "anomalyInsight", "notification", "aiAssessment", "materialUsage", "photo", "workOrderEvent", "equipmentDowntime", "integrationJob", "integrationMapping", "workOrder", "user", "brigade", "materialNorm", "workNormative", "equipment", "area", "faultCode", "material"] as const) {
    await (prisma[model] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }

  const areas: Array<{ id: number }> = [];
  for (const name of AREAS) areas.push(await prisma.area.create({ data: { name } }));
  const equipment: Array<{ id: number }> = [];
  for (const [name, inventoryNumber, type, criticality, area] of EQUIPMENT) equipment.push(await prisma.equipment.create({ data: { name, inventoryNumber, type, criticality, areaId: areas[area].id } }));
  const brigades: Array<{ id: number }> = [];
  for (const name of ["Бригада №1", "Бригада №2", "Бригада №3"]) brigades.push(await prisma.brigade.create({ data: { name } }));
  const faultCodes = new Map<string, number>();
  for (const [code, name, category] of FAULT_CODES) faultCodes.set(code, (await prisma.faultCode.create({ data: { code, name, category } })).id);
  const materials = new Map<string, { id: number }>();
  for (const [name, unit] of MATERIALS) materials.set(name, await prisma.material.create({ data: { name, unit } }));

  // Normatives: every typical repair per equipment type, plus planned maintenance per type.
  const normatives = new Map<string, { id: number; hours: number }>();
  for (const [type, faults] of Object.entries(TYPE_FAULTS)) {
    for (const code of faults) {
      const [hours, items] = REPAIRS[code];
      const normative = await prisma.workNormative.create({ data: {
        name: `${FAULT_CODES.find((x) => x[0] === code)![1]}: ${type.toLowerCase()}`, equipmentType: type, faultCodeId: faultCodes.get(code), hours,
        materialNorms: { create: items.map(([material, quantity]) => ({ materialId: materials.get(material)!.id, quantity })) }
      } });
      normatives.set(`${type}:${code}`, { id: normative.id, hours });
    }
    const ppr = await prisma.workNormative.create({ data: {
      name: `Плановое ТО (ППР): ${type.toLowerCase()}`, equipmentType: type, hours: 4,
      materialNorms: { create: [{ materialId: materials.get("Смазка Литол-24")!.id, quantity: 2 }, { materialId: materials.get("Ветошь")!.id, quantity: 1 }] }
    } });
    normatives.set(`${type}:PPR`, { id: ppr.id, hours: 4 });
  }

  // Users. Without SEED_PASSWORD every account gets its own random 6-digit password.
  const credentials: string[] = [];
  const passwordFor = async () => {
    const password = process.env.SEED_PASSWORD ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
    return { password, hash: await hashPassword(password) };
  };
  const staff = new Map<string, { id: number }>();
  for (const [login, phone, role, fullName] of STAFF) {
    const { password, hash } = await passwordFor();
    staff.set(login, await prisma.user.create({ data: { login, phone, passwordHash: hash, fullName, role, isOnShift: true, employeeStatus: EmployeeStatus.AVAILABLE } }));
    credentials.push(`${phone}  ${password}  ${role.padEnd(8)}  ${login.padEnd(8)}  ${fullName}`);
  }
  const executors = new Map<string, { id: number; specialty: string; brigadeId: number; isOnShift: boolean }>();
  for (const [index, [fullName, specialty, grade, brigade, onShift]] of EXECUTORS.entries()) {
    const login = `worker${index + 1}`, phone = `+770000001${String(index + 1).padStart(2, "0")}`;
    const { password, hash } = await passwordFor();
    const user = await prisma.user.create({ data: {
      login, phone, passwordHash: hash, fullName, role: Role.EXECUTOR, specialty, grade, brigadeId: brigades[brigade].id,
      isOnShift: onShift, employeeStatus: onShift ? EmployeeStatus.AVAILABLE : EmployeeStatus.OFF_SHIFT
    } });
    executors.set(fullName, { id: user.id, specialty, brigadeId: user.brigadeId!, isOnShift: onShift });
    credentials.push(`${phone}  ${password}  EXECUTOR  ${login.padEnd(8)}  ${fullName}`);
  }
  const masters = [staff.get("master")!.id, staff.get("master2")!.id];
  const bySpecialty = (specialty: string) => [...executors.entries()].filter(([, x]) => x.specialty === specialty).map(([name]) => name);

  /* ───── History: 90 days ───── */
  const now = Date.now();
  const drafts: Draft[] = [];
  let seq = 0;
  const addFailure = (equipmentIndex: number, createdAt: number, fault: string, executor?: string) => {
    const specialty = fault === "М-07" ? "Сварщик" : SPECIALTY_BY_CATEGORY[fault[0]];
    const draft: Draft = {
      number: `Н-${String(++seq).padStart(5, "0")}`, type: WorkType.EMERGENCY, priority: rnd() < 0.55 ? Priority.EMERGENCY : Priority.HIGH,
      equipment: equipmentIndex, fault, createdAt, executor: executor ?? pick(bySpecialty(specialty)),
      description: `${pick(PROBLEMS[fault])}. ${EQUIPMENT[equipmentIndex][0]}`, status: WorkOrderStatus.CLOSED, master: pick(masters)
    };
    drafts.push(draft);
    return draft;
  };
  const K3 = EQUIPMENT.findIndex((x) => x[0] === "Конвейер К-3");
  const PUMP = EQUIPMENT.findIndex((x) => x[0].startsWith("Насос ГрАТ 1400"));
  const MILL = EQUIPMENT.findIndex((x) => x[0].startsWith("Мельница МШЦ-4500"));

  let pumpFaults = 0;
  for (const [index, [, , type]] of EQUIPMENT.entries()) {
    // Planned maintenance: monthly; the pump every two weeks (pattern 3).
    const pprEvery = index === PUMP ? 15 : 30;
    for (let daysAgo = 88 - Math.floor(rnd() * 10); daysAgo > 2; daysAgo -= pprEvery) {
      const createdAt = atLocal(now, daysAgo, between(8.5, 11));
      drafts.push({ number: `Н-${String(++seq).padStart(5, "0")}`, type: WorkType.PLANNED, priority: Priority.PLANNED, equipment: index, fault: null, createdAt,
        executor: pick(bySpecialty("Слесарь")), description: `Плановое ТО (ППР): ${EQUIPMENT[index][0]}`, status: WorkOrderStatus.CLOSED, master: pick(masters) });
      // Pattern 3: the pump fails 1–4 days after each planned maintenance.
      if (index === PUMP) for (let i = 0; i < 4; i++) {
        const failedAt = atLocal(now, Math.round((now - createdAt) / DAY) - 1 - Math.floor(rnd() * 4), breakdownHour());
        if (failedAt < now - 1.5 * DAY) addFailure(index, failedAt, TYPE_FAULTS[type][(pumpFaults++) % TYPE_FAULTS[type].length]);
      }
    }
    if (index === PUMP) continue;
    // Pattern 1: К-3 breaks about three times as often, 70% bearing failures.
    const failures = index === K3 ? 45 : 13 + Math.floor(rnd() * 5);
    // Faults rotate through the type's list: no code dominates by chance, only where a pattern is planted.
    const offset = Math.floor(rnd() * TYPE_FAULTS[type].length);
    for (let i = 0; i < failures; i++) {
      const fault = index === K3 && rnd() < 0.7 ? "М-02" : TYPE_FAULTS[type][(offset + i) % TYPE_FAULTS[type].length];
      // Whole days from 3 back: the repair is finished well before now.
      addFailure(index, atLocal(now, 3 + Math.floor(rnd() * 87), breakdownHour()), fault);
    }
  }
  // Enough liner jobs on the mill to tell a spike from the usual consumption.
  for (let i = 0; i < 3; i++) addFailure(MILL, atLocal(now, 3 + Math.floor(rnd() * 87), breakdownHour()), "М-01");
  // Pattern 2: after the weak executor's repairs the same fault returns within a week.
  for (const draft of [...drafts].sort((a, b) => a.createdAt - b.createdAt)) {
    if (draft.executor !== WEAK_EXECUTOR || !draft.fault) continue;
    draft.reworked = rnd() < 0.3;
    if (rnd() < 0.6) {
      const repeatAt = atLocal(now, Math.floor((now - draft.createdAt) / DAY) - 2 - Math.floor(rnd() * 4), breakdownHour());
      if (repeatAt < now - 1.5 * DAY) addFailure(draft.equipment, repeatAt, draft.fault);
    }
  }
  // Pattern 4: liner bolts on the mill are sometimes written off at triple the usual quantity.
  drafts.filter((d) => d.equipment === MILL && d.fault === "М-01").slice(0, 2).forEach((d) => { d.spike = true; });
  // A few rejections and cancellations; Литвиненко refuses without a valid reason.
  for (const [i, draft] of drafts.filter((d) => d.type === WorkType.PLANNED).slice(0, 12).entries()) {
    draft.status = i < 8 ? WorkOrderStatus.REJECTED : WorkOrderStatus.CANCELLED;
    if (i < 8) {
      draft.executor = i < 4 ? "Литвиненко Игорь Васильевич" : pick(bySpecialty("Слесарь"));
      draft.rejected = i < 4 ? pick(["Не успеваю", "Не моя работа", "Занят"]) : pick(["Нет материалов на складе", "Нет допуска к работам на высоте", "Занят аварийным нарядом"]);
    }
  }

  drafts.sort((a, b) => a.createdAt - b.createdAt);
  const rows: Prisma.WorkOrderCreateManyInput[] = [];
  const extras: Array<{ draft: Draft; times: Record<string, number>; hours: number; normative: { id: number; hours: number } | undefined }> = [];
  for (const draft of drafts) {
    const [, , type] = EQUIPMENT[draft.equipment];
    const normative = normatives.get(`${type}:${draft.fault ?? "PPR"}`);
    const hours = normative?.hours ?? 3;
    const reaction = draft.type === WorkType.EMERGENCY ? between(2, 12) : between(10, 60);
    const accepted = draft.createdAt + reaction * MIN;
    const started = accepted + between(5, 25) * MIN;
    // The weak executor and night repairs run longer; ~15% of orders are late.
    const slow = draft.executor === WEAK_EXECUTOR ? 1.4 : 1;
    const late = rnd() < 0.15;
    const actual = hours * slow * between(0.8, late ? 1.8 : 1.15);
    const completed = started + actual * HOUR;
    const deadline = draft.createdAt + (hours * 1.5 + 1.5) * HOUR;
    const closed = completed + between(10, 90) * MIN;
    const executor = executors.get(draft.executor)!;
    const done = draft.status === WorkOrderStatus.CLOSED;
    rows.push({
      number: draft.number, type: draft.type, priority: draft.priority, status: draft.status, description: draft.description,
      deadline: new Date(deadline), createdAt: new Date(draft.createdAt),
      acceptedAt: done ? new Date(accepted) : null, startedAt: done ? new Date(started) : null, completedAt: done ? new Date(completed) : null, closedAt: done ? new Date(closed) : null,
      completionText: done ? (draft.fault ? REPAIRS[draft.fault][2] : "Выполнено плановое ТО: осмотр, подтяжка соединений, смазка узлов, проверка на холостом ходу") : null,
      rejectionReason: draft.rejected ?? null,
      areaId: areas[EQUIPMENT[draft.equipment][4]].id, equipmentId: equipment[draft.equipment].id, creatorId: draft.master, assigneeId: executor.id,
      faultCodeId: draft.fault ? faultCodes.get(draft.fault)! : null, normativeId: normative?.id ?? null,
      actualDowntimeMinutes: done ? Math.round((closed - draft.createdAt) / MIN) : null
    });
    extras.push({ draft, times: { accepted, started, completed, closed }, hours, normative });
  }
  await prisma.workOrder.createMany({ data: rows });
  const ids = new Map((await prisma.workOrder.findMany({ select: { id: true, number: true } })).map((x) => [x.number, x.id]));

  const events: Prisma.WorkOrderEventCreateManyInput[] = [];
  const usages: Prisma.MaterialUsageCreateManyInput[] = [];
  const downtimes: Prisma.EquipmentDowntimeCreateManyInput[] = [];
  const assessments: Prisma.AiAssessmentCreateManyInput[] = [];
  for (const { draft, times } of extras) {
    const id = ids.get(draft.number)!;
    const executorId = executors.get(draft.executor)!.id;
    events.push({ workOrderId: id, actorId: draft.master, action: "CREATE", toStatus: "ISSUED", createdAt: new Date(draft.createdAt) });
    if (draft.status === WorkOrderStatus.REJECTED) {
      events.push({ workOrderId: id, actorId: executorId, action: "REJECT", fromStatus: "ISSUED", toStatus: "REJECTED", comment: draft.rejected, createdAt: new Date(draft.createdAt + 7 * MIN) });
      continue;
    }
    if (draft.status === WorkOrderStatus.CANCELLED) {
      events.push({ workOrderId: id, actorId: draft.master, action: "CANCEL", fromStatus: "ISSUED", toStatus: "CANCELLED", comment: "Перенесено на следующий ППР", createdAt: new Date(draft.createdAt + 30 * MIN) });
      continue;
    }
    const at = (ms: number) => new Date(ms);
    events.push(
      { workOrderId: id, actorId: executorId, action: "ACCEPT", fromStatus: "ISSUED", toStatus: "ACCEPTED", createdAt: at(times.accepted) },
      { workOrderId: id, actorId: executorId, action: "START", fromStatus: "ACCEPTED", toStatus: "IN_PROGRESS", createdAt: at(times.started) }
    );
    if (draft.reworked) events.push(
      { workOrderId: id, actorId: executorId, action: "COMPLETE", fromStatus: "IN_PROGRESS", toStatus: "COMPLETED", createdAt: at(times.completed - 40 * MIN) },
      { workOrderId: id, actorId: draft.master, action: "SEND_TO_REWORK", fromStatus: "AI_REVIEW", toStatus: "REWORK", comment: "Отчёт без проверки результата, повторить и проверить узел", createdAt: at(times.completed - 30 * MIN) },
      { workOrderId: id, actorId: executorId, action: "START", fromStatus: "REWORK", toStatus: "IN_PROGRESS", createdAt: at(times.completed - 25 * MIN) }
    );
    events.push(
      { workOrderId: id, actorId: executorId, action: "COMPLETE", fromStatus: "IN_PROGRESS", toStatus: "COMPLETED", createdAt: at(times.completed) },
      { workOrderId: id, actorId: draft.master, action: "AI_REVIEW", fromStatus: "COMPLETED", toStatus: "AI_REVIEW", createdAt: at(times.completed + 1000) },
      { workOrderId: id, actorId: draft.master, action: "CLOSE", fromStatus: "AI_REVIEW", toStatus: "CLOSED", createdAt: at(times.closed) }
    );
    const repair = draft.fault ? REPAIRS[draft.fault][1] : [["Смазка Литол-24", 2], ["Ветошь", 1]] as Array<[string, number]>;
    for (const [material, quantity] of repair) {
      const spike = draft.spike && material === "Болт футеровочный М36";
      usages.push({ workOrderId: id, materialId: materials.get(material)!.id, quantity: spike ? quantity * 3.5 : Math.max(1, Math.round(quantity * between(0.85, 1.15) * 10) / 10) });
    }
    if (draft.type === WorkType.EMERGENCY) downtimes.push({ equipmentId: equipment[draft.equipment].id, workOrderId: id, startedAt: at(draft.createdAt), endedAt: at(times.closed), reason: draft.description });
    const weak = draft.executor === WEAK_EXECUTOR;
    const score = weak ? pick([2, 3, 3, 4]) : pick([4, 4, 5, 5, 5]);
    assessments.push({
      workOrderId: id, verdict: score >= 4 ? AiVerdict.ACCEPTED : AiVerdict.ACCEPTED_WITH_COMMENTS, score, confidence: 0.8,
      explanation: score >= 4 ? "Работы описаны конкретно и соответствуют проблеме, материалы в норме" : "Отчёт неполный: не описана проверка результата",
      strengths: score >= 4 ? ["Конкретное описание работ", "Материалы соответствуют шифру"] : ["Шифр указан"],
      improvements: score >= 4 ? [] : ["Описывать проверку после ремонта", "Прикладывать фото «после»"],
      masterScore: rnd() < 0.2 ? Math.max(1, Math.min(5, score + pick([-1, 1]))) : null,
      reviewedById: draft.master, createdAt: at(times.completed + 1000)
    });
  }
  await prisma.workOrderEvent.createMany({ data: events });
  await prisma.materialUsage.createMany({ data: usages });
  await prisma.equipmentDowntime.createMany({ data: downtimes });
  await prisma.aiAssessment.createMany({ data: assessments });

  /* ───── Current shift for the live demo ───── */
  const live = async (input: { equipment: string; fault: string | null; executor: string; status: WorkOrderStatus; minutesAgo: number; deadlineIn: number; type?: WorkType; priority?: Priority; description: string; comment?: string }) => {
    const index = EQUIPMENT.findIndex((x) => x[0].startsWith(input.equipment));
    const [, , type, , area] = EQUIPMENT[index];
    const createdAt = new Date(now - input.minutesAgo * MIN);
    const working = ["ACCEPTED", "IN_PROGRESS", "PAUSED", "AI_REVIEW"].includes(input.status);
    const started = ["IN_PROGRESS", "PAUSED", "AI_REVIEW"].includes(input.status);
    const executorId = executors.get(input.executor)!.id;
    const normative = normatives.get(`${type}:${input.fault ?? "PPR"}`);
    const order = await prisma.workOrder.create({ data: {
      number: `Н-${String(++seq).padStart(5, "0")}`, type: input.type ?? WorkType.EMERGENCY, priority: input.priority ?? Priority.HIGH, status: input.status,
      description: input.description, comment: input.comment, deadline: new Date(now + input.deadlineIn * MIN), createdAt,
      acceptedAt: working ? new Date(createdAt.getTime() + 6 * MIN) : null, startedAt: started ? new Date(createdAt.getTime() + 15 * MIN) : null,
      completedAt: input.status === "AI_REVIEW" ? new Date(now - 10 * MIN) : null,
      completionText: input.status === "AI_REVIEW" && input.fault ? REPAIRS[input.fault][2] : null,
      areaId: areas[area].id, equipmentId: equipment[index].id, creatorId: masters[0], assigneeId: executorId,
      faultCodeId: input.status === "AI_REVIEW" && input.fault ? faultCodes.get(input.fault) : null, normativeId: normative?.id
    } });
    const flow: Array<[string, WorkOrderStatus | null, WorkOrderStatus, number, string | undefined]> = [["CREATE", null, "ISSUED", 0, undefined]];
    if (working) flow.push(["ACCEPT", "ISSUED", "ACCEPTED", 6, undefined]);
    if (input.status === "QUEUED") flow.push(["QUEUE", "ISSUED", "QUEUED", 4, undefined]);
    if (started) flow.push(["START", "ACCEPTED", "IN_PROGRESS", 15, undefined]);
    if (input.status === "PAUSED") flow.push(["PAUSE", "IN_PROGRESS", "PAUSED", 40, input.comment]);
    if (input.status === "IN_PROGRESS" && input.comment) flow.push(["COMMENT", "IN_PROGRESS", "IN_PROGRESS", 50, input.comment]);
    if (input.status === "AI_REVIEW") flow.push(["COMPLETE", "IN_PROGRESS", "COMPLETED", input.minutesAgo - 10, undefined]);
    for (const [action, fromStatus, toStatus, offset, comment] of flow) {
      await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: action === "CREATE" ? masters[0] : executorId, action, fromStatus, toStatus, comment, createdAt: new Date(createdAt.getTime() + offset * MIN) } });
    }
    if (input.status === "AI_REVIEW") {
      await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: masters[0], action: "AI_REVIEW", fromStatus: "COMPLETED", toStatus: "AI_REVIEW", comment: "Не заполнено: фото после", createdAt: new Date(now - 9 * MIN) } });
      await prisma.aiAssessment.create({ data: {
        workOrderId: order.id, verdict: AiVerdict.REWORK_REQUIRED, score: 2, confidence: 1, photoScore: 1, photoComment: "Отсутствует доступное фото после",
        explanation: "Работы описаны, но для аварийного наряда нет фото «после». Не заполнено: фото после",
        strengths: ["Указан шифр и выполненные действия"], improvements: ["Приложить фото узла после ремонта"]
      } });
    }
    if (order.type === WorkType.EMERGENCY) await prisma.equipmentDowntime.create({ data: { equipmentId: order.equipmentId, workOrderId: order.id, startedAt: createdAt, reason: input.description } });
    return order;
  };
  // The case's sample: overdue on КМД-1750, Ахметов Е., in progress, waiting for a bearing.
  await live({ equipment: "Дробилка КМД-1750", fault: "М-02", executor: "Ахметов Ерлан Серикович", status: "IN_PROGRESS", minutesAgo: 190, deadlineIn: -45, description: "Гул и нагрев подшипникового узла эксцентрика", comment: "ждём подшипник со склада" });
  await live({ equipment: "Мельница МШЦ-3600", fault: "Э-01", executor: "Иванов Сергей Николаевич", status: "IN_PROGRESS", minutesAgo: 70, deadlineIn: 150, description: "Перегрев электродвигателя привода мельницы" });
  await live({ equipment: "Сепаратор ПБМ-120", fault: "С-01", executor: "Оспанов Бауыржан Канатович", status: "PAUSED", minutesAgo: 120, deadlineIn: 60, type: WorkType.PLANNED, priority: Priority.NORMAL, description: "Смазка подшипниковых узлов барабана", comment: "ждёт остановки оборудования" });
  await live({ equipment: "Грохот ГИТ-71", fault: "М-05", executor: "Мухамеджанов Ержан Талгатович", status: "ACCEPTED", minutesAgo: 25, deadlineIn: 120, priority: Priority.NORMAL, type: WorkType.PLANNED, description: "Подтянуть крепление вибратора, проверить раму на трещины" });
  await live({ equipment: "Конвейер К-1", fault: "М-06", executor: "Тулегенов Арман Болатович", status: "ISSUED", minutesAgo: 4, deadlineIn: 240, priority: Priority.NORMAL, type: WorkType.PLANNED, description: "Замена роликов роликоопор на хвостовой части" });
  await live({ equipment: "Классификатор КСН-24", fault: "М-04", executor: "Иванов Сергей Николаевич", status: "QUEUED", minutesAgo: 40, deadlineIn: 300, priority: Priority.PLANNED, type: WorkType.PLANNED, description: "Проверить редуктор привода спирали" });
  await live({ equipment: "Конвейер К-3", fault: "М-02", executor: "Жумабаев Данияр Ерланович", status: "AI_REVIEW", minutesAgo: 200, deadlineIn: -20, description: "Гул и нагрев подшипника приводного барабана" });

  // Employee statuses from their current orders.
  for (const [, executor] of executors) {
    if (!executor.isOnShift) continue;
    const [working, queued] = await Promise.all([
      prisma.workOrder.count({ where: { assigneeId: executor.id, status: { in: ["ACCEPTED", "IN_PROGRESS", "PAUSED", "REWORK"] } } }),
      prisma.workOrder.count({ where: { assigneeId: executor.id, status: { in: ["ISSUED", "QUEUED"] } } })
    ]);
    await prisma.user.update({ where: { id: executor.id }, data: { employeeStatus: queued ? EmployeeStatus.QUEUED : working ? EmployeeStatus.BUSY : EmployeeStatus.AVAILABLE } });
  }

  // Anomalies for the last 90 days, so the dashboard has findings right after seeding.
  try {
    const { buildAnomalies } = await import("../src/services/analytics.js");
    const insights = await buildAnomalies(new Date(now - 90 * DAY), new Date(now));
    console.log(`Аномалии: ${insights.map((x) => x.type).join(", ")}`);
  } catch (error) {
    console.warn("Аномалии не посчитаны:", (error as Error).message);
  }

  const total = await prisma.workOrder.count();
  console.log(`Seed готов: ${AREAS.length} участка, ${EQUIPMENT.length} ед. оборудования, ${STAFF.length} сотрудника штаба, ${EXECUTORS.length} исполнителей, ${FAULT_CODES.length} шифр, ${MATERIALS.length} материалов, ${total} нарядов.`);
  if (process.env.SEED_PASSWORD) console.log("Пароль всех демо-аккаунтов — из SEED_PASSWORD.");
  else {
    const file = process.env.SEED_CREDENTIALS_FILE ?? "demo-credentials.local.txt";
    writeFileSync(file, ["# НарядAI — доступы демо-аккаунтов. Вход: POST /api/auth/login { phone, password }. Файл не коммитится.", "# телефон       пароль  роль      логин     имя", ...credentials, ""].join("\n"), { mode: 0o600 });
    console.log(`Пароли записаны в ${file}`);
  }
}

main().finally(() => prisma.$disconnect());
