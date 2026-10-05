// Must be the first import of every research script: points the app code at the research DB and real services.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "dotenv";

const root = resolve(import.meta.dirname, "..");
const env = parse(readFileSync(join(root, ".env")));
Object.assign(process.env, {
  ...env,
  DATABASE_URL: `mysql://naryad:${env.MYSQL_PASSWORD}@127.0.0.1:3407/naryad_research`,
  OLLAMA_VISION_MODEL: process.env.OLLAMA_VISION_MODEL ?? "",
  ONE_C_ENABLED: "false",
  ...(process.env.FORCE_OLLAMA_URL ? { OLLAMA_URL: process.env.FORCE_OLLAMA_URL } : {})
});
export const resultsDir = join(root, "research", "results");
mkdirSync(resultsDir, { recursive: true });
const work = join(root, "research", ".work");
mkdirSync(join(work, "uploads"), { recursive: true });
process.chdir(work);
