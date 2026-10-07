import { unlink } from "node:fs/promises";
import { Role } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { asyncHandler, HttpError } from "../lib/http.js";
import { allow, auth } from "../middleware/auth.js";
import { knowledgeStats, reindexKnowledge } from "../services/rag.js";
import { transcribeAudio } from "../services/whisper.js";

const upload = multer({ dest: "uploads/", limits: { fileSize: 25 * 1024 * 1024 } });
export const aiRouter = Router();
aiRouter.use(auth);

aiRouter.post("/transcribe", upload.single("audio"), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, "Передайте аудиофайл в поле audio");
  try {
    res.json({ text: await transcribeAudio(req.file.path, req.file.mimetype, req.file.originalname) });
  } finally {
    await unlink(req.file.path).catch(() => undefined);
  }
}));

/** RAG memory: size and how often the AI agrees with the masters, month by month. */
aiRouter.get("/knowledge/stats", allow(Role.MASTER, Role.MANAGER, Role.ADMIN), asyncHandler(async (_req, res) => {
  res.json(await knowledgeStats());
}));

/** Rebuilds the memory from closed orders and orders in rework (after changing OLLAMA_EMBED_MODEL). */
aiRouter.post("/knowledge/reindex", allow(Role.ADMIN), asyncHandler(async (_req, res) => {
  res.json(await reindexKnowledge());
}));
