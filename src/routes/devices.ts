import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";

export const devicesRouter = Router();
devicesRouter.use(auth);
devicesRouter.post("/", asyncHandler(async (req, res) => {
  const input = z.object({ token: z.string().min(20), platform: z.enum(["android", "ios", "web"]) }).parse(req.body);
  const device = await prisma.pushDevice.upsert({ where: { token: input.token }, create: { ...input, userId: req.user!.id }, update: { ...input, userId: req.user!.id } });
  res.status(201).json(device);
}));
devicesRouter.delete("/:token", asyncHandler(async (req, res) => {
  const result = await prisma.pushDevice.deleteMany({ where: { token: String(req.params.token), userId: req.user!.id } });
  res.json({ deleted: result.count });
}));
