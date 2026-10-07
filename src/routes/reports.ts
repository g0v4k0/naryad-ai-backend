import { Router } from "express";
import { Role } from "@prisma/client";
import { z } from "zod";
import { asyncHandler, HttpError } from "../lib/http.js";
import { allow, auth } from "../middleware/auth.js";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import type { Response } from "express";
import { STATUS_LABELS } from "../lib/labels.js";
import { formatLocal } from "../lib/time.js";
import { masterOrderReport } from "../services/order-report.js";
import {
  buildBrigadeRatings, buildDowntimeReport, buildMaterialsReport, buildRatings, buildShiftReport, buildTable,
  EXPORTABLE, parseReportFilter, type Table
} from "../services/reports.js";

export const reportsRouter = Router();

/** The executor's own rating with the explanation (6.6). Declared before the staff-only guard. */
reportsRouter.get("/my-rating", auth, asyncHandler(async (req, res) => {
  const filter = parseReportFilter(req.query, "month");
  const [rating] = await buildRatings({ ...filter, executorId: req.user!.id, brigadeId: undefined });
  if (!rating) throw new HttpError(404, "Рейтинг считается только для исполнителей");
  res.json(rating);
}));

reportsRouter.use(auth, allow(Role.MASTER, Role.MANAGER, Role.ADMIN));

reportsRouter.get("/shift", asyncHandler(async (req, res) => res.json(await buildShiftReport(parseReportFilter(req.query, "shift")))));
reportsRouter.get("/ratings", asyncHandler(async (req, res) => res.json(await buildRatings(parseReportFilter(req.query, "month")))));
reportsRouter.get("/brigade-ratings", asyncHandler(async (req, res) => res.json(await buildBrigadeRatings(parseReportFilter(req.query, "month")))));

const materialsGroup = z.object({ groupBy: z.enum(["material", "area", "equipment", "executor"]).default("material") });
reportsRouter.get("/materials", asyncHandler(async (req, res) => {
  res.json(await buildMaterialsReport(parseReportFilter(req.query, "month"), materialsGroup.parse(req.query).groupBy));
}));
reportsRouter.get("/downtime", asyncHandler(async (req, res) => res.json(await buildDowntimeReport(parseReportFilter(req.query, "month")))));

function pdfDocument(res: Response, filename: string) {
  const document = new PDFDocument({ margin: 40 });
  const font = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
  if (font) document.font(font);
  res.setHeader("content-disposition", `attachment; filename=${filename}`);
  res.type("application/pdf");
  document.pipe(res);
  return document;
}

reportsRouter.get("/work-order/:id.pdf", asyncHandler(async (req, res) => {
  const order = await masterOrderReport(Number(req.params.id));
  if (!order) throw new HttpError(404, "Наряд не найден");
  const document = pdfDocument(res, `naryad-${order.number}.pdf`);
  document.fontSize(18).text(`Наряд ${order.number}`);
  document.moveDown(0.5).fontSize(10);
  const line = (label: string, value: unknown) => document.text(`${label}: ${value ?? "—"}`);
  line("Тип", order.type === "EMERGENCY" ? "аварийный" : "плановый");
  line("Участок", order.area.name);
  line("Оборудование", `${order.equipment.name} (${order.equipment.inventoryNumber})`);
  line("Исполнитель", order.assignee.fullName);
  line("Мастер", order.creator.fullName);
  line("Статус", STATUS_LABELS[order.status]);
  line("Срок", formatLocal(order.deadline));
  line("Описание", order.description);
  line("Выполненные работы", order.completionText);
  line("Шифр", order.faultCode ? `${order.faultCode.code} ${order.faultCode.name}` : null);
  line("Материалы", order.materialUsages.map((x) => `${x.material.name} ${x.quantity} ${x.material.unit}`).join(", ") || null);
  line("Фото до / после", `${order.photosBefore.length} / ${order.photosAfter.length}`);
  line("Время: факт / норматив, ч", `${order.timing.actualHours ?? "—"} / ${order.timing.normativeHours ?? "—"}`);
  line("Простой, мин", order.downtimeMinutes);
  if (order.aiAssessment) {
    line("Вердикт ИИ", `${order.aiAssessment.verdict}, оценка ${order.aiAssessment.score}${order.aiAssessment.needsMasterReview ? " (нужна проверка мастером)" : ""}`);
    line("Пояснение ИИ", order.aiAssessment.explanation);
    line("Оценка мастера", order.aiAssessment.masterScore);
  }
  document.moveDown().fontSize(12).text("Хронология");
  document.fontSize(9);
  for (const event of order.chronology) document.text(`${formatLocal(event.at)} — ${event.action}${event.to ? ` → ${STATUS_LABELS[event.to]}` : ""} — ${event.actor}${event.comment ? `: ${event.comment}` : ""}`);
  document.end();
}));

reportsRouter.get("/work-order/:id", asyncHandler(async (req, res) => {
  const report = await masterOrderReport(Number(req.params.id));
  if (!report) throw new HttpError(404, "Наряд не найден");
  res.json(report);
}));

const exportQuery = z.object({ report: z.enum(EXPORTABLE).default("orders"), groupBy: z.enum(["material", "area", "equipment", "executor"]).optional() });

async function exportTable(query: unknown) {
  const { report, groupBy } = exportQuery.parse(query);
  // The order list keeps its old default periods: 30 days in Excel, a shift in PDF is set by the caller.
  return { report, table: await buildTable(report, parseReportFilter(query, report === "shift" ? "shift" : "month"), { materialsGroupBy: groupBy }) };
}

reportsRouter.get("/export.xlsx", asyncHandler(async (req, res) => {
  const { report, table } = await exportTable(req.query);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.title);
  sheet.columns = table.columns;
  table.rows.forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true };
  if (table.summary?.length) {
    const summary = workbook.addWorksheet("Итоги");
    table.summary.forEach((text) => summary.addRow([text]));
    summary.getColumn(1).width = 120;
  }
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("content-disposition", `attachment; filename=naryad-${report}.xlsx`);
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(buffer));
}));

function writeTablePdf(document: PDFKit.PDFDocument, table: Table) {
  document.fontSize(9);
  for (const text of table.summary ?? []) document.text(text);
  if (table.summary?.length) document.moveDown();
  document.text(table.columns.map((c) => c.header).join(" | "), { underline: true });
  for (const row of table.rows) document.text(table.columns.map((c) => row[c.key] ?? "—").join(" | "));
}

reportsRouter.get("/export.pdf", asyncHandler(async (req, res) => {
  const query = { ...req.query } as Record<string, unknown>;
  // Without a period the order list in PDF is the current shift, as before.
  if (!query.from && !query.period && (query.report ?? "orders") === "orders") query.period = "shift";
  const { report, table } = await exportTable(query);
  const filter = parseReportFilter(query, "month");
  const document = pdfDocument(res, `naryad-${report}.pdf`);
  document.fontSize(18).text(`Отчёт НарядAI: ${table.title}`);
  document.moveDown().fontSize(10).text(`Период: ${formatLocal(filter.from)} — ${formatLocal(filter.to)}`);
  document.moveDown();
  writeTablePdf(document, table);
  document.end();
}));
