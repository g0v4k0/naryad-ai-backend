import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import request from "supertest";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { initRealtime } from "../../src/realtime.js";
import { notify } from "../../src/services/notifications.js";
import { sendPush } from "../../src/services/push.js";
import { bearer, insertOrder, seedBase, tokenFor, type Base } from "../helpers/db.js";
import { scene } from "../helpers/images.js";
import { mocks } from "../helpers/mocks.js";

const next = (socket: Socket, event: string) => new Promise<any[]>((resolve) => socket.once(event, (...args: any[]) => resolve(args)));

let base: Base;
beforeEach(async () => { base = await seedBase(); });

describe("справочники и администрирование", () => {
  it("справочники доступны всем ролям", async () => {
    for (const path of ["areas", "equipment", "fault-codes", "materials", "brigades", "normatives", "executors"]) {
      const res = await request(app).get(`/api/references/${path}`).set(bearer(base.worker1));
      expect(res.status, path).toBe(200);
      expect(res.body.length, path).toBeGreaterThan(0);
    }
    expect((await request(app).get(`/api/references/equipment?areaId=${base.area2.id}`).set(bearer(base.worker1))).body).toHaveLength(1);
    const executors = (await request(app).get("/api/references/executors").set(bearer(base.master))).body;
    expect(executors).toHaveLength(3);
  });

  it("CRUD администратора и хеширование ПИН", async () => {
    const a = bearer(base.admin);
    const area = (await request(app).post("/api/admin/areas").set(a).send({ name: "Новый" })).body;
    expect((await request(app).patch(`/api/admin/areas/${area.id}`).set(a).send({ name: "Новый 2" })).body.name).toBe("Новый 2");
    const eq = (await request(app).post("/api/admin/equipment").set(a).send({ name: "Насос 2", inventoryNumber: "INV-77", type: "Насос", criticality: 2, areaId: area.id })).body;
    expect((await request(app).patch(`/api/admin/equipment/${eq.id}`).set(a).send({ criticality: 5 })).body.criticality).toBe(5);
    expect((await request(app).post("/api/admin/fault-codes").set(a).send({ code: "Г-9", name: "Утечка", category: "Г" })).status).toBe(201);
    expect((await request(app).post("/api/admin/materials").set(a).send({ name: "Масло", unit: "л" })).status).toBe(201);
    expect((await request(app).post("/api/admin/brigades").set(a).send({ name: "Бригада Б" })).status).toBe(201);
    const norm = await request(app).post("/api/admin/normatives").set(a).send({ name: "Ревизия", equipmentType: "Насос", hours: 1.5, materials: [{ materialId: base.grease.id, quantity: 0.5 }] });
    expect(norm.body.materialNorms).toHaveLength(1);
    expect((await request(app).post("/api/admin/users").set(a).send({ phone: "+77020000001", password: "12345", fullName: "Новый сотрудник", role: "EXECUTOR" })).status).toBe(400);
    expect((await request(app).post("/api/admin/users").set(a).send({ phone: "8 701 000 00 01", password: "start123", fullName: "Дубль номера", role: "EXECUTOR" })).status).toBe(409);
    const user = await request(app).post("/api/admin/users").set(a).send({ phone: "8 (702) 000-00-01", password: "start123", fullName: "Новый сотрудник", role: "EXECUTOR", language: "kk" });
    expect(user.status).toBe(201);
    expect(user.body).toMatchObject({ phone: "+77020000001", login: "+77020000001", language: "kk" });
    expect(user.body.passwordHash).toBeUndefined();
    expect((await request(app).post("/api/auth/login").send({ phone: "+77020000001", password: "start123" })).status).toBe(200);
    const edited = await request(app).patch(`/api/admin/users/${user.body.id}`).set(a).send({ phone: "+77020000002", password: "reset456", fullName: "Новый сотрудник 2" });
    expect(edited.body).toMatchObject({ phone: "+77020000002", fullName: "Новый сотрудник 2" });
    expect(edited.body.passwordHash).toBeUndefined();
    expect((await request(app).post("/api/auth/login").send({ phone: "+77020000001", password: "start123" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ phone: "+77020000002", password: "reset456" })).status).toBe(200);
    expect((await request(app).patch(`/api/admin/users/${user.body.id}/shift`).set(a).send({ isOnShift: true, employeeStatus: "AVAILABLE" })).body.isOnShift).toBe(true);
    expect((await request(app).get("/api/admin/users").set(a)).body.every((u: any) => !u.passwordHash)).toBe(true);
    expect((await request(app).delete(`/api/admin/equipment/${eq.id}`).set(a)).status).toBe(204);
    expect((await request(app).delete(`/api/admin/unknown/1`).set(a)).status).toBe(404);
    for (const [resource, id] of [["areas", area.id], ["normatives", norm.body.id]] as const) {
      expect((await request(app).delete(`/api/admin/${resource}/${id}`).set(a)).status).toBe(204);
    }
  });

  it("BUG-7: удаление используемых записей → 409, отсутствующих → 404; правка отсутствующих → 404", async () => {
    const a = bearer(base.admin);
    expect((await request(app).delete(`/api/admin/areas/${base.area.id}`).set(a)).status).toBe(409);
    expect((await request(app).delete("/api/admin/materials/999999").set(a)).status).toBe(404);
    expect((await request(app).patch("/api/admin/equipment/999999").set(a).send({ criticality: 2 })).status).toBe(404);
    expect((await request(app).post("/api/admin/areas").set(a).send({ name: base.area.name })).status).toBe(409);
    expect(await prisma.area.count()).toBe(2);
  });
});

