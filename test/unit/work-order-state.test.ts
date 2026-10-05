import { describe, expect, it } from "vitest";
import { WorkOrderStatus } from "@prisma/client";
import { nextStatus } from "../src/domain/work-order-state.js";

describe("work order state machine", () => {
  it("проходит основной путь наряда", () => {
    expect(nextStatus(WorkOrderStatus.ISSUED, "ACCEPT")).toBe(WorkOrderStatus.ACCEPTED);
    expect(nextStatus(WorkOrderStatus.ACCEPTED, "START")).toBe(WorkOrderStatus.IN_PROGRESS);
    expect(nextStatus(WorkOrderStatus.IN_PROGRESS, "COMPLETE")).toBe(WorkOrderStatus.COMPLETED);
    expect(nextStatus(WorkOrderStatus.AI_REVIEW, "CLOSE")).toBe(WorkOrderStatus.CLOSED);
  });

  it("запрещает неверный переход", () => {
    expect(() => nextStatus(WorkOrderStatus.CLOSED, "START")).toThrow("недоступен");
  });
});
