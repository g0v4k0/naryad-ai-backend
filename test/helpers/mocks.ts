import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Handler = (body: any, req: IncomingMessage) => { status?: number; json?: unknown; text?: string } | Promise<{ status?: number; json?: unknown; text?: string }>;

export type MockService = {
  url: string;
  calls: Array<{ path: string; body: any; headers: IncomingMessage["headers"]; raw: Buffer }>;
  handler: Handler;
  reset(): void;
  close(): Promise<void>;
};

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startMock(defaultHandler: Handler): Promise<MockService> {
  const service = {} as MockService;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    let body: any = raw.toString("utf8");
    try { body = JSON.parse(body); } catch { /* multipart or text */ }
    service.calls.push({ path: req.url ?? "", body, headers: req.headers, raw });
    const result = await service.handler(body, req);
    res.statusCode = result.status ?? 200;
    if (result.json !== undefined) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result.json));
    } else res.end(result.text ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  service.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  service.calls = [];
  service.handler = defaultHandler;
  service.reset = () => { service.calls = []; service.handler = defaultHandler; };
  service.close = () => new Promise((resolve) => server.close(() => resolve()));
  return service;
}

/** Ollama /api/chat reply carrying `content` as JSON string, like format:"json" responses. */
export const ollamaReply = (content: unknown) => ({ json: { message: { role: "assistant", content: JSON.stringify(content) } } });

export const mocks = {} as { ollama: MockService; whisper: MockService; oneC: MockService };
