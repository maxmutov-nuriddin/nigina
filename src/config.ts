import "dotenv/config";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  /// all | bot | worker — bitta jarayonda hammasi yoki alohida
  APP_ROLE: z.enum(["all", "bot", "worker"]).default("all"),

  DATABASE_URL: z.string().min(1),
  /// Bo'sh — Redis'siz: prezentatsiya navbati jarayon ichida (faqat APP_ROLE=all). Bir nechta worker uchun Redis kerak
  REDIS_URL: z.string().default(""),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  WEBHOOK_URL: z.string().default(""),
  WEBHOOK_SECRET: z.string().default(""),
  /// HTTP port: /health, /health/ready (uptime monitor) va webhook rejimida /telegram/webhook
  WEBHOOK_PORT: int(8080),
  /// Polling rejimida ham HTTP health server ochilsinmi
  HTTP_ENABLED: bool(true),

  GROQ_API_KEY: z.string().default(""),
  GROQ_TRANSCRIPTION_MODEL: z.string().default("whisper-large-v3"),
  GROQ_CHAT_MODEL: z.string().default("openai/gpt-oss-120b"),
  /// Prezentatsiya mazmuni uchun alohida model (bo'sh bo'lsa GROQ_CHAT_MODEL)
  GROQ_PRESENTATION_MODEL: z.string().default(""),
  /// Strict json_schema rejimi (gpt-oss modellari qo'llaydi)
  GROQ_STRICT_JSON: bool(true),
  /// Bo'sh — avtomatik aniqlash (aralash nutq uchun tavsiya); "uz" yoki "ru" — majburiy til
  GROQ_TRANSCRIPTION_LANGUAGE: z.string().default(""),
  /// gpt-oss modellari uchun: low | medium | high. Bo'sh — yuborilmaydi
  GROQ_REASONING_EFFORT: z.enum(["", "low", "medium", "high"]).default(""),
  /// Bitta javob uchun maksimal token — katta/uzun so'rovlar kesilib qolmasligi uchun
  GROQ_MAX_COMPLETION_TOKENS: int(16_384),
  /// Fondagi moliyaviy tahlil uchun alohida kalit/model (bo'sh — asosiy kalit/model)
  GROQ_ANALYSIS_API_KEY: z.string().default(""),
  GROQ_ANALYSIS_MODEL: z.string().default(""),
  GROQ_TIMEOUT_MS: int(120_000),
  /// 429 (rate limit) va 5xx'da SDK retry-after bo'yicha kutib qayta urinadi
  GROQ_MAX_RETRIES: int(3),
  /// TPM limitida Groq SDK qayta urinmaydi — retry-after shu chegaragacha bo'lsa kutib, qayta urinamiz
  GROQ_RATE_LIMIT_MAX_WAIT_MS: int(60_000),
  /// /settings'da ko'rsatish uchun Groq kunlik token limiti (free tier: 200 000). 0 — ko'rsatilmaydi
  GROQ_DAILY_TOKEN_LIMIT: int(200_000),
  /// Asosiy kalit rate limit'ga tushsa, so'rovni tahlil kaliti bilan qayta urinish (ikki akkaunt limitini birlashtiradi)
  GROQ_FALLBACK_TO_ANALYSIS_KEY: bool(false),

  /// Google Gemini (ixtiyoriy). Kalit bo'lsa — matnni tushunish/prezentatsiya/tahlil Gemini'da, limit yoki xatoda Groq'ga o'tiladi.
  /// Kalit bo'lmasa — hammasi Groq'da (avvalgidek).
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta/openai"),
  GEMINI_CHAT_MODEL: z.string().default("gemini-3.8-flash"),
  /// Ovozni matnga aylantirish: Groq Whisper asosiy, Gemini — zaxira (Groq kaliti yo'q bo'lsa — asosiy)
  GEMINI_TRANSCRIPTION_MODEL: z.string().default("gemini-3.8-flash"),
  /// minimal | low | medium | high. Bo'sh — model standarti
  GEMINI_REASONING_EFFORT: z.enum(["", "none", "minimal", "low", "medium", "high"]).default(""),
  GEMINI_TIMEOUT_MS: int(120_000),
  /// Ikkala kalit bo'lsa qaysi biri birinchi ishlatiladi (matn uchun)
  AI_PRIMARY: z.enum(["gemini", "groq"]).default("gemini"),

  DEFAULT_TIMEZONE: z.string().default("Asia/Tashkent"),
  DEFAULT_CURRENCY: z.string().default("UZS"),
  /// Bo'sh — hammaga ochiq. Aks holda faqat shu chat/foydalanuvchi ID'lari (vergul bilan)
  ALLOWED_CHAT_IDS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(/[,\s]+/).filter(Boolean).map((x) => Number(x)))
    .pipe(z.array(z.number().int())),

  // Limitlar
  MAX_VOICE_SECONDS: int(600),
  MAX_VOICE_BYTES: int(20 * 1024 * 1024),
  DAILY_VOICE_LIMIT: int(100),
  DAILY_AI_LIMIT: int(300),
  DAILY_PRESENTATION_LIMIT: int(5),
  MAX_ACTIVE_PRESENTATIONS_PER_USER: int(1),
  PRESENTATION_CONCURRENCY: int(2),
  MAX_SLIDES: int(20),
  DAILY_ANALYSIS_LIMIT: int(48),
  /// Fondagi moliyaviy tahlil sikli
  FINANCE_ANALYSIS_INTERVAL_MS: int(10 * 60_000),
  /// Snapshot shundan eski bo'lsa (yangi tranzaksiya bo'lmasa ham) qayta tahlil qilinadi
  FINANCE_SNAPSHOT_MAX_AGE_HOURS: int(12),

  // Eslatmalar
  SCHEDULER_INTERVAL_MS: int(5_000),
  SCHEDULER_BATCH: int(50),
  REMINDER_LOCK_SECONDS: int(120),
  REMINDER_MAX_ATTEMPTS: int(5),
  /// Shu daqiqagacha kechikish "o'z vaqtida" hisoblanadi
  REMINDER_LATE_GRACE_MINUTES: int(5),
  /// Shundan ko'p kechikkan bir martalik eslatma yuborilmaydi — "o'tkazib yuborilgan" deb belgilanib, umumiy xabar beriladi
  REMINDER_LATE_MAX_HOURS: int(12),

  CONVERSATION_PENDING_TTL_MINUTES: int(60),
  CONVERSATION_HISTORY_TTL_MINUTES: int(30),
  TRANSCRIPT_RETENTION_DAYS: int(30),

  STORAGE_DIR: z.string().default("./storage"),
  TMP_DIR: z.string().default("./tmp"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Render/Heroku kabi platformalar portni PORT orqali beradi — u ustun
  const parsed = EnvSchema.safeParse(env.PORT ? { ...env, WEBHOOK_PORT: env.PORT } : env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Environment xato: ${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
