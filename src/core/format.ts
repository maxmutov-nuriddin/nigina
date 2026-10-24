import type { User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { describeRecurrence, formatDateTime, toLocal, weekdayName, relativeDayWord, type Recurrence } from "../lib/time.ts";

export function catLabel(user: User, cat: string | null | undefined): string {
  const L = t(user.language);
  return L.cat[(cat as keyof typeof L.cat) ?? "other"] ?? L.cat.other;
}

export function fmt(user: User, d: Date, allDay = false): string {
  return formatDateTime(d, user.timezone, user.language, { allDay, weekday: allDay });
}

export interface BlockInput {
  category: string | null;
  title: string;
  event?: Date | null;
  due?: { date: Date; allDay: boolean } | null;
  remind?: Date | null;
  recurrence?: Recurrence | null;
}

export function itemBlock(user: User, b: BlockInput): string[] {
  const L = t(user.language);
  const lines = [`${catLabel(user, b.category)}: ${b.title}`];
  if (b.event) lines.push(L.eventLine(fmt(user, b.event)));
  if (b.due) lines.push(L.dueLine(fmt(user, b.due.date, b.due.allDay)));
  if (b.remind && !b.recurrence) lines.push(L.reminderLine(fmt(user, b.remind)));
  if (b.recurrence) lines.push(L.repeatLine(describeRecurrence(b.recurrence, user.language)));
  return lines;
}

/** Eslatma matnidagi {event_day}, {event_time}, {due_weekday} o'rinbosarlarini to'ldiradi. */
export function fillTemplate(text: string, user: User, ctx: { now: Date; event?: Date | null; due?: Date | null }): string {
  const tz = user.timezone;
  const lang = user.language;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return text
    .replace(/\{event_day\}/g, () => {
      if (!ctx.event) return "";
      return cap(relativeDayWord(ctx.event, ctx.now, tz, lang) ?? formatDateTime(ctx.event, tz, lang, { allDay: true }));
    })
    .replace(/\{event_time\}/g, () => (ctx.event ? toLocal(ctx.event, tz).toFormat("HH:mm") : ""))
    .replace(/\{due_weekday\}/g, () => (ctx.due ? cap(weekdayName(toLocal(ctx.due, tz).weekday, lang)) : ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
