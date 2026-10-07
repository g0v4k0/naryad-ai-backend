import { Router, type Request } from "express";
import { AiVerdict, Prisma, PhotoType, Role, WorkOrderStatus } from "@prisma/client";
import { z } from "zod";
import { nextStatus, type WorkOrderAction } from "../domain/work-order-state.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { normalizePhotoUrl } from "../lib/signed-urls.js";
import { prisma } from "../lib/prisma.js";
import { allow, auth } from "../middleware/auth.js";
import { emitOrderChanged } from "../realtime.js";
import { reviewWorkOrder } from "../services/ai-review.js";
import { notify } from "../services/notifications.js";
import { refreshEmployeeStatus } from "../services/employee-status.js";
import { enqueueWorkOrderSync } from "../services/one-c.js";
import { learnFromMasterDecision } from "../services/rag.js";
import { executorOrderReport, masterOrderReport, orderTiming } from "../services/order-report.js";
import { recommendExecutors } from "../services/recommendations.js";

export const workOrdersRouter = Router();
workOrdersRouter.use(auth);

const orderInclude = {
  area: true,
  equipment: true,
  creator: { select: { id: true, fullName: true } },
  assignee: { select: { id: true, fullName: true, specialty: true, employeeStatus: true } },
  brigade: true,
  faultCode: true,
  normative: true,
  photos: true,
  materialUsages: { include: { material: true } },
  aiAssessment: true,
  downtime: true
} as const;

// Compact list for mobile queues: no photos or material lines.
const listCompactInclude = {
  area: true,
  equipment: true,
  assignee: { select: { id: true, fullName: true, specialty: true, employeeStatus: true } },
  brigade: true,
  faultCode: true,
  aiAssessment: { select: { verdict: true, score: true, masterScore: true, needsMasterReview: true } }
} as const;

// Orders that are finished or awaiting the master's decision cannot change hands.
const NOT_REASSIGNABLE: WorkOrderStatus[] = [WorkOrderStatus.COMPLETED, WorkOrderStatus.AI_REVIEW, WorkOrderStatus.CLOSED, WorkOrderStatus.CANCELLED];

const OPEN_STATUSES: WorkOrderStatus[] = ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"];
const csv = <T extends string>(values: readonly [T, ...T[]]) => z.string().transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(values)));

const listFilters = z.object({
  status: csv(Object.values(WorkOrderStatus) as [WorkOrderStatus, ...WorkOrderStatus[]]).optional(),
  priority: csv(["EMERGENCY", "HIGH", "NORMAL", "PLANNED"]).optional(),
  type: z.enum(["PLANNED", "EMERGENCY"]).optional(),
  areaId: z.coerce.number().int().positive().optional(),
  equipmentId: z.coerce.number().int().positive().optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  brigadeId: z.coerce.number().int().positive().optional(),
  overdue: z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true").optional()
});

/** Filters shared by the list and the board; executors only ever see their own orders. */
function listWhere(req: Request, filters: z.infer<typeof listFilters>): Prisma.WorkOrderWhereInput {
  const and: Prisma.WorkOrderWhereInput[] = [];
  if (filters.status) and.push({ status: { in: filters.status } });
  if (filters.overdue) and.push({ deadline: { lt: new Date() }, status: { in: OPEN_STATUSES } });
  return {
    ...(and.length ? { AND: and } : {}),
    ...(filters.priority ? { priority: { in: filters.priority } } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.areaId ? { areaId: filters.areaId } : {}),
    ...(filters.equipmentId ? { equipmentId: filters.equipmentId } : {}),
    ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
    ...(filters.brigadeId ? { OR: [{ brigadeId: filters.brigadeId }, { assignee: { brigadeId: filters.brigadeId } }] } : {}),
    ...(req.user!.role === Role.EXECUTOR ? { assigneeId: req.user!.id } : {})
  };
}

const withOverdue = <T extends { deadline: Date; status: WorkOrderStatus }>(order: T, now = new Date()) => ({ ...order, isOverdue: order.deadline < now && OPEN_STATUSES.includes(order.status) });

