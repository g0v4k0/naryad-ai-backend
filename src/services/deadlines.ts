import cron from "node-cron";
import type { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { shortName, STATUS_LABELS } from "../lib/labels.js";
import { prisma } from "../lib/prisma.js";
import { formatDuration, formatLocal, formatLocalTime } from "../lib/time.js";
import { recommendExecutors } from "./recommendations.js";
import { notify } from "./notifications.js";
import { buildAnomalies, summarizeInsights } from "./analytics.js";

const active = ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] as const;

async function notifyOnce(userId: number, workOrderId: number, type: string, title: string, message: string, data?: Record<string, string>) {
  const exists = await prisma.notification.findFirst({ where: { userId, workOrderId, type } });
  if (!exists) await notify({ userId, workOrderId, type, title, message, data });
}

function bucketType(prefix: string, minutes: number) {
  return `${prefix}_${Math.floor(minutes / config.OVERDUE_REPEAT_MINUTES)}`;
}

const deadlineInclude = {
  equipment: true,
  area: true,
  assignee: { select: { fullName: true } },
  events: { where: { comment: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { comment: true } }
} as const;
type DeadlineOrder = Prisma.WorkOrderGetPayload<{ include: typeof deadlineInclude }>;

/** "Статус: в работе с 09:20" — since when the order is in its current state. */
function statusText(order: DeadlineOrder) {
  const since = order.status === "IN_PROGRESS" ? order.startedAt : order.status === "ACCEPTED" ? order.acceptedAt : order.status === "ISSUED" ? order.createdAt : null;
  return since ? `${STATUS_LABELS[order.status]} с ${formatLocalTime(since)}` : STATUS_LABELS[order.status];
}

/** Everything the case asks for: number, equipment, area, executor, status, how late, last comment. */
export function deadlineMessage(order: DeadlineOrder, overdueMinutes: number | null) {
  const lastComment = order.events[0]?.comment ?? order.pauseReason ?? order.comment;
  return [
    overdueMinutes === null
      ? `Наряд №${order.number}: срок истекает ${formatLocal(order.deadline)}.`
      : `Наряд №${order.number} просрочен на ${formatDuration(overdueMinutes)}.`,
    `${order.equipment.name}, участок ${order.area.name.toLowerCase()}.`,
    `Исполнитель: ${shortName(order.assignee.fullName)}. Статус: ${statusText(order)}.`,
    lastComment ? `Последний комментарий: “${lastComment}”.` : null
  ].filter(Boolean).join(" ");
}

async function suggestReplacement(order: DeadlineOrder) {
  const [best] = await recommendExecutors(order.equipmentId, { description: order.description, excludeIds: [order.assigneeId] });
  return best && best.employeeStatus !== "BUSY" ? best : null;
}

export async function checkDeadlines() {
  const now = new Date();
  const reminderAt = new Date(now.getTime() + config.DEADLINE_REMINDER_MINUTES * 60_000);
  const orders = await prisma.workOrder.findMany({
    // Issued orders are watched regardless of the deadline: nobody may have accepted them yet.
    where: { status: { in: [...active] }, OR: [{ deadline: { lte: reminderAt } }, { status: "ISSUED" }] },
    include: deadlineInclude
  });
  for (const order of orders) {
    if (order.deadline <= reminderAt) {
      const overdue = order.deadline <= now;
      const overdueMinutes = Math.max(0, Math.floor((now.getTime() - order.deadline.getTime()) / 60_000));
      const type = overdue ? bucketType("OVERDUE", overdueMinutes) : "DEADLINE_REMINDER";
      const title = overdue ? `Наряд №${order.number} просрочен` : `Срок наряда №${order.number} скоро истечёт`;
      const message = deadlineMessage(order, overdue ? overdueMinutes : null);
      await notifyOnce(order.assigneeId, order.id, type, title, message);
      if (overdue) await notifyOnce(order.creatorId, order.id, type, title, message);
      if (overdueMinutes >= config.LONG_OVERDUE_MINUTES) {
        const managers = await prisma.user.findMany({ where: { role: "MANAGER", isOnShift: true }, select: { id: true } });
        for (const manager of managers) await notifyOnce(manager.id, order.id, bucketType("LONG_OVERDUE", overdueMinutes), title, message);
      }
    }
    if (order.status === "ISSUED") {
      const waitingMinutes = Math.floor((now.getTime() - order.createdAt.getTime()) / 60_000);
      const limit = order.priority === "EMERGENCY" ? 3 : 10;
      if (waitingMinutes < limit) continue;
      if (await prisma.notification.findFirst({ where: { userId: order.creatorId, workOrderId: order.id, type: "NOT_ACCEPTED" } })) continue;
      const candidate = await suggestReplacement(order);
      const message = `${order.equipment.name}, участок ${order.area.name.toLowerCase()}. ${shortName(order.assignee.fullName)} не ответил за ${waitingMinutes} мин. `
        + (candidate ? `Предлагаем переназначить: ${candidate.fullName}${candidate.specialty ? ` (${candidate.specialty.toLowerCase()})` : ""}, ${candidate.employeeStatus === "AVAILABLE" ? "свободен" : `в очереди ${candidate.queue}`}.` : "Свободных исполнителей на смене нет.");
      await notifyOnce(order.creatorId, order.id, "NOT_ACCEPTED", `Наряд №${order.number} не принят`, message, candidate ? { suggestedExecutorId: String(candidate.id) } : undefined);
    }
  }
}

export function startDeadlineMonitor() {
  cron.schedule("* * * * *", () => checkDeadlines().catch(console.error));
  cron.schedule("0 8 * * 1", async () => {
    try {
      const insights = await buildAnomalies(new Date(Date.now() - 7 * 86_400_000), new Date());
      const summary = await summarizeInsights(insights);
      const recipients = await prisma.user.findMany({ where: { role: { in: ["MASTER", "MANAGER"] }, isOnShift: true }, select: { id: true } });
      for (const recipient of recipients) await notify({ userId: recipient.id, type: "WEEKLY_AI_SUMMARY", title: "Еженедельная сводка НарядAI", message: summary.summary });
    } catch (error) { console.error("Weekly summary:", error); }
  });
}
