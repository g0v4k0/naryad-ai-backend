import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { auth } from "../middleware/auth.js";
import { recommendExecutors, suggestFaultAndNormative } from "../services/recommendations.js";

export const recommendationsRouter = Router();
recommendationsRouter.use(auth);
recommendationsRouter.get("/executors", asyncHandler(async (req, res) => {
  const { equipmentId, ...hints } = z.object({
    equipmentId: z.coerce.number().int().positive(),
    specialty: z.string().trim().min(1).optional(),
    faultCodeId: z.coerce.number().int().positive().optional(),
    description: z.string().max(2000).optional(),
    brigadeId: z.coerce.number().int().positive().optional()
  }).parse(req.query);
  res.json(await recommendExecutors(equipmentId, hints));
}));
recommendationsRouter.post("/work", asyncHandler(async (req, res) => {
  const input = z.object({ description: z.string().min(3), equipmentId: z.number().int().positive() }).parse(req.body);
  res.json(await suggestFaultAndNormative(input.description, input.equipmentId));
}));
