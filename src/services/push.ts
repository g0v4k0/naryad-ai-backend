import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";

function messaging() {
  if (!config.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  if (!getApps().length) {
    const account = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(account) });
  }
  return getMessaging();
}

export async function sendPush(userId: number, title: string, body: string, data: Record<string, string> = {}) {
  const client = messaging();
  if (!client) return { sent: 0, disabled: true };
  const devices = await prisma.pushDevice.findMany({ where: { userId }, select: { token: true } });
  if (!devices.length) return { sent: 0, disabled: false };
  const emergency = data.type === "NEW_ORDER" && data.priority === "EMERGENCY";
  const result = await client.sendEachForMulticast({
    tokens: devices.map((x) => x.token),
    notification: { title, body },
    data,
    android: { priority: "high", notification: { sound: "default", channelId: emergency ? "emergency_orders" : "orders" } },
    apns: { payload: { aps: { sound: "default", category: emergency ? "EMERGENCY_ORDER" : "ORDER" } } }
  });
  return { sent: result.successCount, failed: result.failureCount, disabled: false };
}
