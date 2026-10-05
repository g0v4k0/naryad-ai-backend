import { IntegrationEntity, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { allow, auth } from "../middleware/auth.js";
import { oneCAuth } from "../middleware/one-c-auth.js";
import { enqueueWorkOrderSync, importFromOneC, processOneCJobs } from "../services/one-c.js";

export const integrationsRouter = Router();

const importSchema = z.object({
  requestId: z.string().min(8).max(191),
  entity: z.enum(["AREA", "EQUIPMENT", "BRIGADE", "EMPLOYEE", "FAULT_CODE", "MATERIAL", "NORMATIVE", "WORK_ORDER"]),
  items: z.array(z.record(z.string(), z.unknown()).and(z.object({ externalId: z.string().min(1) }))).min(1).max(1000)
});

// Вызывается сервером 1С. JWT пользователя не нужен, используется отдельный общий ключ.
integrationsRouter.post("/1c/import", oneCAuth, asyncHandler(async (req, res) => {
  const input = importSchema.parse(req.body);
  res.json(await importFromOneC(input.requestId, input.entity as IntegrationEntity, input.items));
}));

integrationsRouter.get("/1c/ping", oneCAuth, (_req, res) => res.json({ status: "ok", service: "naryad-ai", time: new Date() }));

// Управление интеграцией из панели администратора.
integrationsRouter.use(auth, allow(Role.ADMIN, Role.MANAGER));

integrationsRouter.get("/orders", asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
  res.json(await prisma.workOrder.findMany({ where: { updatedAt: { gte: since } }, include: { area: true, equipment: true, assignee: { select: { fullName: true } }, faultCode: true, materialUsages: { include: { material: true } }, aiAssessment: true }, orderBy: { updatedAt: "asc" }, take: 5000 }));
}));

integrationsRouter.get("/1c/jobs", asyncHandler(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status.split(",") as Array<"PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "DEAD"> : undefined;
  res.json(await prisma.integrationJob.findMany({ where: status ? { status: { in: status } } : {}, orderBy: { createdAt: "desc" }, take: Math.min(500, Number(req.query.limit ?? 100)) }));
}));

integrationsRouter.get("/1c/mappings", asyncHandler(async (req, res) => {
  const entity = req.query.entity ? String(req.query.entity) as IntegrationEntity : undefined;
  res.json(await prisma.integrationMapping.findMany({ where: entity ? { entity } : {}, orderBy: [{ entity: "asc" }, { localId: "asc" }] }));
}));

integrationsRouter.post("/1c/run", asyncHandler(async (_req, res) => res.json(await processOneCJobs(100))));

integrationsRouter.post("/1c/jobs/:id/retry", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const job = await prisma.integrationJob.findUnique({ where: { id } });
  if (!job) throw new HttpError(404, "Задание синхронизации не найдено");
  res.json(await prisma.integrationJob.update({ where: { id }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } }));
}));

integrationsRouter.post("/1c/push/orders", asyncHandler(async (req, res) => {
  const input = z.object({ ids: z.array(z.number().int().positive()).max(500).optional(), since: z.coerce.date().optional() }).parse(req.body);
  const orders = await prisma.workOrder.findMany({ where: { ...(input.ids ? { id: { in: input.ids } } : {}), ...(input.since ? { updatedAt: { gte: input.since } } : {}) }, select: { id: true, updatedAt: true }, take: 500 });
  const jobs = [];
  for (const order of orders) jobs.push(await enqueueWorkOrderSync(order.id, "UPSERT", `naryad:out:${order.id}:${order.updatedAt.toISOString()}`));
  res.status(202).json({ queued: jobs.length, jobIds: jobs.map((x) => x.id) });
}));
