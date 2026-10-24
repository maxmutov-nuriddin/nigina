import type { Config } from "../config.ts";

/** ALLOWED_CHAT_IDS bo'sh bo'lsa — hammaga ochiq; aks holda faqat ro'yxatdagi chat/foydalanuvchi ID'lari. */
export function isChatAllowed(cfg: Pick<Config, "ALLOWED_CHAT_IDS">, ...ids: Array<number | undefined | null>): boolean {
  if (!cfg.ALLOWED_CHAT_IDS.length) return true;
  return ids.some((id) => id !== undefined && id !== null && cfg.ALLOWED_CHAT_IDS.includes(Number(id)));
}
