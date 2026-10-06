import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { bearer, seedBase, TEST_PASSWORD, type Base } from "../helpers/db.js";

let base: Base;
beforeAll(async () => { base = await seedBase(); });

const MASTER = "+77010000001";
const MANAGER = "+77010000002";
const WORKER1 = "+77010000004";

describe("авторизация", () => {
  it("вход по телефону и паролю возвращает JWT и профиль без хеша", async () => {
    const res = await request(app).post("/api/auth/login").send({ phone: MASTER, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: base.master.id, role: "MASTER", phone: MASTER });
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    expect(payload.exp! - payload.iat!).toBe(12 * 3600);
  });

  it.each(["8 701 000 00 01", "+7 (701) 000-00-01", "7010000001", "87010000001"])("телефон в формате %s приводится к +7…", async (phone) => {
    expect((await request(app).post("/api/auth/login").send({ phone, password: TEST_PASSWORD })).status).toBe(200);
  });

  it.each([
    [{ phone: MASTER, password: "wrong-pass" }, 401],
    [{ phone: "+77019999999", password: TEST_PASSWORD }, 401],
    [{ phone: "12345", password: TEST_PASSWORD }, 400],
    [{ phone: MASTER, password: "" }, 400],
    [{ login: "master", pin: "1234" }, 400],
    [{}, 400]
  ])("неверные данные %j → %i", async (body, status) => {
    expect((await request(app).post("/api/auth/login").send(body)).status).toBe(status);
  });

  it("/me требует токен и не отдаёт хеш пароля", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("authorization", "Bearer garbage")).status).toBe(401);
    const forged = jwt.sign({ sub: base.admin.id, role: "ADMIN" }, "wrong-secret-wrong-secret");
    expect((await request(app).get("/api/auth/me").set("authorization", `Bearer ${forged}`)).status).toBe(401);
    const res = await request(app).get("/api/auth/me").set(bearer(base.worker1));
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(WORKER1);
    expect(res.body.passwordHash).toBeUndefined();
  });

  it("просроченный токен отклоняется", async () => {
    const expired = jwt.sign({ sub: base.master.id, role: "MASTER", exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!);
    expect((await request(app).get("/api/auth/me").set("authorization", `Bearer ${expired}`)).status).toBe(401);
  });

  it("смена пароля: нужен текущий, новый от 6 символов, старый перестаёт работать", async () => {
    const change = (body: object) => request(app).post("/api/auth/change-password").set(bearer(base.manager)).send(body);
    expect((await request(app).post("/api/auth/change-password").send({ currentPassword: TEST_PASSWORD, newPassword: "newpass1" })).status).toBe(401);
    expect((await change({ currentPassword: "wrong-pass", newPassword: "newpass1" })).status).toBe(400);
    expect((await change({ currentPassword: TEST_PASSWORD, newPassword: "12345" })).status).toBe(400);
    expect((await change({ currentPassword: TEST_PASSWORD, newPassword: "newpass1" })).status).toBe(204);
    expect((await request(app).post("/api/auth/login").send({ phone: MANAGER, password: TEST_PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ phone: MANAGER, password: "newpass1" })).status).toBe(200);
  });
});

describe("защита от перебора пароля", () => {
  const login = (body: object, ip = "10.0.0.1") => request(app).post("/api/auth/login").set("x-forwarded-for", ip).send(body);

  it("5 неверных паролей → номер блокируется (429 + Retry-After), даже с верным паролем", async () => {
    for (let i = 0; i < 5; i++) expect((await login({ phone: MASTER, password: "wrong-pass" })).status).toBe(401);
    const locked = await login({ phone: MASTER, password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
    // тот же номер в другой записи тоже заблокирован, другой номер — нет
    expect((await login({ phone: "8 701 000 00 01", password: TEST_PASSWORD }, "10.0.0.3")).status).toBe(429);
    expect((await login({ phone: WORKER1, password: TEST_PASSWORD }, "10.0.0.2")).status).toBe(200);
  });

  it("успешный вход сбрасывает счётчик номера", async () => {
    for (let i = 0; i < 4; i++) await login({ phone: MASTER, password: "wrong-pass" });
    expect((await login({ phone: MASTER, password: TEST_PASSWORD })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login({ phone: MASTER, password: "wrong-pass" })).status).toBe(401);
  });

  it("перебор по разным номерам с одного IP блокируется после 30 неудач", async () => {
    for (let i = 0; i < 30; i++) await login({ phone: `+7709000${String(i).padStart(4, "0")}`, password: "wrong-pass" }, "10.9.9.9");
    expect((await login({ phone: MASTER, password: TEST_PASSWORD }, "10.9.9.9")).status).toBe(429);
    expect((await login({ phone: MASTER, password: TEST_PASSWORD }, "10.9.9.8")).status).toBe(200);
  });

  it("старый bcrypt-хеш принимается и заменяется на scrypt", async () => {
    const hash = async () => (await prisma.user.findUniqueOrThrow({ where: { id: base.worker2.id } })).passwordHash;
    expect(await hash()).toMatch(/^\$2[aby]\$/);
    expect((await login({ phone: "+77010000005", password: TEST_PASSWORD })).status).toBe(200);
    expect(await hash()).toMatch(/^scrypt\$/);
    expect((await login({ phone: "+77010000005", password: TEST_PASSWORD })).status).toBe(200);
    expect((await login({ phone: "+77010000005", password: "wrong-pass" })).status).toBe(401);
  });

  it("пользователь без телефона войти не может", async () => {
    await prisma.user.update({ where: { id: base.worker3.id }, data: { phone: null } });
    expect((await login({ phone: "+77010000006", password: TEST_PASSWORD })).status).toBe(401);
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
