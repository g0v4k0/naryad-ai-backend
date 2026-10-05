import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

let io: Server | undefined;

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: true, credentials: true } });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token as string;
      const payload = jwt.verify(token, config.JWT_SECRET) as unknown as { sub: string | number };
      socket.data.userId = Number(payload.sub);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", (socket) => socket.join(`user:${socket.data.userId}`));
  return io;
}

export function emitOrderChanged(order: unknown) {
  io?.emit("work-order:changed", order);
}

export function emitNotification(userId: number, notification: unknown) {
  io?.to(`user:${userId}`).emit("notification:new", notification);
}
