import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { checkDeadlines } from "../../src/services/deadlines.js";
import { insertOrder, seedBase, type Base } from "../helpers/db.js";

let base: Base;
beforeEach(async () => { base = await seedBase(); });
const min = 60_000;
const types = async (userId: number) => (await prisma.notification.findMany({ where: { userId }, orderBy: { id: "asc" } })).map((x) => x.type);

describe("контроль сроков", () => {
  it("за 30 минут до срока — напоминание исполнителю, один раз", async () => {
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() + 20 * min) });
    await checkDeadlines();
    await checkDeadlines();
    expect(await types(base.worker1.id)).toEqual(["DEADLINE_REMINDER"]);
    expect(await types(base.master.id)).toEqual([]);
  });

  it("срок далеко — ничего", async () => {
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() + 90 * min) });
    await checkDeadlines();
    expect(await prisma.notification.count()).toBe(0);
  });

  it("просрочка — исполнителю и мастеру, повтор каждые 30 минут (корзины)", async () => {
    const order = await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - 5 * min) });
    await checkDeadlines();
    expect(await types(base.worker1.id)).toEqual(["OVERDUE_0"]);
    expect(await types(base.master.id)).toEqual(["OVERDUE_0"]);
    await prisma.workOrder.update({ where: { id: order.id }, data: { deadline: new Date(Date.now() - 35 * min) } });
    await checkDeadlines();
    expect(await types(base.worker1.id)).toEqual(["OVERDUE_0", "OVERDUE_1"]);
  });

  it("длительная просрочка (≥120 мин) эскалируется начальнику на смене", async () => {
    await insertOrder(base, { status: "IN_PROGRESS", deadline: new Date(Date.now() - 130 * min) });
    await checkDeadlines();
    expect(await types(base.manager.id)).toEqual(["LONG_OVERDUE_4"]);
  });

  it.each([
    ["EMERGENCY", 4, true], ["EMERGENCY", 1, false], ["NORMAL", 11, true], ["NORMAL", 8, false]
  ] as const)("непринятый наряд %s через %i мин → сигнал мастеру: %s", async (priority, waited, expected) => {
    await insertOrder(base, { status: "ISSUED", priority, createdAt: new Date(Date.now() - waited * min), deadline: new Date(Date.now() + 20 * min) });
    await checkDeadlines();
    expect((await types(base.master.id)).includes("NOT_ACCEPTED")).toBe(expected);
  });

  it("закрытые и отменённые наряды не контролируются", async () => {
    await insertOrder(base, { status: "CLOSED", deadline: new Date(Date.now() - 500 * min) });
    await insertOrder(base, { status: "CANCELLED", deadline: new Date(Date.now() - 500 * min) });
    await checkDeadlines();
    expect(await prisma.notification.count()).toBe(0);
  });
});
