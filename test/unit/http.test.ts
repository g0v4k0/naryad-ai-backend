import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { asyncHandler, errorHandler, HttpError } from "../../src/lib/http.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

describe("lib/http", () => {
  it("HttpError отдаёт свой статус и сообщение", () => {
    const res = fakeRes();
    errorHandler(new HttpError(409, "Конфликт"), {} as any, res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "Конфликт" });
  });

  it("ZodError превращается в 400", () => {
    const res = fakeRes();
    const result = z.object({ a: z.string() }).safeParse({});
    errorHandler(result.error, {} as any, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Ошибка в данных запроса");
  });

  it("неизвестная ошибка → 500 без утечки деталей", () => {
    const res = fakeRes();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    errorHandler(new Error("secret db password"), {} as any, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
    spy.mockRestore();
  });

  it("asyncHandler передаёт отклонённый промис в next", async () => {
    const next = vi.fn();
    asyncHandler(async () => { throw new HttpError(418, "x"); })({} as any, {} as any, next);
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
  });
});
