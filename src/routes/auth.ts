import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/login", asyncHandler(async (req, res) => {
  const input = z.object({ login: z.string().min(1), pin: z.string().min(4).max(12) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { login: input.login } });
  if (!user || !(await bcrypt.compare(input.pin, user.pinHash))) throw new HttpError(401, "Неверный логин или ПИН");
  const token = jwt.sign({ sub: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: { id: user.id, fullName: user.fullName, role: user.role, employeeStatus: user.employeeStatus } });
}));

authRouter.get("/me", auth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, omit: { pinHash: true } });
  res.json(user);
}));
