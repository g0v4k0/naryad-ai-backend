import { resultsDir } from "./env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { fingerprint, similarity } from "../src/services/photo-analysis.js";
import { scene } from "../test/helpers/images.js";

const N = 80;
const transforms: Record<string, (img: Buffer) => Promise<Buffer>> = {
  "пережатие JPEG q40": (b) => sharp(b).jpeg({ quality: 40 }).toBuffer(),
  "уменьшение 50%": (b) => sharp(b).resize(320).jpeg().toBuffer(),
  "яркость +25%": (b) => sharp(b).modulate({ brightness: 1.25 }).jpeg().toBuffer(),
  "размытие σ=2": (b) => sharp(b).blur(2).jpeg().toBuffer(),
  "скриншот (PNG + 1px рамка)": (b) => sharp(b).extend({ top: 1, bottom: 1, left: 1, right: 1, background: "#000" }).png().toBuffer(),
  "обрезка 5%": (b) => sharp(b).extract({ left: 16, top: 12, width: 608, height: 456 }).jpeg().toBuffer(),
  "поворот 3°": (b) => sharp(b).rotate(3, { background: "#000" }).resize(640, 480, { fit: "cover" }).jpeg().toBuffer(),
  "зеркало": (b) => sharp(b).flop().jpeg().toBuffer(),
  "обрезка 15%": (b) => sharp(b).extract({ left: 48, top: 36, width: 544, height: 408 }).jpeg().toBuffer()
};
const rows: Array<{ pair: string; kind: "same" | "different"; sim: number }> = [];
for (let i = 0; i < N; i++) {
  const img = await scene(i + 1);
  const fp = await fingerprint(img);
  for (const [name, t] of Object.entries(transforms)) {
    rows.push({ pair: name, kind: "same", sim: similarity(fp.perceptual, (await fingerprint(await t(img))).perceptual) });
  }
  for (let j = 1; j <= 3; j++) {
    const other = await scene(N + i * 3 + j + 1000);
    rows.push({ pair: "другое фото", kind: "different", sim: similarity(fp.perceptual, (await fingerprint(other)).perceptual) });
  }
}
const thresholds = Array.from({ length: 41 }, (_, k) => 0.6 + k * 0.01);
const sweep = thresholds.map((th) => ({
  threshold: Math.round(th * 100) / 100,
  tpr: rows.filter((r) => r.kind === "same" && r.sim > th).length / rows.filter((r) => r.kind === "same").length,
  fpr: rows.filter((r) => r.kind === "different" && r.sim > th).length / rows.filter((r) => r.kind === "different").length
}));
const byPair = [...new Set(rows.map((r) => r.pair))].map((pair) => {
  const s = rows.filter((r) => r.pair === pair).map((r) => r.sim).sort((a, b) => a - b);
  return { pair, n: s.length, detected: s.filter((x) => x > 0.98).length / s.length, median: s[Math.floor(s.length / 2)], min: s[0], max: s.at(-1) };
});
console.table(byPair);
writeFileSync(join(resultsDir, "r4-phash.json"), JSON.stringify({ N, rows, sweep, byPair }, null, 2));