workOrdersRouter.get("/", asyncHandler(async (req, res) => {
  const where = listWhere(req, listFilters.parse(req.query));
  const { limit, offset, compact } = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
    compact: z.enum(["0", "1", "true", "false"]).default("0").transform((v) => v === "1" || v === "true")
  }).parse(req.query);
  const [orders, total] = await Promise.all([
    prisma.workOrder.findMany({ where, include: compact ? listCompactInclude : orderInclude, orderBy: [{ priority: "asc" }, { deadline: "asc" }, { id: "asc" }], take: limit, skip: offset }),
    prisma.workOrder.count({ where })
  ]);
  res.setHeader("x-total-count", String(total));
  const now = new Date();
  res.json(orders.map((order) => withOverdue(order, now)));
}));

/**
 * Master's kanban (5.2.2): issued, accepted, in progress, queued, completed, overdue — plus shift counters (5.2.4).
 * An overdue order shows in its status column and in the overdue column.
 */
workOrdersRouter.get("/board", asyncHandler(async (req, res) => {
  const filters = listFilters.omit({ status: true, overdue: true }).extend({ hours: z.coerce.number().positive().max(24 * 31).default(12) }).parse(req.query);
  const where = listWhere(req, filters);
  const since = new Date(Date.now() - filters.hours * 3_600_000);
  const now = new Date();
  const orders = await prisma.workOrder.findMany({
    where: { AND: [where, { OR: [{ status: { in: OPEN_STATUSES } }, { status: { in: ["COMPLETED", "AI_REVIEW"] } }, { closedAt: { gte: since } }] }] },
    include: listCompactInclude,
    orderBy: [{ priority: "asc" }, { deadline: "asc" }, { id: "asc" }]
  });
  const cards = orders.map((order) => withOverdue(order, now));
  const columns = {
    issued: cards.filter((x) => x.status === "ISSUED"),
    accepted: cards.filter((x) => x.status === "ACCEPTED"),
    inProgress: cards.filter((x) => ["IN_PROGRESS", "PAUSED", "REWORK"].includes(x.status)),
    queued: cards.filter((x) => x.status === "QUEUED"),
    completed: cards.filter((x) => ["COMPLETED", "AI_REVIEW", "CLOSED"].includes(x.status)),
    overdue: cards.filter((x) => x.isOverdue)
  };
  const [issuedInShift, completedInShift, equipmentInDowntime] = await Promise.all([
    prisma.workOrder.count({ where: { AND: [where, { createdAt: { gte: since } }] } }),
    prisma.workOrder.count({ where: { AND: [where, { completedAt: { gte: since } }] } }),
    prisma.equipmentDowntime.findMany({ where: { endedAt: null, ...(filters.areaId ? { equipment: { areaId: filters.areaId } } : {}) }, distinct: ["equipmentId"], select: { equipmentId: true } })
  ]);
  res.json({
    since,
    counters: { issued: issuedInShift, completed: completedInShift, overdue: columns.overdue.length, equipmentInDowntime: equipmentInDowntime.length },
    columns
  });
}));

workOrdersRouter.get("/:id", asyncHandler(async (req, res) => {
  const order = await prisma.workOrder.findUnique({
    where: { id: Number(req.params.id) },
    include: { ...orderInclude, events: { include: { actor: { select: { id: true, fullName: true } } }, orderBy: { createdAt: "asc" } } }
  });
  if (!order) throw new HttpError(404, "Наряд не найден");
  if (req.user!.role === Role.EXECUTOR && order.assigneeId !== req.user!.id) throw new HttpError(403, "Это не ваш наряд");
  res.json({ ...withOverdue(order), timing: orderTiming(order) });
}));

/** 6.4: the executor gets their own short report, staff get the full one. */
workOrdersRouter.get("/:id/report", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (req.user!.role === Role.EXECUTOR) {
    const report = await executorOrderReport(id);
    if (!report) throw new HttpError(404, "Наряд не найден");
    if (report.assigneeId !== req.user!.id) throw new HttpError(403, "Это не ваш наряд");
    return res.json({ audience: "EXECUTOR", ...report });
  }
  const report = await masterOrderReport(id);
  if (!report) throw new HttpError(404, "Наряд не найден");
  res.json({ audience: "MASTER", ...report });
}));

