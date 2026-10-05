import { EmployeeStatus } from "@prisma/client";
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
