import { resultsDir } from "./env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buildAnomalies, predictFailures } from "../src/services/analytics.js";
import { tokenFor } from "../test/helpers/db.js";

const manager = await prisma.user.findUniqueOrThrow({ where: { login: "manager" } });
const h = { authorization: `Bearer ${tokenFor(manager)}` };
const seeded = { createdAt: { lt: new Date(Date.now() - 3_600_000) }, number: { startsWith: "H-" } };

const orders = await prisma.workOrder.findMany({ where: seeded, include: { equipment: true, aiAssessment: true } });
const perEquipment = Object.entries(orders.reduce<Record<string, number>>((m, o) => ({ ...m, [o.equipment.name]: (m[o.equipment.name] ?? 0) + 1 }), {}))
  .map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
const byDay = Array.from({ length: 90 }, (_, d) => ({ daysAgo: d, n: orders.filter((o) => Math.floor((Date.now() - o.createdAt.getTime()) / 86_400_000) === d).length }));
const onTime = orders.filter((o) => o.closedAt! <= o.deadline).length / orders.length;
const verdicts = orders.reduce<Record<string, number>>((m, o) => ({ ...m, [o.aiAssessment!.verdict]: (m[o.aiAssessment!.verdict] ?? 0) + 1 }), {});

const t1 = performance.now();
const anomalies = await buildAnomalies();
const anomalyMs = Math.round(performance.now() - t1);
const forecast = await predictFailures(30);
const ratings = (await request(app).get("/api/reports/ratings?from=2000-01-01").set(h)).body;
const brigades = (await request(app).get("/api/reports/brigade-ratings?from=2000-01-01").set(h)).body;
const dashboard = (await request(app).get("/api/analytics/dashboard").set(h)).body;

const planted = "Конвейер К-3";
const result = {
  totalOrders: orders.length, onTimeRate: onTime, verdicts, perEquipment, byDay,
  anomalies: anomalies.map((a) => ({ type: a.type, title: a.title, severity: a.severity, evidence: a.evidence })), anomalyMs,
  plantedDetected: anomalies.filter((a) => a.title.startsWith(planted)).map((a) => a.type),
  falsePositives: anomalies.filter((a) => !a.title.startsWith(planted)).length,
  forecast, ratings: ratings.map((r: any) => ({ fullName: r.fullName, score: r.score, quality: r.quality, onTimeRate: r.onTimeRate, closed: r.closed })),
  brigades, dashboard
};
console.log(JSON.stringify({ totalOrders: result.totalOrders, onTime, verdicts, top: perEquipment.slice(0, 3), anomalies: result.anomalies.map((a) => a.title + " / " + a.type), anomalyMs, forecastTop: forecast.slice(0, 3), ratingsTop: result.ratings.slice(0, 3), ratingsBottom: result.ratings.slice(-2) }, null, 1));
writeFileSync(join(resultsDir, "r6-analytics.json"), JSON.stringify(result, null, 2));
await prisma.$disconnect();
