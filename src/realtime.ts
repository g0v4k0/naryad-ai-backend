import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { config } from "./config.js";
import { signUploadUrls } from "./lib/signed-urls.js";

let io: Server | undefined;

// Roles that see every work order; executors only receive updates for their own orders.
const SUPERVISOR_ROOMS = ["role:MASTER", "role:MANAGER", "role:ADMIN"];

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: true, credentials: true } });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token as string;
      const payload = jwt.verify(token, config.JWT_SECRET) as unknown as { sub: string | number; role: Role };
      socket.data.userId = Number(payload.sub);
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", (socket) => socket.join([`user:${socket.data.userId}`, `role:${socket.data.role}`]));
  return io;
}

/** Notifies supervisors, the current assignee and any extra users (e.g. the previous assignee after reassignment). */
export function emitOrderChanged(order: { assigneeId: number }, extraUserIds: number[] = []) {
  if (!io) return;
  const rooms = [...SUPERVISOR_ROOMS, `user:${order.assigneeId}`, ...extraUserIds.map((id) => `user:${id}`)];
  io.to(rooms).emit("work-order:changed", signUploadUrls(order));
}

export function emitNotification(userId: number, notification: unknown) {
  io?.to(`user:${userId}`).emit("notification:new", notification);
}
