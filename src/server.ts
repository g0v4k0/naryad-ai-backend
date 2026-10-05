import "dotenv/config";
import { createServer } from "node:http";
import { app } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { initRealtime } from "./realtime.js";
import { startDeadlineMonitor } from "./services/deadlines.js";
import { startOneCSync } from "./services/one-c.js";

const server = createServer(app);
initRealtime(server);
startDeadlineMonitor();
startOneCSync();
server.listen(config.PORT, () => console.log(`NaryadAI API: http://localhost:${config.PORT}`));

async function shutdown() {
  await prisma.$disconnect();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
