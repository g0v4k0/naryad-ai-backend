import { unlink } from "node:fs/promises";
import { Router } from "express";
import multer from "multer";
import { asyncHandler, HttpError } from "../lib/http.js";
import { auth } from "../middleware/auth.js";
import { transcribeAudio } from "../services/whisper.js";

const upload = multer({ dest: "uploads/", limits: { fileSize: 25 * 1024 * 1024 } });
export const aiRouter = Router();
aiRouter.use(auth);

aiRouter.post("/transcribe", upload.single("audio"), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, "Передайте аудиофайл в поле audio");
  try {
    res.json({ text: await transcribeAudio(req.file.path, req.file.mimetype) });
  } finally {
    await unlink(req.file.path).catch(() => undefined);
  }
}));
