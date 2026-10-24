import type { Prisma, Reminder } from "../db.ts";
import { Prisma as P } from "../db.ts";
import { toLocal, type Recurrence } from "../lib/time.ts";

type Tx = Prisma.TransactionClient;

export interface NewReminder {
  userId: string;
  taskId?: string | null;
  noteId?: string | null;
  presentationId?: string | null;
  text: string;
  fireAt: Date;
  anchor?: "absolute" | "event" | "due";
  offsetMinutes?: number | null;
  recurrence?: Recurrence | null;
}

export function createReminder(tx: Tx, r: NewReminder): Promise<Reminder> {
  return tx.reminder.create({
    data: {
      userId: r.userId,
      taskId: r.taskId ?? null,
      noteId: r.noteId ?? null,
      presentationId: r.presentationId ?? null,
      text: r.text.slice(0, 500),
      fireAt: r.fireAt,
      nextAttemptAt: r.fireAt,
      anchor: r.anchor ?? "absolute",
      offsetMinutes: r.offsetMinutes ?? null,
      recurrence: (r.recurrence ?? P.DbNull) as unknown as Prisma.InputJsonValue,
    },
  });
}

export interface DeadlineReminder {
  kind: "before" | "day";
  fireAt: Date;
  /** Muddatdan necha daqiqa oldin (muddat kuni ertalab, muddat yarim tunda bo'lsa — manfiy) */
  offsetMinutes: number;
}

/**
 * Muddatli vazifa uchun avtomatik eslatmalar: muddatdan bir kun oldin va muddat kuni (standart vaqtda);
 * soati aniq muddatda — kun eslatmasi 2 soat oldin. O'tib ketgan yoki juda yaqin vaqtlar qo'shilmaydi.
 */
export function deadlineReminders(due: { date: Date; allDay: boolean }, now: Date, tz: string, defaultTime: string): DeadlineReminder[] {
  const [h, m] = defaultTime.split(":").map(Number);
  const day = toLocal(due.date, tz).startOf("day");
  const before = day.minus({ days: 1 }).set({ hour: h, minute: m }).toJSDate();
  let onDay = due.allDay ? day.set({ hour: h, minute: m }).toJSDate() : new Date(due.date.getTime() - 2 * 3600_000);
  if (!due.allDay && onDay.getTime() > day.set({ hour: h, minute: m }).toJSDate().getTime()) onDay = day.set({ hour: h, minute: m }).toJSDate();
  const soon = now.getTime() + 5 * 60_000;
  const out: DeadlineReminder[] = [];
  if (before.getTime() > soon && before < onDay) out.push({ kind: "before", fireAt: before, offsetMinutes: Math.round((due.date.getTime() - before.getTime()) / 60_000) });
  if (onDay.getTime() > soon && (due.allDay || onDay < due.date)) out.push({ kind: "day", fireAt: onDay, offsetMinutes: Math.round((due.date.getTime() - onDay.getTime()) / 60_000) });
  return out;
}

/**
 * Yozuvning faol eslatmalarini bekor qiladi. `version` oshadi — ishlov berilayotgan (sending)
 * eslatma ham yakunda versiya mos kelmagani uchun "sent" deb yozilmaydi.
 */
export async function cancelRemindersFor(tx: Tx, userId: string, where: { taskId?: string; noteId?: string }): Promise<number> {
  const res = await tx.reminder.updateMany({
    where: { userId, ...where, status: { in: ["scheduled", "sending"] } },
    data: { status: "cancelled", version: { increment: 1 }, lockedUntil: null, lockedBy: null },
  });
  return res.count;
}

/** Eslatmani yangi vaqtga ko'chiradi (yoki qayta faollashtiradi). Eski "job" mavjud emas — scheduler har doim bazadagi joriy holatni o'qiydi. */
export function rescheduleReminder(tx: Tx, id: string, userId: string, fireAt: Date, extra: Partial<{ anchor: "absolute" | "event" | "due"; offsetMinutes: number | null }> = {}) {
  return tx.reminder.updateMany({
    where: { id, userId },
    data: {
      fireAt,
      nextAttemptAt: fireAt,
      status: "scheduled",
      attempts: 0,
      lastError: null,
      lockedUntil: null,
      lockedBy: null,
      version: { increment: 1 },
      ...extra,
    },
  });
}

export function activeRemindersFor(tx: Tx, userId: string, where: { taskId?: string; noteId?: string }) {
  return tx.reminder.findMany({ where: { userId, ...where, status: { in: ["scheduled", "sending"] } }, orderBy: { fireAt: "asc" } });
}