workOrdersRouter.post("/", allow(Role.MASTER, Role.ADMIN), asyncHandler(async (req, res) => {
  const input = z.object({
    type: z.enum(["PLANNED", "EMERGENCY"]),
    description: z.string().min(3),
    areaId: z.number().int().positive(),
    equipmentId: z.number().int().positive(),
    assigneeId: z.number().int().positive().optional(),
    brigadeId: z.number().int().positive().optional(),
    deadline: z.coerce.date().optional(),
    priority: z.enum(["EMERGENCY", "HIGH", "NORMAL", "PLANNED"]),
    normativeId: z.number().int().positive().optional(),
    comment: z.string().optional(),
    beforePhotoUrls: z.array(z.string().transform(normalizePhotoUrl)).max(5).default([])
  }).refine((value) => value.deadline || value.normativeId, { message: "Укажите срок или норматив" })
    .refine((value) => value.assigneeId || value.brigadeId, { message: "Укажите исполнителя или бригаду" }).parse(req.body);
  const equipment = await prisma.equipment.findFirst({ where: { id: input.equipmentId, areaId: input.areaId } });
  if (!equipment) throw new HttpError(400, "Проверьте оборудование и исполнителя");
  if (input.brigadeId && !await prisma.brigade.findUnique({ where: { id: input.brigadeId } })) throw new HttpError(400, "Бригада не найдена");
  // A brigade order goes to its best-suited member on shift, who leads it; the brigade stays on the order.
  const assigneeId = input.assigneeId ?? (await recommendExecutors(input.equipmentId, { brigadeId: input.brigadeId, description: input.description }))[0]?.id;
  if (!assigneeId) throw new HttpError(400, "В бригаде нет исполнителей на смене");
  const assignee = await prisma.user.findFirst({ where: { id: assigneeId, role: Role.EXECUTOR } });
  if (!assignee) throw new HttpError(400, "Проверьте оборудование и исполнителя");
  if (input.brigadeId && assignee.brigadeId !== input.brigadeId) throw new HttpError(400, "Исполнитель не состоит в этой бригаде");
  const normative = input.normativeId ? await prisma.workNormative.findUnique({ where: { id: input.normativeId } }) : null;
  if (input.normativeId && !normative) throw new HttpError(400, "Норматив не найден");
  const deadline = input.deadline ?? new Date(Date.now() + Number(normative?.hours ?? 2) * 3_600_000);
  const number = `N-${Date.now().toString().slice(-8)}`;
  const { beforePhotoUrls, ...orderInput } = input;
  const orderData = { ...orderInput, assigneeId, deadline };
  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.workOrder.create({ data: {
      ...orderData,
      number,
      creatorId: req.user!.id,
      photos: { create: beforePhotoUrls.map((fileUrl) => ({ fileUrl, authorId: req.user!.id, type: PhotoType.BEFORE })) }
    }, include: orderInclude });
    await tx.workOrderEvent.create({ data: { workOrderId: created.id, actorId: req.user!.id, action: "CREATE", toStatus: WorkOrderStatus.ISSUED } });
    if (created.type === "EMERGENCY") await tx.equipmentDowntime.create({ data: { equipmentId: created.equipmentId, workOrderId: created.id, startedAt: created.createdAt, reason: created.description } });
    return created;
  });
  await notify({ userId: assigneeId, workOrderId: order.id, type: "NEW_ORDER", title: `Новый наряд ${number}`, message: input.description, data: { priority: order.priority } });
  if (input.brigadeId) {
    const members = await prisma.user.findMany({ where: { brigadeId: input.brigadeId, isOnShift: true, id: { not: assigneeId } }, select: { id: true } });
    for (const member of members) await notify({ userId: member.id, workOrderId: order.id, type: "BRIGADE_ORDER", title: `Наряд ${number} выдан бригаде`, message: `${input.description}. Старший: ${assignee.fullName}`, data: { priority: order.priority } });
  }
  await refreshEmployeeStatus(assigneeId);
  await enqueueWorkOrderSync(order.id, "CREATED");
  emitOrderChanged(order);
  res.status(201).json(order);
}));

