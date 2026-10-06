import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Prisma, Role, type User } from "@prisma/client";
import { prisma } from "../../src/lib/prisma.js";

/** Password of every test user; stored as a legacy bcrypt hash to exercise the rehash path. */
export const TEST_PASSWORD = "secret12";
let passwordHash: string | undefined;

export async function resetDb() {
  const tables = Object.values(Prisma.ModelName);
  await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
  for (const table of tables) await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
  await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
}

export function tokenFor(user: Pick<User, "id" | "role">) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: "1h" });
}

export const bearer = (user: Pick<User, "id" | "role">) => ({ authorization: `Bearer ${tokenFor(user)}` });

export async function createUser(data: Partial<Prisma.UserUncheckedCreateInput> & { login: string; role: Role }) {
  passwordHash ??= await bcrypt.hash(TEST_PASSWORD, 4);
  return prisma.user.create({ data: { fullName: data.login, passwordHash, isOnShift: true, employeeStatus: "AVAILABLE", ...data } });
}

/** Minimal plant: 2 areas, 3 equipment units, staff of every role, fault codes, materials, one normative. */
export async function seedBase() {
  await resetDb();
  const area = await prisma.area.create({ data: { name: "Дробление" } });
  const area2 = await prisma.area.create({ data: { name: "Обогащение" } });
  const pump = await prisma.equipment.create({ data: { name: "Насос Н-1", inventoryNumber: "INV-001", type: "Насос", criticality: 3, areaId: area.id } });
  const conveyor = await prisma.equipment.create({ data: { name: "Конвейер К-3", inventoryNumber: "INV-003", type: "Конвейер", criticality: 5, areaId: area.id } });
  const crusher = await prisma.equipment.create({ data: { name: "Дробилка Д-2", inventoryNumber: "INV-002", type: "Дробилка", criticality: 4, areaId: area2.id } });
  const brigade = await prisma.brigade.create({ data: { name: "Бригада А" } });
  const master = await createUser({ login: "master", phone: "+77010000001", role: Role.MASTER, fullName: "Мастер" });
  const manager = await createUser({ login: "manager", phone: "+77010000002", role: Role.MANAGER, fullName: "Начальник" });
  const admin = await createUser({ login: "admin", phone: "+77010000003", role: Role.ADMIN, fullName: "Админ" });
  const worker1 = await createUser({ login: "worker1", phone: "+77010000004", role: Role.EXECUTOR, fullName: "Слесарь 1", specialty: "Слесарь", grade: 5, brigadeId: brigade.id });
  const worker2 = await createUser({ login: "worker2", phone: "+77010000005", role: Role.EXECUTOR, fullName: "Электрик 2", specialty: "Электрик", grade: 4, brigadeId: brigade.id });
  const worker3 = await createUser({ login: "worker3", phone: "+77010000006", role: Role.EXECUTOR, fullName: "Сварщик 3", specialty: "Сварщик", isOnShift: false, employeeStatus: "OFF_SHIFT" });
  const fault = await prisma.faultCode.create({ data: { code: "М-01", name: "Износ подшипника", category: "М" } });
  const fault2 = await prisma.faultCode.create({ data: { code: "Э-02", name: "Обрыв питания", category: "Э" } });
  const bearing = await prisma.material.create({ data: { name: "Подшипник 6205", unit: "шт" } });
  const grease = await prisma.material.create({ data: { name: "Смазка Литол", unit: "кг" } });
  const normative = await prisma.workNormative.create({ data: { name: "Замена подшипника насоса", equipmentType: "Насос", faultCodeId: fault.id, hours: 2, materialNorms: { create: [{ materialId: bearing.id, quantity: 2 }] } } });
  return { area, area2, pump, conveyor, crusher, brigade, master, manager, admin, worker1, worker2, worker3, fault, fault2, bearing, grease, normative };
}

export type Base = Awaited<ReturnType<typeof seedBase>>;

let counter = 0;
/** Insert a work order directly (bypassing API) for analytics/report fixtures. */
export async function insertOrder(base: Base, data: Partial<Prisma.WorkOrderUncheckedCreateInput> = {}) {
  counter++;
  return prisma.workOrder.create({ data: {
    number: `T-${Date.now()}-${counter}`,
    type: "PLANNED",
    description: "Тестовый наряд",
    priority: "NORMAL",
    deadline: new Date(Date.now() + 3_600_000),
    areaId: base.area.id,
    equipmentId: base.pump.id,
    creatorId: base.master.id,
    assigneeId: base.worker1.id,
    ...data
  } });
}
