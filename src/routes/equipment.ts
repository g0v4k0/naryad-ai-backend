import { Router } from "express";
import QRCode from "qrcode";
import { asyncHandler, HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";
import { config } from "../config.js";

export const equipmentRouter = Router();
equipmentRouter.use(auth);
equipmentRouter.get("/qr/:token", asyncHandler(async (req, res) => {
  const equipment = await prisma.equipment.findUnique({ where: { qrToken: String(req.params.token) }, include: { area: true } });
  if (!equipment) throw new HttpError(404, "Оборудование не найдено");
  res.json(equipment);
}));
equipmentRouter.get("/:id/qr.png", asyncHandler(async (req, res) => {
  const equipment = await prisma.equipment.findUnique({ where: { id: Number(req.params.id) } });
  if (!equipment) throw new HttpError(404, "Оборудование не найдено");
  const png = await QRCode.toBuffer(`${config.PUBLIC_APP_URL}/equipment/${equipment.qrToken}`, { width: 512, margin: 2 });
  res.type("png").send(png);
}));
equipmentRouter.get("/:id/history", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  res.json(await prisma.equipment.findUnique({ where: { id }, include: { area: true, orders: { include: { faultCode: true, aiAssessment: true, downtime: true, materialUsages: { include: { material: true } } }, orderBy: { createdAt: "desc" } } } }));
}));
