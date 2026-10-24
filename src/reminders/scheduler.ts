import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { GrammyError, HttpError } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { Deps } from "../deps.ts";
import type { Prisma, User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { nextOccurrence, type Recurrence } from "../lib/time.ts";
import { logger, safeError } from "../logger.ts";
import { catLabel, fillTemplate, fmt } from "../core/format.ts";
import { hasAccess } from "../lib/access.ts";

interface Claimed {
  id: string;
  version: number;
  attempts: number;
}

const reminderInclude = {
  user: true,
  task: true,
  note: true,
  presentation: { include: { task: true } },
} satisfies Prisma.ReminderInclude;

type FullReminder = Prisma.ReminderGetPayload<{ include: typeof reminderInclude }>;

/**
 * Eslatmalar faqat bazada saqlanadi; scheduler davriy ravishda muddati kelganlarini atomar "claim" qiladi.
 *  - Bir nechta worker: `FOR UPDATE SKIP LOCKED` + `lockedUntil` — bitta eslatmani faqat bitta worker oladi.
 *  - Worker yiqilsa: `lockedUntil` o'tgach eslatma qayta olinadi (oldingi urinish "uncertain" deb belgilanadi).
 *  - Bekor qilingan / ko'chirilgan eslatma: holat va `version` yakunda tekshiriladi — eski vaqt yuborilmaydi.
 *  - Yetkazish kafolati: "kamida bir marta" (at-least-once). Tarmoq uzilsa, xabar ikki marta borishi mumkin.
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly workerId: string;
  /** Oxirgi muvaffaqiyatli sikl vaqti — /health/ready uchun */
  lastTickOkAt: Date | null = null;

  constructor(private deps: Deps, workerId?: string) {
    this.workerId = workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.safeTick(), this.deps.cfg.SCHEDULER_INTERVAL_MS);
    void this.safeTick();
    logger.info({ workerId: this.workerId }, "Reminder scheduler ishga tushdi");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
      this.lastTickOkAt = new Date();
    } catch (err) {
      logger.error({ err: safeError(err) }, "scheduler tick xatosi");
    } finally {
      this.running = false;
    }
  }

  /** Bitta sikl: muddati kelganlarni olib, yuboradi. Yuborilganlar sonini qaytaradi. */
  async tick(): Promise<number> {
    const claimed = await this.claim();
    const missed = new Map<string, { user: User; lines: string[] }>();
    let sent = 0;
    for (const c of claimed) {
      try {
        if (await this.deliver(c, missed)) sent++;
      } catch (err) {
        logger.error({ err: safeError(err), reminderId: c.id }, "deliver xatosi");
      }
    }
    for (const { user, lines } of missed.values()) {
      try {
        await this.deps.messenger.send(user.chatId, t(user.language).missedSummary(lines.join("\n")));
      } catch (err) {
        logger.warn({ err: safeError(err), userId: user.id }, "missed summary yuborilmadi");
      }
    }
    return sent;
  }

  async claim(): Promise<Claimed[]> {
    const now = this.deps.clock();
    const lockUntil = new Date(now.getTime() + this.deps.cfg.REMINDER_LOCK_SECONDS * 1000);
    return this.deps.db.$queryRaw<Claimed[]>`
      UPDATE "Reminder" AS r
      SET "status" = 'sending'::"ReminderStatus", "lockedUntil" = ${lockUntil}, "lockedBy" = ${this.workerId},
          "attempts" = r."attempts" + 1, "updatedAt" = ${now}
      WHERE r."id" IN (
        SELECT "id" FROM "Reminder"
        WHERE ("status" = 'scheduled' AND "nextAttemptAt" <= ${now})
           OR ("status" = 'sending' AND "lockedUntil" < ${now})
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${this.deps.cfg.SCHEDULER_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING r."id", r."version", r."attempts"`;
  }

  private async deliver(c: Claimed, missed: Map<string, { user: User; lines: string[] }>): Promise<boolean> {
    const { db, cfg } = this.deps;
    const now = this.deps.clock();
    const rem = await db.reminder.findUnique({ where: { id: c.id }, include: reminderInclude });
    if (!rem || rem.status !== "sending" || rem.version !== c.version || rem.lockedBy !== this.workerId) return false;

    // Oldingi worker yiqilgan bo'lsa — uning yakunlanmagan urinishi "noaniq"
    await db.deliveryAttempt.updateMany({ where: { reminderId: rem.id, status: "pending" }, data: { status: "uncertain", finishedAt: now, error: "worker lock expired" } });

    const user = rem.user;
    const L = t(user.language);
    const recurrence = rem.recurrence as unknown as Recurrence | null;
    const lateMs = now.getTime() - rem.fireAt.getTime();

    // Bloklangan, ruxsat etilmagan foydalanuvchi yoki o'chirilgan eslatmalar
    if (user.blockedAt || !user.remindersEnabled || !(await hasAccess(this.deps, user.telegramUserId, user.chatId))) {
      await this.finalize(rem, c, now, { skipped: true, reason: user.blockedAt ? "user_blocked" : user.remindersEnabled ? "chat_not_allowed" : "reminders_disabled" });
      return false;
    }

    // Kechikkan-yetkazish siyosati: juda kech bo'lsa alohida yubormaymiz, umumiy xabarda aytamiz
    if (lateMs > cfg.REMINDER_LATE_MAX_HOURS * 3600_000 && c.attempts === 1) {
      await this.finalize(rem, c, now, { skipped: true, reason: "too_late" });
      const entry = missed.get(user.id) ?? { user, lines: [] };
      entry.lines.push(`• ${fillTemplate(rem.text, user, { now: rem.fireAt, event: rem.task?.eventAt ?? rem.note?.eventAt, due: rem.task?.dueAt })} — ${fmt(user, rem.fireAt)}`);
      missed.set(user.id, entry);
      return false;
    }
    const late = lateMs > cfg.REMINDER_LATE_GRACE_MINUTES * 60_000;

    const message = this.compose(rem, now, late, recurrence ? c.version + 1 : c.version);
    const attempt = await db.deliveryAttempt.create({
      data: { reminderId: rem.id, userId: user.id, attemptNo: c.attempts, reminderVersion: c.version, lateBySec: Math.max(0, Math.round(lateMs / 1000)), workerId: this.workerId },
    });

    try {
      let messageId: number;
      if (message.fileId) {
        messageId = (await this.deps.messenger.sendDocument(user.chatId, { fileId: message.fileId }, message.text, { keyboard: message.keyboard })).messageId;
      } else {
        messageId = await this.deps.messenger.send(user.chatId, message.text, { keyboard: message.keyboard });
      }
      await db.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: "sent", telegramMessageId: messageId, finishedAt: this.deps.clock() } });
      await this.finalize(rem, c, now, { skipped: false });
      return true;
    } catch (err) {
      await this.handleSendError(rem, c, attempt.id, err);
      return false;
    }
  }

  private compose(rem: FullReminder, now: Date, late: boolean, buttonVersion: number): { text: string; keyboard?: InlineKeyboardMarkup; fileId?: string } {
    const user = rem.user;
    const L = t(user.language);
    const event = rem.task?.eventAt ?? rem.note?.eventAt ?? null;
    const due = rem.task?.dueAt ?? rem.presentation?.task?.dueAt ?? null;
    const body = fillTemplate(rem.text, user, { now, event, due });
    const lines: string[] = [];
    if (late) lines.push(L.latePrefix(fmt(user, rem.fireAt)), "");
    lines.push(L.reminderFire(body));
    if (rem.task && rem.task.title !== body) lines.push(`${catLabel(user, rem.task.category)}: ${rem.task.title}`);
    if (event && !rem.text.includes("{event_time}")) lines.push(L.eventLine(fmt(user, event)));

    const snooze: InlineKeyboardButton[] = [
      { text: L.btn.snooze10, callback_data: `rs:${rem.id}:${buttonVersion}:10` },
      { text: L.btn.snooze60, callback_data: `rs:${rem.id}:${buttonVersion}:60` },
    ];
    const kb: InlineKeyboardButton[][] = [];
    if (rem.task && rem.task.status === "active") {
      kb.push([{ text: L.btn.done, callback_data: `td:${rem.task.id}` }], snooze, [
        { text: L.btn.changeTime, callback_data: `ct:t:${rem.task.id}` },
        { text: L.btn.cancel, callback_data: `cx:t:${rem.task.id}` },
      ]);
    } else if (rem.note) {
      kb.push(snooze, [{ text: L.btn.cancel, callback_data: `cx:n:${rem.note.id}` }]);
    } else kb.push(snooze);

    const pres = rem.presentation;
    if (pres) {
      if (pres.status === "ready" && pres.telegramFileId) {
        return { text: lines.join("\n"), keyboard: { inline_keyboard: kb }, fileId: pres.telegramFileId };
      }
      lines.push("", L.presNotReady(L.pres.statusName[pres.status] ?? pres.status));
      if (pres.status === "failed") kb.unshift([{ text: L.btn.retry, callback_data: `pr:${pres.id}` }]);
    }
    return { text: lines.join("\n"), keyboard: { inline_keyboard: kb } };
  }

  /** Yakunlash faqat claim paytidagi versiya o'zgarmagan bo'lsa — aks holda foydalanuvchi o'zgartirgan holat saqlanadi. */
  private async finalize(rem: FullReminder, c: Claimed, now: Date, o: { skipped: boolean; reason?: string }): Promise<void> {
    const recurrence = rem.recurrence as unknown as Recurrence | null;
    const base = { id: rem.id, version: c.version, status: "sending" as const, lockedBy: this.workerId };
    if (recurrence) {
      // O'tib ketgan takrorlarni yubormasdan keyingi kelajakdagi vaqtga o'tamiz
      const next = nextOccurrence(recurrence, new Date(Math.max(now.getTime(), rem.fireAt.getTime())), rem.user.timezone, rem.createdAt);
      await this.deps.db.reminder.updateMany({
        where: base,
        data: {
          status: "scheduled",
          fireAt: next,
          nextAttemptAt: next,
          attempts: 0,
          version: { increment: 1 },
          lockedUntil: null,
          lockedBy: null,
          lastError: o.reason ?? null,
          ...(o.skipped ? {} : { lastSentAt: now, sentCount: { increment: 1 } }),
        },
      });
      return;
    }
    await this.deps.db.reminder.updateMany({
      where: base,
      data: o.skipped
        ? { status: "missed", lockedUntil: null, lockedBy: null, lastError: o.reason ?? null }
        : { status: "sent", lastSentAt: now, sentCount: { increment: 1 }, lockedUntil: null, lockedBy: null, lastError: null },
    });
  }

  private async handleSendError(rem: FullReminder, c: Claimed, attemptId: string, err: unknown): Promise<void> {
    const { db, cfg } = this.deps;
    const now = this.deps.clock();
    let permanent = false;
    let uncertain = false;
    let delayMs = Math.min(30_000 * 2 ** Math.max(0, c.attempts - 1), 15 * 60_000);
    if (err instanceof GrammyError) {
      if (err.error_code === 403) {
        permanent = true;
        await db.user.update({ where: { id: rem.userId }, data: { blockedAt: now } });
      } else if (err.error_code === 400) permanent = true;
      else if (err.error_code === 429) delayMs = Math.max(delayMs, ((err.parameters?.retry_after as number | undefined) ?? 5) * 1000);
    } else if (err instanceof HttpError) {
      // Javob kelmadi — xabar yetib borgan bo'lishi ham mumkin
      uncertain = true;
    }
    const errorText = safeError(err);
    await db.deliveryAttempt.update({ where: { id: attemptId }, data: { status: uncertain ? "uncertain" : "failed", error: errorText, finishedAt: now } });
    const giveUp = permanent || c.attempts >= cfg.REMINDER_MAX_ATTEMPTS;
    logger.warn({ reminderId: rem.id, attempt: c.attempts, giveUp, err: errorText }, "eslatma yuborilmadi");
    if (giveUp && !permanent && rem.recurrence) {
      // Takroriy eslatma butunlay to'xtamasin — keyingi takrorga o'tamiz
      await this.finalize(rem, c, now, { skipped: true, reason: "max_attempts" });
      return;
    }
    await db.reminder.updateMany({
      where: { id: rem.id, version: c.version, status: "sending", lockedBy: this.workerId },
      data: giveUp
        ? { status: "failed", lastError: errorText, lockedUntil: null, lockedBy: null }
        : { status: "scheduled", nextAttemptAt: new Date(now.getTime() + delayMs), lastError: errorText, lockedUntil: null, lockedBy: null },
    });
  }
}
