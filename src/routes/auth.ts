import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { assertLoginAllowed, registerLoginFailure, registerLoginSuccess } from "../lib/login-throttle.js";
import { hashPassword, newPasswordSchema, verifyPassword } from "../lib/password.js";
import { phoneSchema } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { auth } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/login", asyncHandler(async (req, res) => {
  // No minimum length here: accounts created before the password rules may still have a shorter one.
  const input = z.object({ phone: phoneSchema, password: z.string().min(1).max(128) }).parse(req.body);
  const ip = req.ip ?? "unknown";
  assertLoginAllowed(input.phone, ip);
  const user = await prisma.user.findUnique({ where: { phone: input.phone } });
  const check = user ? await verifyPassword(input.password, user.passwordHash) : { ok: false, needsRehash: false };
  if (!user || !check.ok) {
    registerLoginFailure(input.phone, ip);
    throw new HttpError(401, "Неверный номер телефона или пароль");
  }
  registerLoginSuccess(input.phone);
  if (check.needsRehash) await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.password) } });
  const token = jwt.sign({ sub: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: { id: user.id, fullName: user.fullName, phone: user.phone, role: user.role, employeeStatus: user.employeeStatus } });
}));

authRouter.get("/me", auth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, omit: { passwordHash: true } });
  res.json(user);
}));

authRouter.post("/change-password", auth, asyncHandler(async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: newPasswordSchema }).parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash)).ok) throw new HttpError(400, "Текущий пароль указан неверно");
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.newPassword) } });
  res.status(204).send();
}));
