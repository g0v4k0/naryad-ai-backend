import { prisma } from "../lib/prisma.js";
import { emitNotification } from "../realtime.js";
import { sendPush } from "./push.js";

export async function notify(input: {
  userId: number;
  workOrderId?: number;
  type: string;
  title: string;
  message: string;
  data?: Record<string, string>;
}) {
  const { data, ...record } = input;
  const notification = await prisma.notification.create({ data: record });
  emitNotification(input.userId, notification);
  await sendPush(input.userId, input.title, input.message, {
    type: input.type,
    ...(input.workOrderId ? { workOrderId: String(input.workOrderId) } : {}),
    ...data
  }).catch((error) => console.error("FCM:", error));
  return notification;
}
