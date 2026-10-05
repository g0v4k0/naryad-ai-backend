import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "../config.js";

export async function transcribeAudio(path: string, mimetype: string) {
  const data = await readFile(path);
  const form = new FormData();
  form.append("file", new Blob([data], { type: mimetype }), basename(path));
  form.append("model", config.WHISPER_MODEL);
  form.append("language", "ru");
  const response = await fetch(config.WHISPER_URL, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Whisper вернул ${response.status}`);
  const body = (await response.json()) as { text?: string };
  if (!body.text) throw new Error("Whisper не вернул текст");
  return body.text;
}
