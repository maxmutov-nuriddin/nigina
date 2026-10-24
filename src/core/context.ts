import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import type { NluContext } from "../ai/nlu.ts";
import { calendarContext, toLocal, toLocalIso, UZ_WEEKDAYS } from "../lib/time.ts";
import type { StateView } from "./state.ts";

export type ItemType = "task" | "note" | "presentation" | "transaction";
export interface ItemRef {
  type: ItemType;
  id: string;
}

/**
 * AI'ga haqiqiy ID o'rniga qisqa ref'lar (T1, N2, P3) beriladi.
 * Ref faqat shu foydalanuvchining yozuvlaridan tuziladi, shuning uchun AI boshqa foydalanuvchi ID'sini "topa olmaydi".
 * Pending holatda ref'lar "id:<cuid>" ko'rinishida saqlanadi — ular ham egalik bo'yicha qayta tekshiriladi.
 */
export class RefMap {
  private byRef = new Map<string, ItemRef>();
  private byId = new Map<string, string>();
  private counters = { task: 0, note: 0, presentation: 0, transaction: 0 };

  add(type: ItemType, id: string): string {
    const existing = this.byId.get(id);
    if (existing) return existing;
    const prefix = type === "task" ? "T" : type === "note" ? "N" : type === "presentation" ? "P" : "X";
    const ref = `${prefix}${++this.counters[type]}`;
    this.byRef.set(ref, { type, id });
    this.byId.set(id, ref);
    return ref;
  }

  refOf(id: string): string | undefined {
    return this.byId.get(id);
  }

  /** Ref'ni barqaror "id:type:cuid" ko'rinishiga o'tkazadi (egalik keyin resolve'da qayta tekshiriladi). */
  toStable(value: string | null | undefined): string | null {
    if (!value) return null;
    const local = this.byRef.get(value.trim().toUpperCase());
    if (local) return stableRef(local);
    return /^id:/i.test(value.trim()) ? value.trim() : null;
  }

  /** Ref yoki "id:..." qiymatini egalik tekshiruvi bilan aniqlaydi. */
  async resolve(deps: Deps, userId: string, value: string | null | undefined): Promise<ItemRef | null> {
    if (!value) return null;
    const v = value.trim();
    const local = this.byRef.get(v.toUpperCase());
    if (local) return (await ownedItem(deps, userId, local.type, local.id)) ? local : null;
    const m = /^id:(task|note|presentation|transaction):([a-z0-9]+)$/i.exec(v);
    if (m) {
      const type = m[1] as ItemType;
      return (await ownedItem(deps, userId, type, m[2])) ? { type, id: m[2] } : null;
    }
    return null;
  }
}

export function stableRef(item: ItemRef): string {
  return `id:${item.type}:${item.id}`;
}

/** Yozuv mavjud va aynan shu foydalanuvchiga tegishli ekanini tekshiradi. */
export async function ownedItem(deps: Deps, userId: string, type: ItemType, id: string): Promise<boolean> {
  const where = { id, userId };
  if (type === "task") return (await deps.db.task.count({ where })) > 0;
  if (type === "note") return (await deps.db.note.count({ where })) > 0;
  if (type === "transaction") return (await deps.db.transaction.count({ where })) > 0;
  return (await deps.db.presentation.count({ where })) > 0;
}

export async function buildContext(deps: Deps, user: User, state: StateView): Promise<{ ctx: NluContext; refs: RefMap }> {
  const now = deps.clock();
  const tz = user.timezone;
  const refs = new RefMap();
  const recent = new Set(state.recentItems.map((r) => r.id));
  const fmt = (d: Date | null, allDay = false) => (d ? (allDay ? toLocalIso(d, tz).slice(0, 10) : toLocalIso(d, tz)) : null);

  const [tasks, doneTasks, notes, presentations, transactions] = await Promise.all([
    deps.db.task.findMany({
      where: { userId: user.id, status: "active" },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { reminders: { where: { status: { in: ["scheduled", "sending"] } }, orderBy: { fireAt: "asc" } } },
    }),
    deps.db.task.findMany({ where: { userId: user.id, status: "done" }, orderBy: { completedAt: "desc" }, take: 5 }),
    deps.db.note.findMany({
      where: { userId: user.id, OR: [{ status: "active" }, { updatedAt: { gt: new Date(now.getTime() - 7 * 86400_000) } }] },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { reminders: { where: { status: { in: ["scheduled", "sending"] } }, orderBy: { fireAt: "asc" } } },
    }),
    deps.db.presentation.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    deps.db.transaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);

  const lines: string[] = [];
  for (const t of tasks) {
    const ref = refs.add("task", t.id);
    lines.push(
      [
        ref,
        "task",
        t.category,
        `"${t.title}"`,
        t.personName ? `person ${t.personName}` : null,
        t.eventAt ? `event ${fmt(t.eventAt)}` : null,
        t.dueAt ? `due ${fmt(t.dueAt, t.dueAllDay)}` : null,
        t.reminders.length ? `reminders ${t.reminders.map((r) => fmt(r.fireAt)).join(", ")}` : null,
        `created ${fmt(t.createdAt)}`,
        "active",
        recent.has(t.id) ? "recent" : null,
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  for (const t of doneTasks) {
    const ref = refs.add("task", t.id);
    lines.push([ref, "task", t.category, `"${t.title}"`, `done ${fmt(t.completedAt)}`, recent.has(t.id) ? "recent" : null].filter(Boolean).join(" | "));
  }
  for (const n of notes) {
    const ref = refs.add("note", n.id);
    lines.push(
      [
        ref,
        `note(${n.kind})`,
        n.category,
        `"${n.title}"`,
        n.personName ? `person ${n.personName}` : null,
        n.eventAt ? `event ${fmt(n.eventAt)}` : null,
        n.reminders.length ? `reminders ${n.reminders.map((r) => fmt(r.fireAt)).join(", ")}` : null,
        `created ${fmt(n.createdAt)}`,
        n.status,
        recent.has(n.id) ? "recent" : null,
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  for (const p of presentations) {
    const ref = refs.add("presentation", p.id);
    const taskRef = p.taskId ? refs.refOf(p.taskId) : undefined;
    lines.push(
      [ref, "presentation", `"${p.topic}"`, `status ${p.status}`, `${p.slideCount} slides`, taskRef ? `for ${taskRef}` : null, recent.has(p.id) ? "recent" : null]
        .filter(Boolean)
        .join(" | "),
    );
  }

  for (const x of transactions) {
    const ref = refs.add("transaction", x.id);
    lines.push(
      [ref, x.kind, x.category, `${x.amount.toString()} ${x.currency}`, x.description ? `"${x.description}"` : null, `at ${fmt(x.occurredAt)}`, recent.has(x.id) ? "recent" : null]
        .filter(Boolean)
        .join(" | "),
    );
  }

  const local = toLocal(now, tz);
  const ctx: NluContext = {
    userId: user.id,
    nowLocal: local.toFormat("yyyy-LL-dd'T'HH:mm"),
    weekday: UZ_WEEKDAYS[local.weekday - 1],
    timezone: tz,
    language: user.language,
    defaultReminderTime: user.defaultReminderTime,
    calendar: calendarContext(now, tz),
    history: state.history.map((h) => `${h.role}: ${h.text}`).join("\n"),
    items: lines.join("\n"),
  };
  return { ctx, refs };
}
