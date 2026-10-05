import { Router } from "express";
import { Prisma, Role } from "@prisma/client";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { allow, auth } from "../middleware/auth.js";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import type { Request } from "express";
import { askOllama } from "../services/ollama.js";

export const reportsRouter = Router();
reportsRouter.use(auth, allow(Role.MASTER, Role.MANAGER, Role.ADMIN));

function reportWhere(req: Request, defaultFrom: Date): Prisma.WorkOrderWhereInput {
  const from = req.query.from ? new Date(String(req.query.from)) : defaultFrom;
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  return {
    createdAt: { gte: from, lte: to },
    ...(req.query.areaId ? { areaId: Number(req.query.areaId) } : {}),
    ...(req.query.equipmentId ? { equipmentId: Number(req.query.equipmentId) } : {}),
    ...(req.query.executorId ? { assigneeId: Number(req.query.executorId) } : {}),
    ...(req.query.brigadeId ? { assignee: { brigadeId: Number(req.query.brigadeId) } } : {})
  };
}

reportsRouter.get("/shift", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 12 * 60 * 60 * 1000);
  const orders = await prisma.workOrder.findMany({ where: reportWhere(req, from), select: { status: true, deadline: true, startedAt: true, completedAt: true } });
  const now = new Date();
  const report = {
    from,
    issued: orders.length,
    completed: orders.filter((x) => ["COMPLETED", "AI_REVIEW", "CLOSED"].includes(x.status)).length,
    closed: orders.filter((x) => x.status === "CLOSED").length,
    overdue: orders.filter((x) => x.deadline < now && !["CLOSED", "CANCELLED"].includes(x.status)).length
  };
  let aiSummary = `За период выдано ${report.issued}, закрыто ${report.closed}, просрочено ${report.overdue}.`;
  try {
    const summary = (await askOllama<{ summary?: unknown }>("Верни JSON summary: краткая производственная сводка на русском без выдуманных фактов.", JSON.stringify(report))).summary;
    if (typeof summary === "string" && summary.trim()) aiSummary = summary;
  } catch { /* deterministic summary is enough when Ollama is offline */ }
  res.json({ ...report, aiSummary });
}));

reportsRouter.get("/ratings", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const users = await prisma.user.findMany({ where: { role: Role.EXECUTOR }, select: { id: true, fullName: true, events: { where: { action: "REJECT", createdAt: { gte: from } }, select: { comment: true } }, assignedOrders: { where: { closedAt: { gte: from } }, select: { deadline: true, closedAt: true, priority: true, aiAssessment: { select: { score: true, masterScore: true, verdict: true } } } } } });
  const ratings = users.map((user) => {
    const done = user.assignedOrders;
    const quality = done.length ? done.reduce((s, x) => s + (x.aiAssessment?.masterScore ?? x.aiAssessment?.score ?? 0), 0) / done.length : 0;
    const onTime = done.length ? done.filter((x) => x.closedAt! <= x.deadline).length / done.length : 0;
    const reworkRate = done.length ? done.filter((x) => x.aiAssessment?.verdict === "REWORK_REQUIRED").length / done.length : 0;
    const productivity = Math.min(1, done.length / 20);
    const unjustifiedRejects = user.events.filter((event) => !event.comment || !/(материал|допуск|аварийн|безопасн|смен)/i.test(event.comment)).length;
    const complexityBonus = Math.min(5, done.filter((x) => x.priority === "EMERGENCY" || x.priority === "HIGH").length);
    const score = Math.max(0, Math.round((quality / 5 * 45 + onTime * 25 + (1 - reworkRate) * 15 + productivity * 10 + complexityBonus - unjustifiedRejects * 2) * 10) / 10);
    return { id: user.id, fullName: user.fullName, score, quality: Math.round(quality * 100) / 100, onTimeRate: onTime, reworkRate, productivity, unjustifiedRejects, complexityBonus, closed: done.length, explanation: `Качество 45%, сроки 25%, отсутствие доработок 15%, объём 10%, сложность до 5 баллов, необоснованный отказ -2` };
  });
  res.json(ratings.sort((a, b) => b.score - a.score));
}));

