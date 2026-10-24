import { pino } from "pino";
import { config } from "./config.ts";

/**
 * Loglarga API kalitlari, tokenlar va foydalanuvchi matnlari chiqmasligi kerak.
 * Matn/transkripsiyani hech qachon log maydoniga qo'ymang — faqat uzunlik/ID.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "token",
      "apiKey",
      "*.apiKey",
      "*.token",
      "headers.authorization",
      "*.headers.authorization",
      "text",
      "*.text",
      "transcript",
      "*.transcript",
      "caption",
      "*.caption",
    ],
    censor: "[redacted]",
  },
});

/** Xato xabaridan bot tokenini tozalaydi (grammY URL'larida token bo'ladi). */
export function safeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot<redacted>")
    .replace(/gsk_[A-Za-z0-9]{10,}/g, "gsk_<redacted>")
    .slice(0, 500);
}
