import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import { aiRouter } from "./routes/ai.js";
import { authRouter } from "./routes/auth.js";
import { notificationsRouter } from "./routes/notifications.js";
import { referencesRouter } from "./routes/references.js";
import { reportsRouter } from "./routes/reports.js";
import { workOrdersRouter } from "./routes/work-orders.js";
import { asyncHandler, errorHandler, HttpError } from "./lib/http.js";
import { auth } from "./middleware/auth.js";
import sharp from "sharp";
import { assistantRouter } from "./routes/assistant.js";
import { analyticsRouter } from "./routes/analytics.js";
import { devicesRouter } from "./routes/devices.js";
import { equipmentRouter } from "./routes/equipment.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { adminRouter } from "./routes/admin.js";
import { integrationsRouter } from "./routes/integrations.js";
import { prisma } from "./lib/prisma.js";
import { config } from "./config.js";
import { exifCaptureTime } from "./lib/exif.js";
import { exifWallTime } from "./lib/time.js";
import { requireUploadAccess, signJsonUploadUrls } from "./lib/signed-urls.js";

mkdirSync("uploads", { recursive: true });
const upload = multer({ dest: "uploads/", limits: { fileSize: 15 * 1024 * 1024 } });
export const app = express();
// Behind nginx on the same host: take the client IP from X-Forwarded-For (login throttling).
app.set("trust proxy", "loopback");
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));
app.use(signJsonUploadUrls);
app.use("/uploads", requireUploadAccess, express.static(resolve("uploads")));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", asyncHandler(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  const ollama = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((x) => x.ok).catch(() => false);
  res.status(ollama ? 200 : 503).json({ database: true, ollama });
}));
app.use("/api/auth", authRouter);
app.use("/api/references", referencesRouter);
app.use("/api/work-orders", workOrdersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/ai", aiRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/assistant", assistantRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/devices", devicesRouter);
app.use("/api/equipment", equipmentRouter);
app.use("/api/recommendations", recommendationsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/integrations", integrationsRouter);
app.post("/api/uploads", auth, upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, "Файл не передан");
  let takenAt: Date | null = null;
  if (req.file.mimetype.startsWith("image/")) {
    const source = await readFile(req.file.path);
    // Capture time: camera EXIF, else the client's value (a PWA sends File.lastModified of the camera shot).
    const clientTakenAt = typeof req.body?.takenAt === "string" ? new Date(req.body.takenAt) : null;
    takenAt = exifCaptureTime((await sharp(source).metadata()).exif) ?? (clientTakenAt && !Number.isNaN(clientTakenAt.getTime()) ? clientTakenAt : null);
    // Metadata is stripped (GPS, device) except the capture time, which the photo check needs.
    let pipeline = sharp(source).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
    if (takenAt) pipeline = pipeline.withExif({ IFD0: { DateTime: exifWallTime(takenAt) } });
    await writeFile(req.file.path, await pipeline.jpeg({ quality: 80 }).toBuffer());
  }
  res.status(201).json({ url: `/uploads/${req.file.filename}`, originalName: req.file.originalname, size: req.file.size, takenAt });
}));
app.use((_req, _res, next) => next(new HttpError(404, "Маршрут не найден")));
app.use(errorHandler);
