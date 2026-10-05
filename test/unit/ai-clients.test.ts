import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { askOllama } from "../../src/services/ollama.js";
import { transcribeAudio } from "../../src/services/whisper.js";
import { HttpError } from "../../src/lib/http.js";
import { mocks, ollamaReply } from "../helpers/mocks.js";

describe("Ollama-клиент", () => {
  it("шлёт модель, system/user и format=json, парсит JSON из content", async () => {
    mocks.ollama.handler = () => ollamaReply({ answer: 42 });
    await expect(askOllama("sys", "hello")).resolves.toEqual({ answer: 42 });
    const call = mocks.ollama.calls[0];
    expect(call.path).toBe("/api/chat");
    expect(call.body).toMatchObject({ model: "test-model", stream: false, format: "json", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }] });
  });

  it("HTTP-ошибка Ollama → исключение", async () => {
    mocks.ollama.handler = () => ({ status: 500, text: "boom" });
    await expect(askOllama("s", "p")).rejects.toThrow("Ollama вернула 500");
  });

  it("пустой ответ → исключение", async () => {
    mocks.ollama.handler = () => ({ json: { message: { content: "" } } });
    await expect(askOllama("s", "p")).rejects.toThrow("Пустой ответ Ollama");
  });

  it("невалидный JSON → исключение", async () => {
    mocks.ollama.handler = () => ({ json: { message: { content: "не json" } } });
    await expect(askOllama("s", "p")).rejects.toThrow();
  });
});

describe("Whisper-клиент", () => {
  it("локальный сервис /transcribe: поле file, language=ru в query, оригинальное имя файла", async () => {
    await writeFile("voice.bin", Buffer.from("RIFFfake"));
    await expect(transcribeAudio("voice.bin", "audio/wav", "запись.wav")).resolves.toBe("заменить подшипник");
    const call = mocks.whisper.calls[0];
    const url = new URL(call.path, "http://x");
    expect(url.pathname).toBe("/transcribe");
    expect(url.searchParams.get("language")).toBe("ru");
    expect(url.searchParams.get("prompt")).toContain("футеровка");
    const raw = call.raw.toString("utf8");
    expect(raw).toContain('name="file"');
    expect(raw).toContain("запись.wav");
    expect(raw).not.toContain('name="model"');
  });

  it("пустой текст → HttpError 422", async () => {
    await writeFile("voice.bin", Buffer.from("x"));
    mocks.whisper.handler = () => ({ json: { text: "" } });
    const error = await transcribeAudio("voice.bin", "audio/wav").catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
  });

  it("ошибка сервиса → HttpError 502", async () => {
    await writeFile("voice.bin", Buffer.from("x"));
    mocks.whisper.handler = () => ({ status: 503, text: "down" });
    const error = await transcribeAudio("voice.bin", "audio/wav").catch((e) => e);
    expect(error.status).toBe(502);
  });
});
