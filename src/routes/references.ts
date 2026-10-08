import { Router } from "express";
import { Role } from "@prisma/client";
import { z } from "zod";
import { asyncHandler, HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";
import { describeWorkload, openOrdersSelect } from "../services/employee-status.js";

export const referencesRouter = Router();
referencesRouter.use(auth);

referencesRouter.get("/areas", asyncHandler(async (_req, res) => {
  res.json(await prisma.area.findMany({ orderBy: { name: "asc" } }));
}));
referencesRouter.get("/equipment", asyncHandler(async (req, res) => {
  const areaId = req.query.areaId ? Number(req.query.areaId) : undefined;
  res.json(await prisma.equipment.findMany({ where: { areaId }, orderBy: { name: "asc" } }));
}));
referencesRouter.get("/fault-codes", asyncHandler(async (_req, res) => {
  res.json(await prisma.faultCode.findMany({ orderBy: { code: "asc" } }));
}));
referencesRouter.get("/materials", asyncHandler(async (_req, res) => {
  res.json(await prisma.material.findMany({ orderBy: { name: "asc" } }));
}));
referencesRouter.get("/brigades", asyncHandler(async (_req, res) => {
  res.json(await prisma.brigade.findMany({ include: { members: { select: { id: true, fullName: true, specialty: true } } } }));
}));
/** With equipmentId: the normatives of that unit and of its equipment type (most normatives are set per type). */
referencesRouter.get("/normatives", asyncHandler(async (req, res) => {
  const { equipmentId } = z.object({ equipmentId: z.coerce.number().int().positive().optional() }).parse(req.query);
  const equipment = equipmentId ? await prisma.equipment.findUnique({ where: { id: equipmentId }, select: { type: true } }) : null;
  if (equipmentId && !equipment) throw new HttpError(404, "Оборудование не найдено");
  res.json(await prisma.workNormative.findMany({
    where: equipment ? { OR: [{ equipmentId }, { equipmentId: null, equipmentType: equipment.type }] } : {},
    include: { faultCode: true, materialNorms: { include: { material: true } } },
    orderBy: { name: "asc" }
  }));
}));
/** Executors with what the master needs when assigning: "свободен / выполняет наряд №… / в очереди N / не на смене". */
referencesRouter.get("/executors", asyncHandler(async (req, res) => {
  const filters = z.object({
    specialty: z.string().trim().min(1).optional(),
    brigadeId: z.coerce.number().int().positive().optional(),
    onShift: z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true").optional()
  }).parse(req.query);
  const users = await prisma.user.findMany({
    where: { role: Role.EXECUTOR, ...(filters.specialty ? { specialty: filters.specialty } : {}), ...(filters.brigadeId ? { brigadeId: filters.brigadeId } : {}), ...(filters.onShift !== undefined ? { isOnShift: filters.onShift } : {}) },
    select: {
      id: true,
      fullName: true,
      specialty: true,
      grade: true,
      brigadeId: true,
      brigade: { select: { id: true, name: true } },
      employeeStatus: true,
      isOnShift: true,
      assignedOrders: openOrdersSelect
    },
    orderBy: { fullName: "asc" }
  });
  res.json(users.map(({ assignedOrders, ...user }) => {
    const workload = describeWorkload(user.isOnShift, assignedOrders);
    // _count kept for clients written against the previous response.
    return { ...user, ...workload, _count: { assignedOrders: workload.activeOrders } };
  }));
}));
