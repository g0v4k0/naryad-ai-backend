import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";
import { answerAssistant } from "../services/assistant.js";

export const assistantRouter = Router();
assistantRouter.use(auth);
assistantRouter.post("/chat", asyncHandler(async (req, res) => {
  const { message } = z.object({ message: z.string().min(2).max(1000) }).parse(req.body);
  res.json(await answerAssistant(req.user!.id, message));
}));
assistantRouter.get("/history", asyncHandler(async (req, res) => {
  res.json(await prisma.assistantMessage.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 100 }));
}));
