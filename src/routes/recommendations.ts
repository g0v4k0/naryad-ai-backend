import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { auth } from "../middleware/auth.js";
import { recommendExecutors, suggestFaultAndNormative } from "../services/recommendations.js";

export const recommendationsRouter = Router();
recommendationsRouter.use(auth);
recommendationsRouter.get("/executors", asyncHandler(async (req, res) => res.json(await recommendExecutors(Number(req.query.equipmentId)))));
recommendationsRouter.post("/work", asyncHandler(async (req, res) => {
  const input = z.object({ description: z.string().min(3), equipmentId: z.number().int().positive() }).parse(req.body);
  res.json(await suggestFaultAndNormative(input.description, input.equipmentId));
}));
