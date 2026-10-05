import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { assertLoginAllowed, registerLoginFailure, registerLoginSuccess } from "../lib/login-throttle.js";
import { hashPin, verifyPin } from "../lib/pin.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/login", asyncHandler(async (req, res) => {
  const input = z.object({ login: z.string().min(1), pin: z.string().min(4).max(12) }).parse(req.body);
  const ip = req.ip ?? "unknown";
  assertLoginAllowed(input.login, ip);
  const user = await prisma.user.findUnique({ where: { login: input.login } });
  const check = user ? await verifyPin(input.pin, user.pinHash) : { ok: false, needsRehash: false };
  if (!user || !check.ok) {
    registerLoginFailure(input.login, ip);
    throw new HttpError(401, "Неверный логин или ПИН");
  }
  registerLoginSuccess(input.login);
  if (check.needsRehash) await prisma.user.update({ where: { id: user.id }, data: { pinHash: await hashPin(input.pin) } });
  const token = jwt.sign({ sub: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: { id: user.id, fullName: user.fullName, role: user.role, employeeStatus: user.employeeStatus } });
}));

authRouter.get("/me", auth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, omit: { pinHash: true } });
  res.json(user);
}));
