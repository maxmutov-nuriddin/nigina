import { DateTime } from "luxon";
import type { Deps } from "../deps.ts";
import type { FinanceSnapshot, Prisma, User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { consumeQuota } from "../lib/usage.ts";
import { logger, safeError } from "../logger.ts";
import { hasAccess } from "../lib/access.ts";
import { computeStats, money, type FinanceStats } from "./analytics.ts";

/**
 * Joriy oy uchun moliyaviy snapshot'ni yangilaydi (kerak bo'lsa).
 * Raqamlar kodda hisoblanadi; AI izohi alohida "tahlil" Groq kaliti bilan yoziladi.
 * Yangi tranzaksiya bo'lmasa va snapshot yangi bo'lsa — qayta hisoblanmaydi (xarajat tejaladi).
 */
export async function ensureSnapshot(deps: Deps, user: User, o: { alert?: boolean } = {}): Promise<{ stats: FinanceStats; insight: string | null }> {
  const now = deps.clock();
  const month = DateTime.fromJSDate(now, { zone: user.timezone }).toFormat("yyyy-LL");
  const [snap, latest] = await Promise.all([
    deps.db.financeSnapshot.findUnique({ where: { userId: user.id } }),
    deps.db.transaction.aggregate({ where: { userId: user.id }, _max: { updatedAt: true } }),
  ]);
  const lastTxAt = latest._max.updatedAt ?? null;
  const maxAge = deps.cfg.FINANCE_SNAPSHOT_MAX_AGE_HOURS * 3600_000;
  const fresh =
    snap &&
    snap.month === month &&
    (!lastTxAt || (snap.lastTxAt && snap.lastTxAt >= lastTxAt)) &&
    now.getTime() - snap.computedAt.getTime() < maxAge;
  if (fresh) return { stats: snap.stats as unknown as FinanceStats, insight: snap.insight };

  const stats = await computeStats(deps.db, user, "this_month", now);
  let insight: string | null = null;
  if (stats.txCount > 0 && deps.analysisNlu && (await consumeQuota(deps.db, user.id, "analysis", deps.cfg.DAILY_ANALYSIS_LIMIT, now))) {
    try {
      const res = await deps.analysisNlu.financeInsight({ ...stats, currency_display: money(0, stats.currency, user.language).replace(/^0\s*/, "") }, user.language, user.id);
      insight = res.insights.filter((x) => x.trim()).slice(0, 4).map((x) => `• ${x.trim()}`).join("\n") || null;
    } catch (err) {
      logger.warn({ err: safeError(err), userId: user.id }, "moliyaviy tahlil (AI) bajarilmadi — faqat raqamlar");
      insight = snap?.month === month ? snap.insight : null;
    }
  }

  const data = { month, stats: stats as unknown as Prisma.InputJsonValue, insight, insightAt: insight ? now : null, lastTxAt, computedAt: now };
  const saved = await deps.db.financeSnapshot.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
  if (o.alert) await maybeAlert(deps, user, stats, saved);
  return { stats, insight };
}

/** Joriy sur'atda oy oxirida zarar kutilsa — oyiga bir marta ogohlantirish. */
async function maybeAlert(deps: Deps, user: User, stats: FinanceStats, snap: FinanceSnapshot): Promise<void> {
  const f = stats.month?.forecast;
  if (!f || stats.txCount < 5) return;
  const month = snap.month;
  const alreadyLoss = snap.alertMonth === month && snap.alertState === "loss";
  if (f.net < 0 && !alreadyLoss) {
    if (user.remindersEnabled && !user.blockedAt) {
      const m = (v: number) => money(v, stats.currency, user.language);
      await deps.messenger.send(user.chatId, t(user.language).fin.lossAlert(m(Math.abs(f.net)), m(f.expense), m(f.income)));
    }
    await deps.db.financeSnapshot.update({ where: { userId: user.id }, data: { alertState: "loss", alertMonth: month } });
  } else if (f.net >= 0 && alreadyLoss) {
    await deps.db.financeSnapshot.update({ where: { userId: user.id }, data: { alertState: "profit" } });
  }
}

/** Fondagi doimiy tahlil: oxirgi 35 kunda tranzaksiyasi bor foydalanuvchilar uchun snapshot'larni yangilaydi. */
export class FinanceAnalyzer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private deps: Deps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.safeTick(), this.deps.cfg.FINANCE_ANALYSIS_INTERVAL_MS);
    setTimeout(() => void this.safeTick(), 15_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private async safeTick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (err) {
      logger.error({ err: safeError(err) }, "finance analyzer xatosi");
    } finally {
      this.running = false;
    }
  }

  async tick(): Promise<number> {
    const since = new Date(this.deps.clock().getTime() - 35 * 86400_000);
    const users = await this.deps.db.user.findMany({ where: { blockedAt: null, transactions: { some: { occurredAt: { gte: since } } } }, take: 100 });
    let n = 0;
    for (const user of users) {
      if (!(await hasAccess(this.deps, user.telegramUserId, user.chatId))) continue;
      try {
        await ensureSnapshot(this.deps, user, { alert: true });
        n++;
      } catch (err) {
        logger.warn({ err: safeError(err), userId: user.id }, "snapshot yangilanmadi");
      }
    }
    return n;
  }
}
