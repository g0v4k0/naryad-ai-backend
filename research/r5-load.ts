// Load test of the deployed API (http://127.0.0.1:8765, production data, read-only endpoints).
import { resultsDir } from "./env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import autocannon from "autocannon";

const BASE = process.env.LOAD_BASE ?? "http://127.0.0.1:8765";
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: process.env.LOAD_PHONE ?? "+77000000001", password: process.env.LOAD_PASSWORD ?? "123456" }) }).then((r) => r.json());
const auth = { authorization: `Bearer ${login.token}` };
const targets: Array<{ name: string; path: string; method?: "GET" | "POST"; body?: string; headers?: Record<string, string> }> = [
  { name: "GET /health", path: "/health" },
  { name: "GET /references/equipment", path: "/api/references/equipment", headers: auth },
  { name: "GET /work-orders (200 строк)", path: "/api/work-orders", headers: auth },
  { name: "GET /work-orders?compact=1&limit=50", path: "/api/work-orders?compact=1&limit=50", headers: auth },
  { name: "GET /analytics/dashboard", path: "/api/analytics/dashboard", headers: auth },
  { name: "GET /reports/ratings", path: "/api/reports/ratings", headers: auth },
  { name: "GET /analytics/failure-forecast", path: "/api/analytics/failure-forecast", headers: auth },
  { name: "POST /auth/login", path: "/api/auth/login", method: "POST", body: JSON.stringify({ phone: process.env.LOAD_PHONE ?? "+77000000001", password: process.env.LOAD_PASSWORD ?? "123456" }), headers: { "content-type": "application/json" } }
];
const CONNECTIONS = [1, 10, 50];
const out = [];
for (const t of targets) {
  for (const connections of CONNECTIONS) {
    const r = await autocannon({ url: BASE + t.path, method: t.method ?? "GET", body: t.body, headers: t.headers, connections, duration: 8 });
    const row = { name: t.name, connections, rps: r.requests.average, p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, errors: r.errors + r.non2xx, total: r.requests.total };
    out.push(row);
    console.log(JSON.stringify(row));
  }
}
writeFileSync(join(resultsDir, `r5-load${process.env.OUT_SUFFIX ?? ""}.json`), JSON.stringify(out, null, 2));
