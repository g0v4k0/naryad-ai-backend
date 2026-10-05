import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";

export async function transcribeAudio(path: string, mimetype: string, originalName?: string) {
  const data = await readFile(path);
  const form = new FormData();
  form.append("file", new Blob([data], { type: mimetype }), originalName || basename(path));
  const url = new URL(config.WHISPER_URL);
  if (url.pathname.endsWith("/audio/transcriptions")) {
    form.append("model", config.WHISPER_MODEL);
    form.append("language", "ru");
  } else {
    url.searchParams.set("language", "ru");
  }
  const response = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new HttpError(502, `Whisper вернул ${response.status}`);
  const body = (await response.json()) as { text?: string };
  if (!body.text) throw new HttpError(422, "Речь не распознана");
  return body.text;
}