const actionSchema = z.object({
  action: z.enum(["ACCEPT", "QUEUE", "REJECT", "START", "PAUSE", "RESUME", "COMPLETE", "SEND_TO_REWORK", "CLOSE", "CANCEL"]),
  comment: z.string().optional(),
  completionText: z.string().optional(),
  faultCodeId: z.number().int().positive().optional(),
  afterPhotoUrls: z.array(z.string().transform(normalizePhotoUrl)).max(5).default([]),
  materials: z.array(z.object({ materialId: z.number().int().positive(), quantity: z.number().positive() })).default([]),
  masterScore: z.number().int().min(1).max(5).optional()
  ,clientActionId: z.string().min(8).max(100).optional()
  ,actualDowntimeMinutes: z.number().int().nonnegative().optional()
});

workOrdersRouter.post("/:id/action", asyncHandler(async (req, res) => {
  const input = actionSchema.parse(req.body);
  const id = Number(req.params.id);
  const order = await prisma.workOrder.findUnique({ where: { id } });
  if (!order) throw new HttpError(404, "Наряд не найден");
  if (input.clientActionId) {
    const existing = await prisma.workOrderEvent.findUnique({ where: { clientActionId: input.clientActionId } });
    if (existing) return res.json({ order: await prisma.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude }), replayed: true });
  }
  const masterActions: WorkOrderAction[] = ["SEND_TO_REWORK", "CLOSE", "CANCEL"];
  if (masterActions.includes(input.action) && req.user!.role !== Role.MASTER && req.user!.role !== Role.ADMIN) throw new HttpError(403, "Действие доступно мастеру");
  if (!masterActions.includes(input.action) && req.user!.role === Role.EXECUTOR && order.assigneeId !== req.user!.id) throw new HttpError(403, "Это не ваш наряд");
  if (input.action === "REJECT" && !input.comment) throw new HttpError(400, "Укажите причину отклонения");
  if (input.action === "PAUSE" && !input.comment) throw new HttpError(400, "Укажите причину приостановки");

  let target: WorkOrderStatus;
  try { target = nextStatus(order.status, input.action); }
  catch (error) { throw new HttpError(409, (error as Error).message); }

  const now = new Date();
  const replay = async () => res.json({ order: await prisma.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude }), replayed: true });
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = { status: target };
      if (input.action === "ACCEPT") data.acceptedAt = now;
      if (input.action === "START") data.startedAt = order.startedAt ?? now;
      if (input.action === "PAUSE") data.pauseReason = input.comment;
      if (input.action === "REJECT") data.rejectionReason = input.comment;
      if (input.action === "COMPLETE") Object.assign(data, { completedAt: now, completionText: input.completionText, faultCodeId: input.faultCodeId });
      if (input.action === "CLOSE") Object.assign(data, { closedAt: now, actualDowntimeMinutes: input.actualDowntimeMinutes });
      await tx.workOrder.update({ where: { id }, data });
      if (input.action === "COMPLETE") {
        if (input.afterPhotoUrls.length) await tx.photo.createMany({ data: input.afterPhotoUrls.map((fileUrl) => ({ workOrderId: id, authorId: req.user!.id, type: PhotoType.AFTER, fileUrl })) });
        for (const item of input.materials) await tx.materialUsage.upsert({ where: { workOrderId_materialId: { workOrderId: id, materialId: item.materialId } }, create: { workOrderId: id, ...item }, update: { quantity: item.quantity } });
      }
      if (input.action === "CLOSE" && input.masterScore) {
        const review = { masterScore: input.masterScore, masterComment: input.comment, reviewedById: req.user!.id };
        // Orders imported in AI_REVIEW may have no AI assessment yet: record the master's decision alone.
        await tx.aiAssessment.upsert({
          where: { workOrderId: id },
          update: review,
          create: { workOrderId: id, ...review, verdict: input.masterScore >= 3 ? AiVerdict.ACCEPTED : AiVerdict.ACCEPTED_WITH_COMMENTS, score: input.masterScore, explanation: "Оценка мастера без AI-проверки" }
        });
      }
      if (input.action === "CLOSE" || input.action === "CANCEL") await tx.equipmentDowntime.updateMany({ where: { workOrderId: id, endedAt: null }, data: { endedAt: now } });
      await tx.workOrderEvent.create({ data: { workOrderId: id, actorId: req.user!.id, action: input.action, fromStatus: order.status, toStatus: target, comment: input.comment, clientActionId: input.clientActionId } });
      return tx.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
    });
  } catch (error) {
    // A concurrent retry with the same clientActionId won the race: answer like a replay.
    if (input.clientActionId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return replay();
    throw error;
  }

  await refreshEmployeeStatus(order.assigneeId);
  let assessment = null;
  let finalOrder = updated;
  if (input.action === "COMPLETE") {
    assessment = await reviewWorkOrder(id);
    finalOrder = await prisma.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
  }
  // Self-learning: the master's verdict becomes a precedent for the next similar report.
  // Not awaited: a cold embedding model must not delay the master's response.
  if (input.action === "CLOSE" || input.action === "SEND_TO_REWORK") void learnFromMasterDecision(id).catch((error) => console.error("RAG learn:", error));
  emitOrderChanged(finalOrder);
  await enqueueWorkOrderSync(id, input.action);
  res.json({ order: finalOrder, assessment });
}));

