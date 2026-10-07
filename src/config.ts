import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(8765),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("gpt-oss:20b"),
  WHISPER_URL: z.string().url().default("http://localhost:8000/v1/audio/transcriptions"),
  WHISPER_MODEL: z.string().default("whisper-1"),
  // Domain glossary passed as Whisper's initial prompt; empty string disables it.
  WHISPER_PROMPT: z.string().default("Наряд на ремонт оборудования горно-обогатительного комбината. Подшипник, сальник, сальниковая набивка, грундбукса, редуктор, сапун, муфта, центровка, футеровка, плиты футеровки, дробилка, конусная дробилка, щековая дробилка, конвейер, лента, роликоопора, натяжной барабан, приводной барабан, вулканизация стыка, грохот, питатель, шаровая мельница, гидроциклон, сгуститель, зумпф, пульпопровод, задвижка, насос, электродвигатель, пускатель, концевик, мегаомметр, амортизатор, анкерные болты, РВД, гидросистема, ППР, наряд-допуск, заземление, вибрация."),
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
  ,UPLOAD_URL_TTL_HOURS: z.coerce.number().int().positive().default(168)
  // Plant time zone: shift boundaries, time-of-day analytics, EXIF wall-clock times and message dates.
  ,APP_TIMEZONE: z.string().default("Asia/Qostanay")
  // Day shift start/end hours in APP_TIMEZONE; the rest is the night shift.
  ,DAY_SHIFT_START_HOUR: z.coerce.number().int().min(0).max(23).default(8)
  ,DAY_SHIFT_END_HOUR: z.coerce.number().int().min(0).max(23).default(20)
});

export const config = schema.parse(process.env);
