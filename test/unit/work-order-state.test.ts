import { describe, expect, it } from "vitest";
import { WorkOrderStatus } from "@prisma/client";
import { nextStatus, type WorkOrderAction } from "../../src/domain/work-order-state.js";

const S = WorkOrderStatus;
// Expected transition table: action -> (allowed source statuses, target).
const table: Record<WorkOrderAction, [WorkOrderStatus[], WorkOrderStatus]> = {
  ACCEPT: [[S.ISSUED, S.QUEUED], S.ACCEPTED],
  QUEUE: [[S.ISSUED], S.QUEUED],
  REJECT: [[S.ISSUED], S.REJECTED],
  START: [[S.ACCEPTED, S.QUEUED, S.REWORK], S.IN_PROGRESS],
  PAUSE: [[S.IN_PROGRESS], S.PAUSED],
  RESUME: [[S.PAUSED], S.IN_PROGRESS],
  COMPLETE: [[S.IN_PROGRESS], S.COMPLETED],
  SEND_TO_REWORK: [[S.AI_REVIEW], S.REWORK],
  CLOSE: [[S.AI_REVIEW], S.CLOSED],
  CANCEL: [[S.ISSUED, S.ACCEPTED, S.QUEUED, S.IN_PROGRESS, S.PAUSED, S.REWORK], S.CANCELLED]
};
const statuses = Object.values(S);
const cases = (Object.keys(table) as WorkOrderAction[]).flatMap((action) => statuses.map((status) => ({ action, status, allowed: table[action][0].includes(status), target: table[action][1] })));

describe("машина состояний наряда", () => {
  it("матрица покрывает 10 действий × 11 статусов", () => {
    expect(cases).toHaveLength(110);
    expect(cases.filter((x) => x.allowed)).toHaveLength(18);
  });

  it.each(cases.filter((x) => x.allowed))("$action из $status → $target", ({ action, status, target }) => {
    expect(nextStatus(status, action)).toBe(target);
  });

  it.each(cases.filter((x) => !x.allowed))("$action из $status запрещён", ({ action, status }) => {
    expect(() => nextStatus(status, action)).toThrow(`Переход ${action} недоступен из статуса ${status}`);
  });

  it("терминальные статусы CLOSED, CANCELLED, REJECTED не имеют выходов", () => {
    for (const status of [S.CLOSED, S.CANCELLED, S.REJECTED]) {
      expect(cases.filter((x) => x.status === status && x.allowed)).toHaveLength(0);
    }
  });

  it("основной путь: выдан → принят → в работе → выполнен → AI → закрыт", () => {
    let status: WorkOrderStatus = S.ISSUED;
    for (const action of ["ACCEPT", "START", "PAUSE", "RESUME", "COMPLETE"] as WorkOrderAction[]) status = nextStatus(status, action);
    expect(status).toBe(S.COMPLETED);
    expect(nextStatus(S.AI_REVIEW, "CLOSE")).toBe(S.CLOSED);
  });

  it("цикл доработки: AI_REVIEW → REWORK → IN_PROGRESS", () => {
    expect(nextStatus(nextStatus(S.AI_REVIEW, "SEND_TO_REWORK"), "START")).toBe(S.IN_PROGRESS);
  });
});
