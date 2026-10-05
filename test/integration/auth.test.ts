import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { bearer, seedBase, type Base } from "../helpers/db.js";

let base: Base;
beforeAll(async () => { base = await seedBase(); });

describe("авторизация", () => {
  it("логин по ПИН возвращает JWT и профиль без хеша", async () => {
    const res = await request(app).post("/api/auth/login").send({ login: "master", pin: "1234" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: base.master.id, role: "MASTER" });
    expect(JSON.stringify(res.body)).not.toContain("pinHash");
    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    expect(payload.exp! - payload.iat!).toBe(12 * 3600);
  });

  it.each([
    [{ login: "master", pin: "0000" }, 401],
    [{ login: "nobody", pin: "1234" }, 401],
    [{ login: "master", pin: "12" }, 400],
    [{}, 400]
  ])("неверные данные %j → %i", async (body, status) => {
    expect((await request(app).post("/api/auth/login").send(body)).status).toBe(status);
  });

  it("/me требует токен и не отдаёт pinHash", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("authorization", "Bearer garbage")).status).toBe(401);
    const forged = jwt.sign({ sub: base.admin.id, role: "ADMIN" }, "wrong-secret-wrong-secret");
    expect((await request(app).get("/api/auth/me").set("authorization", `Bearer ${forged}`)).status).toBe(401);
    const res = await request(app).get("/api/auth/me").set(bearer(base.worker1));
    expect(res.status).toBe(200);
    expect(res.body.login).toBe("worker1");
    expect(res.body.pinHash).toBeUndefined();
  });

  it("просроченный токен отклоняется", async () => {
    const expired = jwt.sign({ sub: base.master.id, role: "MASTER", exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!);
    expect((await request(app).get("/api/auth/me").set("authorization", `Bearer ${expired}`)).status).toBe(401);
  });
});

describe("ролевая модель", () => {
  const matrix: Array<[string, string, Array<keyof Base>, Array<keyof Base>]> = [
    ["GET", "/api/analytics/dashboard", ["master", "manager", "admin"], ["worker1"]],
    ["GET", "/api/reports/ratings", ["master", "manager", "admin"], ["worker1"]],
    ["GET", "/api/admin/users", ["admin"], ["master", "manager", "worker1"]],
    ["GET", "/api/integrations/1c/jobs", ["admin", "manager"], ["master", "worker1"]],
    ["GET", "/api/references/areas", ["master", "manager", "admin", "worker1"], []]
  ];
  it.each(matrix)("%s %s", async (method, path, allowed, denied) => {
    for (const role of allowed) {
      const res = await request(app)[method.toLowerCase() as "get"](path).set(bearer(base[role] as any));
      expect(res.status, `${String(role)} должен иметь доступ`).toBe(200);
    }
    for (const role of denied) {
      const res = await request(app)[method.toLowerCase() as "get"](path).set(bearer(base[role] as any));
      expect(res.status, `${String(role)} не должен иметь доступ`).toBe(403);
    }
  });

  it("неизвестный маршрут → 404 JSON", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Маршрут не найден");
  });

  it("health и ready", async () => {
    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ database: true, ollama: true });
  });
});
