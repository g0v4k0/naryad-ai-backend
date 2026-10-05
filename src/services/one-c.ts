import { randomUUID } from "node:crypto";
import { hashPin } from "../lib/pin.js";
import { IntegrationEntity, IntegrationStatus, Prisma, Role, WorkOrderStatus } from "@prisma/client";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import cron from "node-cron";

type ImportItem = Record<string, unknown> & { externalId: string };

async function mapping(entity: IntegrationEntity, externalId: string) {
  return prisma.integrationMapping.findUnique({ where: { entity_externalId: { entity, externalId } } });
}

async function saveMapping(entity: IntegrationEntity, localId: number, externalId: string) {
  return prisma.integrationMapping.upsert({
    where: { entity_localId: { entity, localId } },
    create: { entity, localId, externalId },
    update: { externalId }
  });
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Поле ${field} обязательно`);
  return value.trim();
}

function numberValue(value: unknown, field: string, fallback?: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) throw new Error(`Поле ${field} должно быть числом`);
  return parsed;
}

async function importItem(entity: IntegrationEntity, item: ImportItem) {
  const current = await mapping(entity, item.externalId);
  let localId: number;
  if (entity === "AREA") {
    const row = current
      ? await prisma.area.update({ where: { id: current.localId }, data: { name: text(item.name, "name") } })
      : await prisma.area.upsert({ where: { name: text(item.name, "name") }, create: { name: text(item.name, "name") }, update: {} });
    localId = row.id;
  } else if (entity === "BRIGADE") {
    const name = text(item.name, "name");
    const row = current ? await prisma.brigade.update({ where: { id: current.localId }, data: { name } }) : await prisma.brigade.upsert({ where: { name }, create: { name }, update: {} });
    localId = row.id;
  } else if (entity === "FAULT_CODE") {
    const code = text(item.code, "code");
    const data = { code, name: text(item.name, "name"), category: text(item.category, "category") };
    const row = current ? await prisma.faultCode.update({ where: { id: current.localId }, data }) : await prisma.faultCode.upsert({ where: { code }, create: data, update: data });
    localId = row.id;
  } else if (entity === "MATERIAL") {
    const name = text(item.name, "name");
    const data = { name, unit: text(item.unit, "unit") };
    const row = current ? await prisma.material.update({ where: { id: current.localId }, data }) : await prisma.material.upsert({ where: { name }, create: data, update: data });
    localId = row.id;
  } else if (entity === "EQUIPMENT") {
    const areaMap = await mapping("AREA", text(item.areaExternalId, "areaExternalId"));
    if (!areaMap) throw new Error(`Не найден участок 1С ${item.areaExternalId}`);
    const inventoryNumber = text(item.inventoryNumber, "inventoryNumber");
    const data = { name: text(item.name, "name"), inventoryNumber, type: text(item.type, "type"), criticality: numberValue(item.criticality, "criticality", 3), areaId: areaMap.localId };
    const row = current ? await prisma.equipment.update({ where: { id: current.localId }, data }) : await prisma.equipment.upsert({ where: { inventoryNumber }, create: data, update: data });
    localId = row.id;
  } else if (entity === "EMPLOYEE") {
    const brigadeMap = item.brigadeExternalId ? await mapping("BRIGADE", String(item.brigadeExternalId)) : null;
    const login = text(item.login, "login");
    const role = String(item.role ?? "EXECUTOR") as Role;
    if (!Object.values(Role).includes(role)) throw new Error(`Неизвестная роль ${role}`);
    const data = { login, fullName: text(item.fullName, "fullName"), role, specialty: item.specialty ? String(item.specialty) : null, grade: item.grade ? Number(item.grade) : null, brigadeId: brigadeMap?.localId ?? null, isOnShift: Boolean(item.isOnShift), language: String(item.language ?? "ru") };
    const row = current
      ? await prisma.user.update({ where: { id: current.localId }, data })
      : await prisma.user.upsert({ where: { login }, create: { ...data, pinHash: await hashPin(randomUUID()) }, update: data });
    localId = row.id;
  } else if (entity === "NORMATIVE") {
    const equipmentMap = item.equipmentExternalId ? await mapping("EQUIPMENT", String(item.equipmentExternalId)) : null;
    const faultMap = item.faultCodeExternalId ? await mapping("FAULT_CODE", String(item.faultCodeExternalId)) : null;
    const data = { name: text(item.name, "name"), equipmentType: item.equipmentType ? String(item.equipmentType) : null, equipmentId: equipmentMap?.localId ?? null, faultCodeId: faultMap?.localId ?? null, hours: numberValue(item.hours, "hours") };
    const row = current ? await prisma.workNormative.update({ where: { id: current.localId }, data }) : await prisma.workNormative.create({ data });
    localId = row.id;
  } else if (entity === "WORK_ORDER") {
    const areaMap = await mapping("AREA", text(item.areaExternalId, "areaExternalId"));
    const equipmentMap = await mapping("EQUIPMENT", text(item.equipmentExternalId, "equipmentExternalId"));
    const creatorMap = await mapping("EMPLOYEE", text(item.creatorExternalId, "creatorExternalId"));
    const assigneeMap = await mapping("EMPLOYEE", text(item.assigneeExternalId, "assigneeExternalId"));
    if (!areaMap || !equipmentMap || !creatorMap || !assigneeMap) throw new Error("Не найдены связанные объекты для наряда");
    const number = text(item.number, "number");
    const status = String(item.status ?? "ISSUED") as WorkOrderStatus;
    if (!Object.values(WorkOrderStatus).includes(status)) throw new Error(`Неизвестный статус ${status}`);
    const data = { number, type: String(item.type ?? "PLANNED") as "PLANNED" | "EMERGENCY", description: text(item.description, "description"), priority: String(item.priority ?? "NORMAL") as "EMERGENCY" | "HIGH" | "NORMAL" | "PLANNED", deadline: new Date(text(item.deadline, "deadline")), status, areaId: areaMap.localId, equipmentId: equipmentMap.localId, creatorId: creatorMap.localId, assigneeId: assigneeMap.localId };
    const row = current ? await prisma.workOrder.update({ where: { id: current.localId }, data }) : await prisma.workOrder.upsert({ where: { number }, create: data, update: data });
    localId = row.id;
  } else {
    throw new Error(`Импорт ${entity} не поддерживается`);
  }
  await saveMapping(entity, localId, item.externalId);
  return { externalId: item.externalId, localId };
}

export async function importFromOneC(requestId: string, entity: IntegrationEntity, items: ImportItem[]) {
  const idempotencyKey = `1c:in:${requestId}`;
  const existing = await prisma.integrationJob.findUnique({ where: { idempotencyKey } });
  if (existing?.status === IntegrationStatus.SUCCESS) return existing.response;
  const job = existing
    ? await prisma.integrationJob.update({ where: { id: existing.id }, data: { status: "PROCESSING", attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: null } })
    : await prisma.integrationJob.create({ data: { direction: "INBOUND", entity, eventType: "UPSERT_BATCH", idempotencyKey, payload: items as Prisma.InputJsonValue, status: "PROCESSING", attempts: 1, lastAttemptAt: new Date() } });
  try {
    const results = [];
    for (const item of items) {
      try {
        results.push(await importItem(entity, item));
      } catch (error) {
        throw new HttpError(422, `Элемент ${item.externalId}: ${(error as Error).message}`);
      }
    }
    const response = { requestId, imported: results.length, items: results };
    await prisma.integrationJob.update({ where: { id: job.id }, data: { status: "SUCCESS", completedAt: new Date(), response } });
    return response;
  } catch (error) {
    await prisma.integrationJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: (error as Error).message } });
    throw error;
  }
}

export async function buildWorkOrderPayload(workOrderId: number) {
  const order = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { area: true, equipment: true, creator: true, assignee: true, faultCode: true, materialUsages: { include: { material: true } }, aiAssessment: true, events: { orderBy: { createdAt: "asc" } } }
  });
  const maps = await prisma.integrationMapping.findMany({ where: { OR: [
    { entity: "WORK_ORDER", localId: order.id },
    { entity: "AREA", localId: order.areaId }, { entity: "EQUIPMENT", localId: order.equipmentId },
    { entity: "EMPLOYEE", localId: { in: [order.creatorId, order.assigneeId] } },
    ...(order.faultCodeId ? [{ entity: "FAULT_CODE" as const, localId: order.faultCodeId }] : []),
    ...order.materialUsages.map((x) => ({ entity: "MATERIAL" as const, localId: x.materialId }))
  ] } });
  const external = (entity: IntegrationEntity, localId: number) => maps.find((x) => x.entity === entity && x.localId === localId)?.externalId ?? null;
  return {
    localId: order.id, externalId: external("WORK_ORDER", order.id), number: order.number, type: order.type,
    description: order.description, priority: order.priority, status: order.status, deadline: order.deadline,
    area: { localId: order.areaId, externalId: external("AREA", order.areaId), name: order.area.name },
    equipment: { localId: order.equipmentId, externalId: external("EQUIPMENT", order.equipmentId), inventoryNumber: order.equipment.inventoryNumber, name: order.equipment.name },
    creator: { localId: order.creatorId, externalId: external("EMPLOYEE", order.creatorId), fullName: order.creator.fullName },
    assignee: { localId: order.assigneeId, externalId: external("EMPLOYEE", order.assigneeId), fullName: order.assignee.fullName },
    faultCode: order.faultCode ? { localId: order.faultCode.id, externalId: external("FAULT_CODE", order.faultCode.id), code: order.faultCode.code } : null,
    materials: order.materialUsages.map((x) => ({ localId: x.materialId, externalId: external("MATERIAL", x.materialId), name: x.material.name, unit: x.material.unit, quantity: Number(x.quantity) })),
    completion: { text: order.completionText, completedAt: order.completedAt, closedAt: order.closedAt, downtimeMinutes: order.actualDowntimeMinutes },
    assessment: order.aiAssessment,
    events: order.events
  };
}

export async function enqueueWorkOrderSync(workOrderId: number, eventType: string, idempotencyKey = `naryad:out:${workOrderId}:${eventType}:${randomUUID()}`) {
  const payload = await buildWorkOrderPayload(workOrderId);
  return prisma.integrationJob.upsert({
    where: { idempotencyKey },
    create: { direction: "OUTBOUND", entity: "WORK_ORDER", eventType, localId: workOrderId, idempotencyKey, payload: payload as Prisma.InputJsonValue },
    update: {}
  });
}

export async function processOneCJobs(limit = 20) {
  if (!config.ONE_C_ENABLED || !config.ONE_C_BASE_URL || !config.ONE_C_API_KEY) return { processed: 0, disabled: true };
  const jobs = await prisma.integrationJob.findMany({ where: { direction: "OUTBOUND", status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: new Date() }, attempts: { lt: config.ONE_C_MAX_ATTEMPTS } }, orderBy: { createdAt: "asc" }, take: limit });
  let succeeded = 0;
  for (const job of jobs) {
    await prisma.integrationJob.update({ where: { id: job.id }, data: { status: "PROCESSING", attempts: { increment: 1 }, lastAttemptAt: new Date() } });
    try {
      const response = await fetch(new URL(config.ONE_C_PUSH_PATH, config.ONE_C_BASE_URL), {
        method: "POST",
        headers: { "content-type": "application/json", "x-1c-api-key": config.ONE_C_API_KEY, "x-idempotency-key": job.idempotencyKey },
        body: JSON.stringify({ eventId: job.idempotencyKey, eventType: job.eventType, entity: job.entity, occurredAt: job.createdAt, data: job.payload }),
        signal: AbortSignal.timeout(config.ONE_C_TIMEOUT_MS)
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`1С HTTP ${response.status}: ${responseText.slice(0, 1000)}`);
      let responseBody: Record<string, unknown> = {};
      try { responseBody = responseText ? JSON.parse(responseText) : {}; } catch { responseBody = { text: responseText }; }
      if (job.localId && typeof responseBody.externalId === "string") await saveMapping("WORK_ORDER", job.localId, responseBody.externalId);
      await prisma.integrationJob.update({ where: { id: job.id }, data: { status: "SUCCESS", completedAt: new Date(), lastError: null, response: responseBody as Prisma.InputJsonValue } });
      succeeded++;
    } catch (error) {
      const attempts = job.attempts + 1;
      const dead = attempts >= config.ONE_C_MAX_ATTEMPTS;
      const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
      await prisma.integrationJob.update({ where: { id: job.id }, data: { status: dead ? "DEAD" : "FAILED", lastError: (error as Error).message, nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000) } });
    }
  }
  return { processed: jobs.length, succeeded, disabled: false };
}

export function startOneCSync() {
  cron.schedule("* * * * *", () => processOneCJobs().catch((error) => console.error("1C sync:", error)));
}
