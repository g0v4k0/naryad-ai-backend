import { EmployeeStatus, type Prisma, type WorkOrderStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function refreshEmployeeStatus(userId: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { isOnShift: true } });
  if (!user.isOnShift) return prisma.user.update({ where: { id: userId }, data: { employeeStatus: EmployeeStatus.OFF_SHIFT } });
  const [working, queued] = await Promise.all([
    prisma.workOrder.count({ where: { assigneeId: userId, status: { in: ["ACCEPTED", "IN_PROGRESS", "PAUSED", "REWORK"] } } }),
    prisma.workOrder.count({ where: { assigneeId: userId, status: { in: ["ISSUED", "QUEUED"] } } })
  ]);
  const employeeStatus = working > 0 && queued > 0 ? EmployeeStatus.QUEUED : working > 0 ? EmployeeStatus.BUSY : queued > 0 ? EmployeeStatus.QUEUED : EmployeeStatus.AVAILABLE;
  return prisma.user.update({ where: { id: userId }, data: { employeeStatus } });
}

const WORKING: WorkOrderStatus[] = ["IN_PROGRESS", "PAUSED", "REWORK", "ACCEPTED"];
const WAITING: WorkOrderStatus[] = ["ISSUED", "QUEUED"];

/** Prisma select for an executor's open orders, as describeWorkload expects them. */
export const openOrdersSelect = {
  where: { status: { in: [...WORKING, ...WAITING] } },
  select: { id: true, number: true, status: true, priority: true, deadline: true, equipment: { select: { name: true } } },
  orderBy: [{ priority: "asc" }, { deadline: "asc" }]
} satisfies Prisma.User$assignedOrdersArgs;

type OpenOrder = { id: number; number: string; status: WorkOrderStatus };

/** What the master sees when assigning: "свободен / выполняет наряд №… / в очереди N / не на смене". */
export function describeWorkload<T extends OpenOrder>(isOnShift: boolean, openOrders: T[]) {
  const working = openOrders.filter((x) => WORKING.includes(x.status));
  const current = working.find((x) => x.status === "IN_PROGRESS") ?? working[0] ?? null;
  const queue = openOrders.filter((x) => WAITING.includes(x.status)).length;
  const statusText = !isOnShift ? "не на смене"
    : current ? `выполняет наряд №${current.number}${queue ? `, в очереди ${queue}` : ""}`
      : queue ? `в очереди ${queue} ${queue === 1 ? "наряд" : queue < 5 ? "наряда" : "нарядов"}` : "свободен";
  return { currentOrder: current, queue, activeOrders: openOrders.length, statusText };
}
