import cron from "node-cron";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { notify } from "./notifications.js";
import { buildAnomalies, summarizeInsights } from "./analytics.js";

const active = ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED"] as const;

async function notifyOnce(userId: number, workOrderId: number, type: string, title: string, message: string) {
  const exists = await prisma.notification.findFirst({ where: { userId, workOrderId, type } });
  if (!exists) await notify({ userId, workOrderId, type, title, message });
}

function bucketType(prefix: string, minutes: number) {
  return `${prefix}_${Math.floor(minutes / config.OVERDUE_REPEAT_MINUTES)}`;
}

export async function checkDeadlines() {
  const now = new Date();
  const reminderAt = new Date(now.getTime() + config.DEADLINE_REMINDER_MINUTES * 60_000);
  const orders = await prisma.workOrder.findMany({
    where: { status: { in: [...active] }, deadline: { lte: reminderAt } },
    include: { equipment: true }
  });
  for (const order of orders) {
    const overdue = order.deadline <= now;
    const overdueMinutes = Math.max(0, Math.floor((now.getTime() - order.deadline.getTime()) / 60_000));
    const type = overdue ? bucketType("OVERDUE", overdueMinutes) : "DEADLINE_REMINDER";
    const title = overdue ? `Наряд ${order.number} просрочен` : `Срок наряда ${order.number} скоро истечёт`;
    const message = `${order.equipment.name}. Срок: ${order.deadline.toLocaleString("ru-RU")}`;
    await notifyOnce(order.assigneeId, order.id, type, title, message);
    if (overdue) await notifyOnce(order.creatorId, order.id, type, title, message);
    if (overdueMinutes >= config.LONG_OVERDUE_MINUTES) {
      const managers = await prisma.user.findMany({ where: { role: "MANAGER", isOnShift: true }, select: { id: true } });
      for (const manager of managers) await notifyOnce(manager.id, order.id, bucketType("LONG_OVERDUE", overdueMinutes), title, message);
    }
    if (order.status === "ISSUED") {
      const waitingMinutes = Math.floor((now.getTime() - order.createdAt.getTime()) / 60_000);
      const limit = order.priority === "EMERGENCY" ? 3 : 10;
      if (waitingMinutes >= limit) await notifyOnce(order.creatorId, order.id, "NOT_ACCEPTED", `Наряд ${order.number} не принят`, "Назначьте другого свободного исполнителя");
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
