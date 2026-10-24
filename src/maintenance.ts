import type { Deps } from "./deps.ts";
import { logger } from "./logger.ts";

/**
 * Davriy tozalash:
 *  - eski ProcessedUpdate yozuvlari (7 kun)
 *  - transkripsiyalar (TRANSCRIPT_RETENTION_DAYS) — shaxsiy ma'lumot keraksiz saqlanmasin
 *  - muddati o'tgan kutilayotgan aniqlashtirishlar
 *  - eski DeliveryAttempt (30 kun)
 */
export async function runMaintenance(deps: Deps): Promise<void> {
  const now = deps.clock().getTime();
  const day = 86400_000;
  const [updates, transcripts, pendings, attempts] = await Promise.all([
    deps.db.processedUpdate.deleteMany({ where: { startedAt: { lt: new Date(now - 7 * day) } } }),
    deps.db.inboundMessage.updateMany({
      where: { createdAt: { lt: new Date(now - deps.cfg.TRANSCRIPT_RETENTION_DAYS * day) }, transcript: { not: null } },
      data: { transcript: null },
    }),
    deps.db.conversationState.updateMany({ where: { pendingExpiresAt: { lt: new Date(now) } }, data: { pendingExpiresAt: null } }),
    deps.db.deliveryAttempt.deleteMany({ where: { createdAt: { lt: new Date(now - 30 * day) } } }),
  ]);
  if (updates.count || transcripts.count || attempts.count) {
    logger.info({ updates: updates.count, transcripts: transcripts.count, pendings: pendings.count, attempts: attempts.count }, "maintenance");
  }
}
