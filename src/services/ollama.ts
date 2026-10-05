import { config } from "../config.js";

export async function askOllama<T>(system: string, prompt: string): Promise<T> {
  const response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.OLLAMA_MODEL,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Ollama вернула ${response.status}`);
  const body = (await response.json()) as { message?: { content?: string } };
  if (!body.message?.content) throw new Error("Пустой ответ Ollama");
  return JSON.parse(body.message.content) as T;
}
