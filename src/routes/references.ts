import { Router } from "express";
import { Role, type WorkOrderStatus } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";

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
referencesRouter.get("/normatives", asyncHandler(async (req, res) => {
  res.json(await prisma.workNormative.findMany({ where: { ...(req.query.equipmentId ? { equipmentId: Number(req.query.equipmentId) } : {}) }, include: { faultCode: true, materialNorms: { include: { material: true } } } }));
}));
const WORKING: WorkOrderStatus[] = ["IN_PROGRESS", "PAUSED", "REWORK", "ACCEPTED"];
const WAITING: WorkOrderStatus[] = ["ISSUED", "QUEUED"];

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
      assignedOrders: {
        where: { status: { in: [...WORKING, ...WAITING] } },
        select: { id: true, number: true, status: true, priority: true, deadline: true, equipment: { select: { name: true } } },
        orderBy: [{ priority: "asc" }, { deadline: "asc" }]
      }
    },
    orderBy: { fullName: "asc" }
  });
  res.json(users.map(({ assignedOrders, ...user }) => {
    const working = assignedOrders.filter((x) => WORKING.includes(x.status));
    const current = working.find((x) => x.status === "IN_PROGRESS") ?? working[0] ?? null;
    const queue = assignedOrders.filter((x) => WAITING.includes(x.status)).length;
    const statusText = !user.isOnShift ? "не на смене"
      : current ? `выполняет наряд №${current.number}${queue ? `, в очереди ${queue}` : ""}`
        : queue ? `в очереди ${queue} ${queue === 1 ? "наряд" : queue < 5 ? "наряда" : "нарядов"}` : "свободен";
    // _count kept for clients written against the previous response.
    return { ...user, currentOrder: current, queue, activeOrders: assignedOrders.length, statusText, _count: { assignedOrders: assignedOrders.length } };
  }));
}));
