import type { Db } from "../db.ts";
import type { UsageEvent } from "../ai/provider.ts";
import { logger } from "../logger.ts";

export type UsageKind = "voice" | "ai" | "presentation" | "analysis";

/**
 * Kunlik limitni atomar tekshiradi va hisoblagichni oshiradi.
 * Limitdan oshsa false qaytaradi (hisoblagich o'zgarmaydi).
 */
export async function consumeQuota(db: Db, userId: string, kind: UsageKind, limit: number, now = new Date()): Promise<boolean> {
  if (limit <= 0) return true;
  const day = now.toISOString().slice(0, 10);
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "UsageCounter" ("userId", "day", "kind", "count") VALUES (${userId}, ${day}, ${kind}, 1)
    ON CONFLICT ("userId", "day", "kind") DO UPDATE SET "count" = "UsageCounter"."count" + 1
    WHERE "UsageCounter"."count" < ${limit}
    RETURNING "count"`;
  return rows.length > 0;
}

/** AI sarfini yozadi — matn yoki transkripsiya YOZILMAYDI. */
export function usageRecorder(db: Db) {
  return (e: UsageEvent) => {
    db.aiUsageLog
      .create({
        data: {
          userId: e.userId ?? null,
          kind: e.kind,
          model: e.model,
          promptTokens: e.promptTokens ?? null,
          completionTokens: e.completionTokens ?? null,
          audioSeconds: e.audioSeconds ?? null,
          latencyMs: e.latencyMs,
          ok: e.ok,
          errorCode: e.errorCode ?? null,
          provider: e.provider ?? null,
          retryUntil: e.retryAfterSec ? new Date(Date.now() + e.retryAfterSec * 1000) : null,
          limitScope: e.limitScope ?? null,
        },
      })
      .catch((err) => logger.warn({ err: String(err) }, "aiUsageLog yozilmadi"));
    logger.info({ ai: { kind: e.kind, model: e.model, ok: e.ok, pt: e.promptTokens, ct: e.completionTokens, ms: e.latencyMs, code: e.errorCode } }, "ai usage");
  };
}
