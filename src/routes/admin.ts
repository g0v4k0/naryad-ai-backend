import { Router } from "express";
import { Role } from "@prisma/client";
import { hashPin } from "../lib/pin.js";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { allow, auth } from "../middleware/auth.js";

export const adminRouter = Router();
adminRouter.use(auth, allow(Role.ADMIN));

adminRouter.get("/users", asyncHandler(async (_req, res) => res.json(await prisma.user.findMany({ omit: { pinHash: true }, include: { brigade: true }, orderBy: { fullName: "asc" } }))));

adminRouter.post("/areas", asyncHandler(async (req, res) => res.status(201).json(await prisma.area.create({ data: z.object({ name: z.string().min(2) }).parse(req.body) }))));
adminRouter.patch("/areas/:id", asyncHandler(async (req, res) => res.json(await prisma.area.update({ where: { id: Number(req.params.id) }, data: z.object({ name: z.string().min(2) }).parse(req.body) }))));

adminRouter.post("/equipment", asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(2), inventoryNumber: z.string().min(2), type: z.string().min(2), criticality: z.number().int().min(1).max(5), areaId: z.number().int().positive() }).parse(req.body);
  res.status(201).json(await prisma.equipment.create({ data: input }));
}));
adminRouter.patch("/equipment/:id", asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(2).optional(), inventoryNumber: z.string().min(2).optional(), type: z.string().min(2).optional(), criticality: z.number().int().min(1).max(5).optional(), areaId: z.number().int().positive().optional() }).parse(req.body);
  res.json(await prisma.equipment.update({ where: { id: Number(req.params.id) }, data: input }));
}));

adminRouter.post("/fault-codes", asyncHandler(async (req, res) => {
  const input = z.object({ code: z.string().min(1), name: z.string().min(2), category: z.string().min(1) }).parse(req.body);
  res.status(201).json(await prisma.faultCode.create({ data: input }));
}));
adminRouter.post("/materials", asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(2), unit: z.string().min(1) }).parse(req.body);
  res.status(201).json(await prisma.material.create({ data: input }));
}));
adminRouter.post("/brigades", asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(2) }).parse(req.body);
  res.status(201).json(await prisma.brigade.create({ data: input }));
}));
adminRouter.post("/normatives", asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(2), equipmentType: z.string().optional(), equipmentId: z.number().int().positive().optional(), faultCodeId: z.number().int().positive().optional(), hours: z.number().positive(), materials: z.array(z.object({ materialId: z.number().int().positive(), quantity: z.number().positive() })).default([]) }).parse(req.body);
  const { materials, ...data } = input;
  res.status(201).json(await prisma.workNormative.create({ data: { ...data, materialNorms: { create: materials } }, include: { materialNorms: true } }));
}));
adminRouter.post("/users", asyncHandler(async (req, res) => {
  const input = z.object({ login: z.string().min(3), pin: z.string().min(4), fullName: z.string().min(3), role: z.enum(["MASTER", "EXECUTOR", "MANAGER", "ADMIN"]), specialty: z.string().optional(), grade: z.number().int().optional(), brigadeId: z.number().int().positive().optional(), language: z.enum(["ru", "kk"]).default("ru") }).parse(req.body);
  const { pin, ...data } = input;
  res.status(201).json(await prisma.user.create({ data: { ...data, pinHash: await hashPin(pin) }, omit: { pinHash: true } }));
}));
adminRouter.patch("/users/:id/shift", asyncHandler(async (req, res) => {
  const input = z.object({ isOnShift: z.boolean(), employeeStatus: z.enum(["AVAILABLE", "BUSY", "QUEUED", "OFF_SHIFT"]) }).parse(req.body);
  res.json(await prisma.user.update({ where: { id: Number(req.params.id) }, data: input, omit: { pinHash: true } }));
}));

adminRouter.delete("/:resource/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  switch (String(req.params.resource)) {
    case "areas": await prisma.area.delete({ where: { id } }); break;
    case "equipment": await prisma.equipment.delete({ where: { id } }); break;
    case "fault-codes": await prisma.faultCode.delete({ where: { id } }); break;
    case "materials": await prisma.material.delete({ where: { id } }); break;
    case "brigades": await prisma.brigade.delete({ where: { id } }); break;
    case "normatives": await prisma.workNormative.delete({ where: { id } }); break;
    default: return res.status(404).json({ error: "Неизвестный справочник" });
  }
  res.status(204).send();
}));