/** A comment without a status change («ждём подшипник со склада»): the executor on their order, staff on any. */
workOrdersRouter.post("/:id/comment", asyncHandler(async (req, res) => {
  const { comment, clientActionId } = z.object({ comment: z.string().trim().min(1).max(2000), clientActionId: z.string().min(8).max(100).optional() }).parse(req.body);
  const id = Number(req.params.id);
  const order = await prisma.workOrder.findUnique({ where: { id } });
  if (!order) throw new HttpError(404, "Наряд не найден");
  if (req.user!.role === Role.EXECUTOR && order.assigneeId !== req.user!.id) throw new HttpError(403, "Это не ваш наряд");
  if (clientActionId && await prisma.workOrderEvent.findUnique({ where: { clientActionId } })) return res.json({ order: await prisma.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude }), replayed: true });
  try {
    await prisma.workOrderEvent.create({ data: { workOrderId: id, actorId: req.user!.id, action: "COMMENT", fromStatus: order.status, toStatus: order.status, comment, clientActionId } });
  } catch (error) {
    if (!(clientActionId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
  const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
  emitOrderChanged(updated);
  res.status(201).json({ order: updated });
}));

workOrdersRouter.patch("/:id", allow(Role.MASTER, Role.ADMIN), asyncHandler(async (req, res) => {
  const input = z.object({
    priority: z.enum(["EMERGENCY", "HIGH", "NORMAL", "PLANNED"]).optional(),
    deadline: z.coerce.date().optional(),
    comment: z.string().optional()
  }).parse(req.body);
  const order = await prisma.workOrder.update({ where: { id: Number(req.params.id) }, data: input, include: orderInclude });
  await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: req.user!.id, action: "EDIT", toStatus: order.status, comment: input.comment } });
  emitOrderChanged(order);
  await enqueueWorkOrderSync(order.id, "EDITED");
  res.json(order);
}));

workOrdersRouter.post("/:id/reassign", allow(Role.MASTER, Role.ADMIN), asyncHandler(async (req, res) => {
  const { assigneeId } = z.object({ assigneeId: z.number().int().positive() }).parse(req.body);
  const previous = await prisma.workOrder.findUnique({ where: { id: Number(req.params.id) }, select: { assigneeId: true, status: true } });
  if (!previous) throw new HttpError(404, "Наряд не найден");
  if (NOT_REASSIGNABLE.includes(previous.status)) throw new HttpError(409, `Наряд в статусе ${previous.status} нельзя переназначить`);
  if (!await prisma.user.findFirst({ where: { id: assigneeId, role: Role.EXECUTOR } })) throw new HttpError(400, "Назначить можно только исполнителя");
  const order = await prisma.workOrder.update({ where: { id: Number(req.params.id) }, data: { assigneeId, status: WorkOrderStatus.ISSUED }, include: orderInclude });
  await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: req.user!.id, action: "REASSIGN", toStatus: WorkOrderStatus.ISSUED } });
  await notify({ userId: assigneeId, workOrderId: order.id, type: "NEW_ORDER", title: `Наряд ${order.number} переназначен вам`, message: order.description });
  await Promise.all([refreshEmployeeStatus(previous.assigneeId), refreshEmployeeStatus(assigneeId)]);
  emitOrderChanged(order, [previous.assigneeId]);
  await enqueueWorkOrderSync(order.id, "REASSIGNED");
  res.json(order);
}));
