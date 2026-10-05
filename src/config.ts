import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(8765),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("gpt-oss:20b"),
  WHISPER_URL: z.string().url().default("http://localhost:8000/v1/audio/transcriptions"),
  WHISPER_MODEL: z.string().default("whisper-1"),
  OLLAMA_VISION_MODEL: z.string().default(""),
  AI_STRICT: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  DEADLINE_REMINDER_MINUTES: z.coerce.number().int().positive().default(30),
  OVERDUE_REPEAT_MINUTES: z.coerce.number().int().positive().default(30),
  LONG_OVERDUE_MINUTES: z.coerce.number().int().positive().default(120),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(""),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:8765")
  ,ONE_C_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true")
  ,ONE_C_BASE_URL: z.string().default("")
  ,ONE_C_API_KEY: z.string().default("")
  ,ONE_C_PUSH_PATH: z.string().default("/hs/naryad-ai/events")
  ,ONE_C_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8)
  ,ONE_C_TIMEOUT_MS: z.coerce.number().int().positive().default(15000)
  ,LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5)
  ,LOGIN_MAX_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(30)
  ,LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15)
});

export const config = schema.parse(process.env);
