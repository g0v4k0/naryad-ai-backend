import { Router } from "express";
import { Role } from "@prisma/client";
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
referencesRouter.get("/executors", asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { role: Role.EXECUTOR },
    select: {
      id: true,
      fullName: true,
      specialty: true,
      grade: true,
      employeeStatus: true,
      isOnShift: true,
      _count: {
        select: {
          assignedOrders: {
            where: { status: { in: ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] } }
          }
        }
      }
    }
  });
  res.json(users);
}));
