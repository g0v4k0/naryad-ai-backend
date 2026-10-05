import "dotenv/config";
import { hashPin } from "../src/lib/pin.js";
import { AiVerdict, EmployeeStatus, Priority, PrismaClient, Role, WorkOrderStatus, WorkType, type User } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.assistantMessage.deleteMany();
  await prisma.pushDevice.deleteMany();
  await prisma.anomalyInsight.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.aiAssessment.deleteMany();
  await prisma.materialUsage.deleteMany();
  await prisma.photo.deleteMany();
  await prisma.workOrderEvent.deleteMany();
  await prisma.equipmentDowntime.deleteMany();
  await prisma.workOrder.deleteMany();
  await prisma.user.deleteMany();
  await prisma.brigade.deleteMany();
  await prisma.materialNorm.deleteMany();
  await prisma.workNormative.deleteMany();
  await prisma.equipment.deleteMany();
  await prisma.area.deleteMany();
  await prisma.faultCode.deleteMany();
  await prisma.material.deleteMany();

  const areaNames = ["Дробление", "Обогащение", "Ремонтно-механический цех", "Склад и транспорт"];
  const areas = [];
  for (const name of areaNames) areas.push(await prisma.area.create({ data: { name } }));

  const equipment = [];
  for (let i = 1; i <= 25; i++) {
    equipment.push(await prisma.equipment.create({ data: {
      name: i === 3 ? "Конвейер К-3" : `Оборудование ${i}`,
      inventoryNumber: `INV-${String(i).padStart(3, "0")}`,
      type: i % 3 === 0 ? "Конвейер" : i % 3 === 1 ? "Насос" : "Дробилка",
      criticality: i % 5 === 0 ? 5 : 3,
      areaId: areas[i % areas.length].id
    } }));
  }

  const brigades = [];
  for (const name of ["Бригада А", "Бригада Б", "Бригада В"]) brigades.push(await prisma.brigade.create({ data: { name } }));
  const pinHash = await hashPin(process.env.SEED_PIN ?? "1234");
  const master = await prisma.user.create({ data: { login: "master", pinHash, fullName: "Мастер смены", role: Role.MASTER, isOnShift: true, employeeStatus: EmployeeStatus.AVAILABLE } });
  await prisma.user.create({ data: { login: "manager", pinHash, fullName: "Начальник участка", role: Role.MANAGER, isOnShift: true, employeeStatus: EmployeeStatus.AVAILABLE } });
  await prisma.user.create({ data: { login: "admin", pinHash, fullName: "Администратор", role: Role.ADMIN, isOnShift: true, employeeStatus: EmployeeStatus.AVAILABLE } });
  const executors: User[] = [];
  const specialties = ["Слесарь", "Электрик", "Сварщик"];
  for (let i = 1; i <= 15; i++) executors.push(await prisma.user.create({ data: {
    login: `worker${i}`,
    pinHash,
    fullName: `Исполнитель ${i}`,
    role: Role.EXECUTOR,
    specialty: specialties[i % specialties.length],
    grade: 3 + (i % 4),
    brigadeId: brigades[i % brigades.length].id,
    isOnShift: i <= 10,
    employeeStatus: i <= 10 ? EmployeeStatus.AVAILABLE : EmployeeStatus.OFF_SHIFT
  } }));

  const faultCodes = [];
  const categories = ["М", "Э", "Г", "П", "С"];
  for (let i = 1; i <= 20; i++) faultCodes.push(await prisma.faultCode.create({ data: { code: `${categories[i % 5]}-${String(i).padStart(2, "0")}`, name: `Неисправность ${i}`, category: categories[i % 5] } }));
  const materials = [];
  for (let i = 1; i <= 40; i++) materials.push(await prisma.material.create({ data: { name: `Материал ${i}`, unit: i % 3 === 0 ? "кг" : i % 3 === 1 ? "шт" : "л" } }));
  const normatives = [];
  for (let i = 0; i < 10; i++) normatives.push(await prisma.workNormative.create({ data: { name: `Типовая работа ${i + 1}`, equipmentType: equipment[i].type, faultCodeId: faultCodes[i].id, hours: 2 + i % 4, materialNorms: { create: [{ materialId: materials[i].id, quantity: 1 + i % 3 }] } } }));

  const now = Date.now();
  const orders = [];
  for (let i = 1; i <= 500; i++) {
    const eq = i % 7 === 0 ? equipment[2] : equipment[i % equipment.length];
    const createdAt = new Date(now - (i % 90) * 86_400_000 - (i % 12) * 3_600_000);
    const deadline = new Date(createdAt.getTime() + (2 + i % 6) * 3_600_000);
    const late = i % 5 === 0;
    const closedAt = new Date(deadline.getTime() + (late ? 45 : -30) * 60_000);
    orders.push({
      number: `H-${String(i).padStart(4, "0")}`,
      type: i % 4 === 0 ? WorkType.EMERGENCY : WorkType.PLANNED,
      description: eq.id === equipment[2].id ? "Повторный шум подшипника" : `Исторический ремонт ${i}`,
      priority: i % 4 === 0 ? Priority.EMERGENCY : Priority.PLANNED,
      deadline,
      status: WorkOrderStatus.CLOSED,
      completionText: "Работы выполнены, оборудование проверено",
      createdAt,
      acceptedAt: new Date(createdAt.getTime() + 5 * 60_000),
      startedAt: new Date(createdAt.getTime() + 15 * 60_000),
      completedAt: closedAt,
      closedAt,
      areaId: eq.areaId,
      equipmentId: eq.id,
      creatorId: master.id,
      assigneeId: executors[i % executors.length].id,
      faultCodeId: faultCodes[i % faultCodes.length].id
      ,normativeId: normatives[i % normatives.length].id
      ,actualDowntimeMinutes: late ? 180 : 90
    });
  }
  await prisma.workOrder.createMany({ data: orders });
  const created = await prisma.workOrder.findMany({ where: { number: { startsWith: "H-" } }, select: { id: true, assigneeId: true } });
  await prisma.aiAssessment.createMany({ data: created.map((order, i) => ({
    workOrderId: order.id,
    verdict: i % 11 === 0 ? AiVerdict.REWORK_REQUIRED : AiVerdict.ACCEPTED,
    score: order.assigneeId === executors[0].id ? 3 : 4 + (i % 2),
    explanation: "Тестовая историческая оценка"
  })) });

  console.log("Seed готов. Логины: admin, master, manager, worker1..worker15. ПИН: 1234");
}

main().finally(() => prisma.$disconnect());
