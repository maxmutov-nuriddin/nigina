import { DateTime, IANAZone } from "luxon";

export type Lang = "uz" | "ru";

export interface Recurrence {
  freq: "daily" | "weekly";
  interval: number;
  /** 1 = dushanba ... 7 = yakshanba (ISO) */
  byWeekday: number[];
  /** Mahalliy vaqt HH:mm */
  time: string;
}

const UZ_MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const RU_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const RU_MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

export function monthName(month: number, lang: Lang): string {
  return (lang === "ru" ? RU_MONTHS_NOM : UZ_MONTHS)[month - 1];
}

export const UZ_WEEKDAYS = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"];
export const RU_WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function weekdayName(isoWeekday: number, lang: Lang): string {
  return (lang === "ru" ? RU_WEEKDAYS : UZ_WEEKDAYS)[isoWeekday - 1];
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;

/**
 * AI qaytargan mahalliy vaqtni ("YYYY-MM-DDTHH:mm" yoki "YYYY-MM-DD") UTC Date'ga aylantiradi.
 * Offset yoki boshqa formatlar qabul qilinmaydi — AI'dan faqat mahalliy vaqt so'raymiz.
 */
export function parseLocal(value: string | null | undefined, tz: string): { date: Date; allDay: boolean } | null {
  if (!value) return null;
  const m = LOCAL_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const allDay = h === undefined;
  const dt = DateTime.fromObject(
    { year: +y, month: +mo, day: +d, hour: allDay ? 0 : +h, minute: allDay ? 0 : +mi },
    { zone: tz },
  );
  if (!dt.isValid) return null;
  return { date: dt.toUTC().toJSDate(), allDay };
}

export function toLocalIso(date: Date, tz: string): string {
  return DateTime.fromJSDate(date, { zone: tz }).toFormat("yyyy-LL-dd'T'HH:mm");
}

export function toLocal(date: Date, tz: string): DateTime {
  return DateTime.fromJSDate(date, { zone: tz });
}

/** "29-oktabr, 20:00" / "29 октября, 20:00". allDay bo'lsa vaqtsiz. */
export function formatDateTime(date: Date, tz: string, lang: Lang, opts: { allDay?: boolean; weekday?: boolean; relativeTo?: Date } = {}): string {
  const dt = toLocal(date, tz);
  const months = lang === "ru" ? RU_MONTHS : UZ_MONTHS;
  let day = lang === "ru" ? `${dt.day} ${months[dt.month - 1]}` : `${dt.day}-${months[dt.month - 1]}`;
  if (opts.relativeTo) {
    const rel = relativeDayWord(date, opts.relativeTo, tz, lang);
    if (rel) day = `${rel}, ${day}`;
  }
  if (opts.weekday) day += ` (${weekdayName(dt.weekday, lang)})`;
  const nowYear = DateTime.now().setZone(tz).year;
  if (dt.year !== nowYear) day = lang === "ru" ? `${day} ${dt.year}` : `${dt.year}-yil ${day}`;
  if (opts.allDay) return day;
  return `${day}, ${dt.toFormat("HH:mm")}`;
}

export function formatTime(date: Date, tz: string): string {
  return toLocal(date, tz).toFormat("HH:mm");
}

/** "bugun" / "ertaga" / "kecha" yoki null */
export function relativeDayWord(date: Date, now: Date, tz: string, lang: Lang): string | null {
  const a = toLocal(date, tz).startOf("day");
  const b = toLocal(now, tz).startOf("day");
  const diff = Math.round(a.diff(b, "days").days);
  const words: Record<number, [string, string]> = { [-1]: ["kecha", "вчера"], 0: ["bugun", "сегодня"], 1: ["ertaga", "завтра"], 2: ["indinga", "послезавтра"] };
  const w = words[diff];
  return w ? (lang === "ru" ? w[1] : w[0]) : null;
}

/** AI uchun: keyingi 14 kunlik kalendar — hafta kunlarini xato hisoblamasligi uchun. */
export function calendarContext(now: Date, tz: string): string {
  const base = toLocal(now, tz).startOf("day");
  const lines: string[] = [];
  for (let i = -1; i < 14; i++) {
    const d = base.plus({ days: i });
    const tag = i === -1 ? " (kecha/вчера)" : i === 0 ? " (bugun/сегодня)" : i === 1 ? " (ertaga/завтра)" : i === 2 ? " (indinga/послезавтра)" : "";
    lines.push(`${UZ_WEEKDAYS[d.weekday - 1]} / ${RU_WEEKDAYS[d.weekday - 1]} (weekday ${d.weekday}) = ${d.toFormat("yyyy-LL-dd")}${tag}`);
  }
  return lines.join("\n");
}

export type RangeKind = "today" | "tomorrow" | "this_week" | "next_week" | "overdue" | "all";

export function dayRange(kind: RangeKind, now: Date, tz: string): { start: Date | null; end: Date | null } {
  const local = toLocal(now, tz);
  switch (kind) {
    case "today":
      return { start: local.startOf("day").toJSDate(), end: local.endOf("day").toJSDate() };
    case "tomorrow": {
      const t = local.plus({ days: 1 });
      return { start: t.startOf("day").toJSDate(), end: t.endOf("day").toJSDate() };
    }
    case "this_week":
      return { start: local.startOf("week").toJSDate(), end: local.endOf("week").toJSDate() };
    case "next_week": {
      const n = local.plus({ weeks: 1 });
      return { start: n.startOf("week").toJSDate(), end: n.endOf("week").toJSDate() };
    }
    case "overdue":
      return { start: null, end: now };
    default:
      return { start: null, end: null };
  }
}

/**
 * Takroriy eslatmaning `after`dan keyingi (qat'iy katta) birinchi vaqti.
 * O'tib ketgan takrorlar o'tkazib yuboriladi — downtime'dan keyin "spam" bo'lmasligi uchun.
 */
export function nextOccurrence(rec: Recurrence, after: Date, tz: string, anchorStart?: Date): Date {
  const [hh, mm] = rec.time.split(":").map(Number);
  const interval = Math.max(1, rec.interval || 1);
  const afterLocal = toLocal(after, tz);
  const start = anchorStart ? toLocal(anchorStart, tz).startOf("day") : afterLocal.startOf("day");
  let cursor = afterLocal.startOf("day");
  for (let i = 0; i < 400 * interval; i++) {
    const candidate = cursor.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (candidate > afterLocal) {
      if (rec.freq === "daily") {
        const daysFromStart = Math.round(cursor.diff(start, "days").days);
        if (daysFromStart >= 0 && daysFromStart % interval === 0) return candidate.toUTC().toJSDate();
      } else {
        const days = rec.byWeekday?.length ? rec.byWeekday : [start.weekday];
        const weeksFromStart = Math.floor(cursor.startOf("week").diff(start.startOf("week"), "weeks").weeks + 1e-9);
        if (days.includes(cursor.weekday) && weeksFromStart >= 0 && weeksFromStart % interval === 0) {
          return candidate.toUTC().toJSDate();
        }
      }
    }
    cursor = cursor.plus({ days: 1 });
  }
  throw new Error("nextOccurrence: topilmadi");
}

export function describeRecurrence(rec: Recurrence, lang: Lang): string {
  if (rec.freq === "daily") {
    if (lang === "ru") return rec.interval > 1 ? `каждые ${rec.interval} дня в ${rec.time}` : `каждый день в ${rec.time}`;
    return rec.interval > 1 ? `har ${rec.interval} kunda, ${rec.time}` : `har kuni, ${rec.time}`;
  }
  const days = (rec.byWeekday ?? []).map((d) => weekdayName(d, lang)).join(", ");
  if (lang === "ru") return `еженедельно (${days}) в ${rec.time}`;
  return `har hafta (${days}), ${rec.time}`;
}