describe("оборудование и QR", () => {
  it("QR PNG кодирует публичную ссылку; поиск по токену; история", async () => {
    await insertOrder(base, { equipmentId: base.pump.id });
    const png = await request(app).get(`/api/equipment/${base.pump.id}/qr.png`).set(bearer(base.worker1)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(png.headers["content-type"]).toBe("image/png");
    expect((await sharp(png.body).metadata()).width).toBe(512);
    const byToken = await request(app).get(`/api/equipment/qr/${base.pump.qrToken}`).set(bearer(base.worker1));
    expect(byToken.body).toMatchObject({ id: base.pump.id, area: { name: "Дробление" } });
    expect((await request(app).get("/api/equipment/qr/nope").set(bearer(base.worker1))).status).toBe(404);
    expect((await request(app).get("/api/equipment/999999/qr.png").set(bearer(base.worker1))).status).toBe(404);
    expect((await request(app).get(`/api/equipment/${base.pump.id}/history`).set(bearer(base.worker1))).body.orders).toHaveLength(1);
  });
});

describe("файлы и голос", () => {
  it("SEC-4: файлы доступны только по подписанной ссылке из API или с токеном", async () => {
    const up = await request(app).post("/api/uploads").set(bearer(base.worker1)).attach("file", await scene(2), "p.jpg");
    const signed: string = up.body.url;
    expect(signed).toMatch(/^\/uploads\/[0-9a-f]{32}\?exp=\d+&sig=[\w-]+$/);
    const plain = signed.split("?")[0];
    expect((await request(app).get(plain)).status).toBe(401);
    expect((await request(app).get(signed)).status).toBe(200);
    expect((await request(app).get(plain).set(bearer(base.worker2))).status).toBe(200);
    // Corrupt the signature with a character it surely did not have in that position.
    expect((await request(app).get(signed.replace(/sig=(.)/, (_, c: string) => `sig=${c === "X" ? "Y" : "X"}`))).status).toBe(401);
    const other = (await request(app).post("/api/uploads").set(bearer(base.worker1)).attach("file", await scene(3), "q.jpg")).body.url.split("?")[0];
    expect((await request(app).get(other + signed.slice(signed.indexOf("?")))).status).toBe(401); // подпись привязана к файлу
    expect((await request(app).get(`${plain}?exp=${Math.floor(Date.now() / 1000) - 10}&sig=abc`)).status).toBe(401);
  });

  it("SEC-4: подписанная ссылка из клиента сохраняется в БД без подписи; внешние URL не трогаются", async () => {
    const signed = (await request(app).post("/api/uploads").set(bearer(base.master)).attach("file", await scene(4), "b.jpg")).body.url;
    const external = "https://cdn.example.com/x.jpg?token=abc";
    const res = await request(app).post("/api/work-orders").set(bearer(base.master)).send({ type: "PLANNED", description: "Фото до", areaId: base.area.id, equipmentId: base.pump.id, assigneeId: base.worker1.id, priority: "NORMAL", normativeId: base.normative.id, beforePhotoUrls: [signed, external] });
    expect(res.status).toBe(201);
    const stored = (await prisma.photo.findMany({ where: { workOrderId: res.body.id }, orderBy: { id: "asc" } })).map((p) => p.fileUrl);
    expect(stored).toEqual([signed.split("?")[0], external]);
    expect(res.body.photos[0].fileUrl).toMatch(/\?exp=\d+&sig=/); // в ответе снова подписана
  });

  it("загрузка фото: сжатие до 1600px JPEG", async () => {
    const big = await scene(1, { width: 4000, height: 3000 });
    const res = await request(app).post("/api/uploads").set(bearer(base.worker1)).attach("file", big, "photo.jpg");
    expect(res.status).toBe(201);
    const stored = await request(app).get(res.body.url).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    const meta = await sharp(stored.body).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(meta.format).toBe("jpeg");
    expect((await request(app).post("/api/uploads").set(bearer(base.worker1))).status).toBe(400);
  });

  it("распознавание голоса через Whisper; временный файл удаляется", async () => {
    const res = await request(app).post("/api/ai/transcribe").set(bearer(base.worker1)).attach("audio", Buffer.from("RIFF...."), { filename: "v.webm", contentType: "audio/webm" });
    expect(res.body).toEqual({ text: "заменить подшипник" });
    expect((await request(app).post("/api/ai/transcribe").set(bearer(base.worker1))).status).toBe(400);
    mocks.whisper.handler = () => ({ json: { text: "" } });
    expect((await request(app).post("/api/ai/transcribe").set(bearer(base.worker1)).attach("audio", Buffer.from("x"), "s.wav")).status).toBe(422);
  });
});

describe("уведомления и устройства", () => {
  it("лента, отметка прочтения только своих", async () => {
    const n = await notify({ userId: base.worker1.id, type: "TEST", title: "Т", message: "М" });
    expect((await request(app).get("/api/notifications").set(bearer(base.worker1))).body).toHaveLength(1);
    expect((await request(app).patch(`/api/notifications/${n.id}/read`).set(bearer(base.worker2))).body.updated).toBe(0);
    expect((await request(app).patch(`/api/notifications/${n.id}/read`).set(bearer(base.worker1))).body.updated).toBe(1);
  });

  it("регистрация push-токена (upsert), удаление; FCM без ключа отключён", async () => {
    const token = "fcm-token-".padEnd(40, "x");
    expect((await request(app).post("/api/devices").set(bearer(base.worker1)).send({ token, platform: "android" })).status).toBe(201);
    await request(app).post("/api/devices").set(bearer(base.worker2)).send({ token, platform: "android" });
    expect(await prisma.pushDevice.findUnique({ where: { token } })).toMatchObject({ userId: base.worker2.id });
    expect((await request(app).post("/api/devices").set(bearer(base.worker1)).send({ token: "short", platform: "android" })).status).toBe(400);
    expect(await sendPush(base.worker2.id, "t", "b")).toEqual({ sent: 0, disabled: true });
    expect((await request(app).delete(`/api/devices/${token}`).set(bearer(base.worker2))).body.deleted).toBe(1);
  });
});

describe("Socket.IO realtime", () => {
  let url: string;
  const server = createServer(app);
  beforeAll(async () => {
    initRealtime(server);
    server.listen(0);
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("без токена — отказ подключения", async () => {
    const socket = connect(url, { auth: {}, transports: ["websocket"], reconnection: false });
    const [err] = await next(socket, "connect_error");
    expect(err.message).toBe("unauthorized");
    socket.close();
  });

  it("SEC-2: наряд видят мастер, руководитель и его исполнитель; чужой исполнитель — нет", async () => {
    const sockets = Object.fromEntries((["worker1", "worker2", "master", "manager"] as const).map((k) => [k, connect(url, { auth: { token: tokenFor(base[k]) }, transports: ["websocket"] })]));
    await Promise.all(Object.values(sockets).map((s) => next(s, "connect")));
    const got: Record<string, string[]> = { worker1: [], worker2: [], master: [], manager: [] };
    for (const [k, s] of Object.entries(sockets)) {
      s.on("work-order:changed", () => got[k].push("order"));
      s.on("notification:new", () => got[k].push("notification"));
    }
    const res = await request(app).post("/api/work-orders").set(bearer(base.master)).send({ type: "PLANNED", description: "Проверка realtime", areaId: base.area.id, equipmentId: base.pump.id, assigneeId: base.worker1.id, priority: "NORMAL", normativeId: base.normative.id });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(got.worker1.sort()).toEqual(["notification", "order"]);
    expect(got.master).toEqual(["order"]);
    expect(got.manager).toEqual(["order"]);
    expect(got.worker2).toEqual([]);
    // после переназначения прежний исполнитель получает обновление (наряд пропадает из его очереди), новый — тоже
    for (const k of Object.keys(got)) got[k] = [];
    await request(app).post(`/api/work-orders/${res.body.id}/reassign`).set(bearer(base.master)).send({ assigneeId: base.worker2.id });
    await new Promise((r) => setTimeout(r, 300));
    expect(got.worker1.sort()).toEqual(["notification", "order"]); // прежний исполнитель узнаёт, что наряд передан
    expect(got.worker2.sort()).toEqual(["notification", "order"]);
    Object.values(sockets).forEach((s) => s.close());
  });
});
