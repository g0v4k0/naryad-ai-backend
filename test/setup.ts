import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { afterAll, beforeEach } from "vitest";
import { mocks, ollamaReply, startMock } from "./helpers/mocks.js";

const root = resolve(import.meta.dirname, "..");
const env = parse(readFileSync(join(root, ".env")));
const testDbUrl = process.env.TEST_DATABASE_URL ?? `mysql://naryad:${env.MYSQL_PASSWORD}@127.0.0.1:3407/naryad_test`;

mocks.ollama = await startMock(() => ollamaReply({ verdict: "ACCEPTED", score: 5, explanation: "Работа выполнена", strengths: ["Полное описание"], improvements: [] }));
mocks.whisper = await startMock(() => ({ json: { text: "заменить подшипник", language: "ru", durationSec: 1.2 } }));
mocks.oneC = await startMock(() => ({ json: { externalId: "1C-ORDER-1" } }));

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: testDbUrl,
  JWT_SECRET: "test-secret-test-secret-test-secret",
  OLLAMA_URL: mocks.ollama.url,
  OLLAMA_MODEL: "test-model",
  OLLAMA_VISION_MODEL: "",
  WHISPER_URL: `${mocks.whisper.url}/transcribe`,
  AI_STRICT: "false",
  PUBLIC_APP_URL: "http://naryad.test",
  FIREBASE_SERVICE_ACCOUNT_JSON: "",
  ONE_C_ENABLED: "true",
  ONE_C_BASE_URL: mocks.oneC.url,
  ONE_C_API_KEY: "test-1c-key-123456",
  ONE_C_MAX_ATTEMPTS: "3",
  ONE_C_TIMEOUT_MS: "2000"
});

// uploads/ is resolved relative to cwd; keep test files out of the deployed uploads volume.
process.chdir(mkdtempSync(join(tmpdir(), "naryad-test-")));

beforeEach(() => {
  mocks.ollama.reset();
  mocks.whisper.reset();
  mocks.oneC.reset();
});

afterAll(async () => {
  await Promise.all([mocks.ollama.close(), mocks.whisper.close(), mocks.oneC.close()]);
});
