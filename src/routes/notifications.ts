import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(auth);

notificationsRouter.get("/", asyncHandler(async (req, res) => {
  res.json(await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 100 }));
}));
notificationsRouter.patch("/:id/read", asyncHandler(async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { id: Number(req.params.id), userId: req.user!.id }, data: { isRead: true } });
  res.json({ updated: result.count });
}));
