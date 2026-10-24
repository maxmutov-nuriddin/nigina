import type { Config } from "../config.ts";
import type { Db } from "../db.ts";

type AccessCfg = Pick<Config, "ALLOWED_CHAT_IDS" | "OWNER_CHAT_ID">;
type Id = number | bigint | undefined | null;

const ids = (list: Id[]) => list.filter((id): id is number | bigint => id !== undefined && id !== null).map(Number);

export function isOwner(cfg: AccessCfg, id: Id): boolean {
  return cfg.OWNER_CHAT_ID > 0 && id !== undefined && id !== null && Number(id) === cfg.OWNER_CHAT_ID;
}

/**
 * Kim botdan foydalana oladi:
 *  - asosiy foydalanuvchi (OWNER_CHAT_ID) va ALLOWED_CHAT_IDS — doim;
 *  - asosiy foydalanuvchi ruxsat bergan (AccessRequest.status = approved);
 *  - OWNER_CHAT_ID=0 va ALLOWED_CHAT_IDS bo'sh — hammaga ochiq.
 */
export async function hasAccess(deps: { cfg: AccessCfg; db: Db }, ...list: Id[]): Promise<boolean> {
  const cfg = deps.cfg;
  const known = ids(list);
  if (!cfg.OWNER_CHAT_ID && !cfg.ALLOWED_CHAT_IDS.length) return true;
  if (known.some((id) => id === cfg.OWNER_CHAT_ID || cfg.ALLOWED_CHAT_IDS.includes(id))) return true;
  if (!cfg.OWNER_CHAT_ID || !known.length) return false;
  const n = await deps.db.accessRequest.count({ where: { telegramUserId: { in: known.map((id) => BigInt(id)) }, status: "approved" } });
  return n > 0;
}