reportsRouter.get("/brigade-ratings", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86_400_000);
  const brigades = await prisma.brigade.findMany({ include: { members: { include: { assignedOrders: { where: { closedAt: { gte: from } }, include: { aiAssessment: true } } } } } });
  res.json(brigades.map((brigade) => {
    const orders = brigade.members.flatMap((member) => member.assignedOrders);
    const quality = orders.length ? orders.reduce((sum, order) => sum + (order.aiAssessment?.masterScore ?? order.aiAssessment?.score ?? 0), 0) / orders.length : 0;
    const onTime = orders.length ? orders.filter((order) => order.closedAt! <= order.deadline).length / orders.length : 0;
    return { id: brigade.id, name: brigade.name, closed: orders.length, quality: Math.round(quality * 100) / 100, onTimeRate: onTime, score: Math.round((quality / 5 * 70 + onTime * 30) * 10) / 10 };
  }).sort((a, b) => b.score - a.score));
}));

reportsRouter.get("/materials", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86_400_000);
  const usages = await prisma.materialUsage.groupBy({ by: ["materialId"], where: { workOrder: { createdAt: { gte: from }, ...(req.query.areaId ? { areaId: Number(req.query.areaId) } : {}) } }, _sum: { quantity: true }, _count: true });
  const materials = await prisma.material.findMany({ where: { id: { in: usages.map((x) => x.materialId) } } });
  res.json(usages.map((x) => ({ ...x, material: materials.find((m) => m.id === x.materialId) })));
}));

reportsRouter.get("/downtime", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.equipmentDowntime.findMany({ where: { startedAt: { gte: from } }, include: { equipment: { include: { area: true } }, workOrder: { include: { faultCode: true } } } });
  res.json(rows.map((row) => ({ ...row, minutes: Math.round(((row.endedAt ?? new Date()).getTime() - row.startedAt.getTime()) / 60_000) })));
}));

reportsRouter.get("/work-order/:id", asyncHandler(async (req, res) => {
  const order = await prisma.workOrder.findUnique({ where: { id: Number(req.params.id) }, include: { area: true, equipment: true, creator: { select: { fullName: true } }, assignee: { select: { fullName: true } }, events: true, photos: true, materialUsages: { include: { material: true } }, aiAssessment: true } });
  res.json(order);
}));

reportsRouter.get("/export.xlsx", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86_400_000);
  const orders = await prisma.workOrder.findMany({ where: reportWhere(req, from), include: { area: true, equipment: true, assignee: { select: { fullName: true } }, aiAssessment: true } });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Наряды");
  sheet.columns = [
    { header: "Номер", key: "number", width: 14 }, { header: "Участок", key: "area", width: 24 },
    { header: "Оборудование", key: "equipment", width: 26 }, { header: "Исполнитель", key: "assignee", width: 24 },
    { header: "Статус", key: "status", width: 18 }, { header: "Срок", key: "deadline", width: 22 }, { header: "Оценка", key: "score", width: 10 }
  ];
  orders.forEach((x) => sheet.addRow({ number: x.number, area: x.area.name, equipment: x.equipment.name, assignee: x.assignee.fullName, status: x.status, deadline: x.deadline, score: x.aiAssessment?.masterScore ?? x.aiAssessment?.score }));
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("content-disposition", "attachment; filename=naryad-report.xlsx");
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(buffer));
}));

reportsRouter.get("/export.pdf", asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 12 * 3_600_000);
  const orders = await prisma.workOrder.findMany({ where: reportWhere(req, from), include: { equipment: true, assignee: { select: { fullName: true } } }, take: 200 });
  const document = new PDFDocument({ margin: 40 });
  const font = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
  if (font) document.font(font);
  res.setHeader("content-disposition", "attachment; filename=naryad-report.pdf");
  res.type("application/pdf");
  document.pipe(res);
  document.fontSize(18).text("Отчёт НарядAI");
  document.moveDown().fontSize(10).text(`Период с ${from.toLocaleString("ru-RU")}`);
  document.moveDown();
  for (const order of orders) document.text(`${order.number} | ${order.equipment.name} | ${order.assignee.fullName} | ${order.status}`);
  document.end();
}));
