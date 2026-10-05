import { Router } from "express";
import { PhotoType, Role, WorkOrderStatus } from "@prisma/client";
import { z } from "zod";
import { nextStatus, type WorkOrderAction } from "../domain/work-order-state.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { allow, auth } from "../middleware/auth.js";
import { emitOrderChanged } from "../realtime.js";
import { reviewWorkOrder } from "../services/ai-review.js";
import { notify } from "../services/notifications.js";
import { refreshEmployeeStatus } from "../services/employee-status.js";
import { enqueueWorkOrderSync } from "../services/one-c.js";

export const workOrdersRouter = Router();
workOrdersRouter.use(auth);

const orderInclude = {
  area: true,
  equipment: true,
  creator: { select: { id: true, fullName: true } },
  assignee: { select: { id: true, fullName: true, specialty: true, employeeStatus: true } },
  faultCode: true,
  photos: true,
  materialUsages: { include: { material: true } },
  aiAssessment: true
} as const;

workOrdersRouter.get("/", asyncHandler(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status.split(",") as WorkOrderStatus[] : undefined;
  const where = {
    ...(status ? { status: { in: status } } : {}),
    ...(req.query.areaId ? { areaId: Number(req.query.areaId) } : {}),
    ...(req.query.assigneeId ? { assigneeId: Number(req.query.assigneeId) } : {}),
    ...(req.user!.role === Role.EXECUTOR ? { assigneeId: req.user!.id } : {})
  };
  res.json(await prisma.workOrder.findMany({ where, include: orderInclude, orderBy: [{ priority: "asc" }, { deadline: "asc" }], take: 200 }));
}));

workOrdersRouter.get("/:id", asyncHandler(async (req, res) => {
  const order = await prisma.workOrder.findUnique({
    where: { id: Number(req.params.id) },
    include: { ...orderInclude, events: { include: { actor: { select: { id: true, fullName: true } } }, orderBy: { createdAt: "asc" } } }
  });
  if (!order) throw new HttpError(404, "Наряд не найден");
  if (req.user!.role === Role.EXECUTOR && order.assigneeId !== req.user!.id) throw new HttpError(403, "Это не ваш наряд");
  res.json(order);
}));

workOrdersRouter.post("/", allow(Role.MASTER, Role.ADMIN), asyncHandler(async (req, res) => {
  const input = z.object({
    type: z.enum(["PLANNED", "EMERGENCY"]),
    description: z.string().min(3),
    areaId: z.number().int().positive(),
    equipmentId: z.number().int().positive(),
    assigneeId: z.number().int().positive(),
    deadline: z.coerce.date().optional(),
    priority: z.enum(["EMERGENCY", "HIGH", "NORMAL", "PLANNED"]),
    normativeId: z.number().int().positive().optional(),
    comment: z.string().optional(),
    beforePhotoUrls: z.array(z.string()).max(5).default([])
  }).refine((value) => value.deadline || value.normativeId, { message: "Укажите срок или норматив" }).parse(req.body);
  const equipment = await prisma.equipment.findFirst({ where: { id: input.equipmentId, areaId: input.areaId } });
  const assignee = await prisma.user.findFirst({ where: { id: input.assigneeId, role: Role.EXECUTOR } });
  if (!equipment || !assignee) throw new HttpError(400, "Проверьте оборудование и исполнителя");
  const normative = input.normativeId ? await prisma.workNormative.findUnique({ where: { id: input.normativeId } }) : null;
  if (input.normativeId && !normative) throw new HttpError(400, "Норматив не найден");
  const deadline = input.deadline ?? new Date(Date.now() + Number(normative?.hours ?? 2) * 3_600_000);
  const number = `N-${Date.now().toString().slice(-8)}`;
  const { beforePhotoUrls, ...orderInput } = input;
  const orderData = { ...orderInput, deadline };
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
  await notify({ userId: input.assigneeId, workOrderId: order.id, type: "NEW_ORDER", title: `Новый наряд ${number}`, message: input.description, data: { priority: order.priority } });
  await refreshEmployeeStatus(input.assigneeId);
  await enqueueWorkOrderSync(order.id, "CREATED");
  emitOrderChanged(order);
  res.status(201).json(order);
}));

const actionSchema = z.object({
  action: z.enum(["ACCEPT", "QUEUE", "REJECT", "START", "PAUSE", "RESUME", "COMPLETE", "SEND_TO_REWORK", "CLOSE", "CANCEL"]),
  comment: z.string().optional(),
  completionText: z.string().optional(),
  faultCodeId: z.number().int().positive().optional(),
  afterPhotoUrls: z.array(z.string()).max(5).default([]),
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
  const updated = await prisma.$transaction(async (tx) => {
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
    if (input.action === "CLOSE" && input.masterScore) await tx.aiAssessment.update({ where: { workOrderId: id }, data: { masterScore: input.masterScore, masterComment: input.comment, reviewedById: req.user!.id } });
    if (input.action === "CLOSE") await tx.equipmentDowntime.updateMany({ where: { workOrderId: id, endedAt: null }, data: { endedAt: now } });
    await tx.workOrderEvent.create({ data: { workOrderId: id, actorId: req.user!.id, action: input.action, fromStatus: order.status, toStatus: target, comment: input.comment, clientActionId: input.clientActionId } });
    return tx.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
  });

  await refreshEmployeeStatus(order.assigneeId);
  let assessment = null;
  let finalOrder = updated;
  if (input.action === "COMPLETE") {
    assessment = await reviewWorkOrder(id);
    finalOrder = await prisma.workOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
  }
  emitOrderChanged(finalOrder);
  await enqueueWorkOrderSync(id, input.action);
  res.json({ order: finalOrder, assessment });
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
  const previous = await prisma.workOrder.findUniqueOrThrow({ where: { id: Number(req.params.id) }, select: { assigneeId: true } });
  const order = await prisma.workOrder.update({ where: { id: Number(req.params.id) }, data: { assigneeId, status: WorkOrderStatus.ISSUED }, include: orderInclude });
  await prisma.workOrderEvent.create({ data: { workOrderId: order.id, actorId: req.user!.id, action: "REASSIGN", toStatus: WorkOrderStatus.ISSUED } });
  await notify({ userId: assigneeId, workOrderId: order.id, type: "NEW_ORDER", title: `Наряд ${order.number} переназначен вам`, message: order.description });
  await Promise.all([refreshEmployeeStatus(previous.assigneeId), refreshEmployeeStatus(assigneeId)]);
  emitOrderChanged(order);
  await enqueueWorkOrderSync(order.id, "REASSIGNED");
  res.json(order);
}));
