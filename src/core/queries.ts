import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { Deps } from "../deps.ts";
import type { Prisma, User } from "../db.ts";
import type { ListFilter } from "../ai/schemas.ts";
import { t } from "../lib/i18n.ts";
import { dayRange, describeRecurrence, formatDateTime, toLocal, type Recurrence } from "../lib/time.ts";
import { catLabel, fmt, truncate } from "./format.ts";
import { computeStats, financeKeyboard, formatReport, type FinancePeriod } from "../finance/analytics.ts";
import { ensureSnapshot } from "../finance/background.ts";

export interface View {
  text: string;
  keyboard?: InlineKeyboardMarkup;
}

export const defaultFilter = (patch: Partial<ListFilter> = {}): ListFilter => ({
  range: "all",
  item_type: "any",
  category: null,
  person_name: null,
  note_kind: null,
  query_text: null,
  status: "active",
  ...patch,
});

export async function renderQuery(deps: Deps, user: User, intent: "list_items" | "search_notes" | "finance_report", filter: ListFilter | null, period?: string | null): Promise<View> {
  if (intent === "finance_report") return financeView(deps, user, (period as FinancePeriod | null) ?? "this_month");
  const f = filter ?? defaultFilter();
  if (intent === "search_notes" || f.item_type === "note") return notesView(deps, user, f);
  if (f.item_type === "presentation") return presentationsView(deps, user);
  return tasksView(deps, user, f);
}

export async function tasksView(deps: Deps, user: User, f: ListFilter): Promise<View> {
  const L = t(user.language);
  const now = deps.clock();
  const { start, end } = dayRange(f.range, now, user.timezone);
  const statusWhere = f.status === "done" ? { status: "done" as const } : f.status === "any" ? {} : { status: "active" as const };

  const where: Prisma.TaskWhereInput = { userId: user.id, ...statusWhere };
  if (f.category) where.category = f.category;
  if (f.person_name) where.personName = { contains: f.person_name, mode: "insensitive" };
  if (f.query_text) where.title = { contains: f.query_text, mode: "insensitive" };
  if (f.range === "overdue") {
    where.OR = [{ dueAt: { lt: now } }, { eventAt: { lt: now } }];
  } else if (start && end) {
    const inRange = { gte: start, lte: end };
    where.OR = [{ eventAt: inRange }, { dueAt: inRange }, { reminders: { some: { fireAt: inRange, status: { in: ["scheduled", "sending", "sent"] }, anchor: { not: "due" } } } }];
    if (f.status === "done") where.OR.push({ completedAt: inRange });
  }

  const tasks = await deps.db.task.findMany({
    where,
    include: { reminders: { where: { status: { in: ["scheduled", "sending"] }, anchor: { not: "due" } }, orderBy: { fireAt: "asc" }, take: 1 } },
    take: 50,
  });
  const primary = (tk: (typeof tasks)[number]) => tk.eventAt ?? tk.reminders[0]?.fireAt ?? tk.dueAt ?? null;
  tasks.sort((a, b) => (primary(a)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (primary(b)?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.createdAt.getTime() - b.createdAt.getTime());

  // "Bugun" ro'yxatiga muddati o'tgan faol vazifalar ham qo'shiladi
  let overdue: typeof tasks = [];
  if (f.range === "today" && f.status !== "done" && start) {
    overdue = await deps.db.task.findMany({
      where: { userId: user.id, status: "active", dueAt: { lt: start }, ...(f.category ? { category: f.category } : {}) },
      include: { reminders: { where: { status: { in: ["scheduled", "sending"] }, anchor: { not: "due" } }, orderBy: { fireAt: "asc" }, take: 1 } },
      orderBy: { dueAt: "asc" },
      take: 10,
    });
  }

  // Shu oraliqdagi qaydlar (masalan, "Aziz darsga kelmaydi")
  const notes =
    start && end && f.range !== "overdue" && !f.category && f.status !== "done"
      ? await deps.db.note.findMany({ where: { userId: user.id, status: "active", eventAt: { gte: start, lte: end } }, orderBy: { eventAt: "asc" }, take: 10 })
      : [];

  const header = f.status === "done" ? "✅" : (L.lists[f.range] ?? L.lists.all);
  const sameDay = f.range === "today" || f.range === "tomorrow";
  const lines: string[] = [header + (f.category ? ` — ${catLabel(user, f.category)}` : ""), ""];
  const kb: InlineKeyboardButton[][] = [];
  let n = 0;
  const pushTask = (tk: (typeof tasks)[number], mark = "") => {
    n++;
    const p = primary(tk);
    const when = p ? (sameDay && p === tk.eventAt ? toLocal(p, user.timezone).toFormat("HH:mm") : fmt(user, p, p === tk.dueAt && tk.dueAllDay)) : "";
    const done = tk.status === "done" ? "✔️ " : "";
    lines.push(`${n}. ${done}${catLabel(user, tk.category).split(" ")[0]} ${tk.title}${when ? ` — ${when}` : ""}${mark}`);
    if (kb.length < 10) kb.push([{ text: `${n}. ${truncate(tk.title, 30)}`, callback_data: `it:t:${tk.id}` }]);
  };
  tasks.forEach((tk) => pushTask(tk));
  if (overdue.length) {
    lines.push("", L.lists.overdue);
    overdue.filter((o) => !tasks.some((x) => x.id === o.id)).forEach((tk) => pushTask(tk));
  }
  if (notes.length) {
    lines.push("", L.lists.notes);
    for (const note of notes) {
      lines.push(`• ${note.title}${note.eventAt ? ` — ${sameDay ? toLocal(note.eventAt, user.timezone).toFormat("HH:mm") : fmt(user, note.eventAt)}` : ""}`);
      if (kb.length < 10) kb.push([{ text: `📝 ${truncate(note.title, 30)}`, callback_data: `it:n:${note.id}` }]);
    }
  }
  if (n === 0 && notes.length === 0) lines.push(L.empty);
  return { text: lines.join("\n"), keyboard: kb.length ? { inline_keyboard: kb } : undefined };
}

export async function notesView(deps: Deps, user: User, f: ListFilter): Promise<View> {
  const L = t(user.language);
  const now = deps.clock();
  const { start, end } = dayRange(f.range, now, user.timezone);
  const where: Prisma.NoteWhereInput = { userId: user.id };
  if (f.note_kind) where.kind = f.note_kind;
  if (f.person_name) where.personName = { contains: f.person_name, mode: "insensitive" };
  if (f.query_text) where.OR = [{ title: { contains: f.query_text, mode: "insensitive" } }, { body: { contains: f.query_text, mode: "insensitive" } }];
  if (start && end) where.AND = [{ OR: [{ eventAt: { gte: start, lte: end } }, { eventAt: null, createdAt: { gte: start, lte: end } }] }];
  if (f.status === "active" && f.note_kind !== "absence") where.status = "active";

  const notes = await deps.db.note.findMany({ where, orderBy: [{ eventAt: "asc" }, { createdAt: "desc" }], take: 30 });
  const header = f.note_kind === "absence" ? L.lists.absences : L.lists.notes;
  const lines = [header + (f.range !== "all" ? ` (${L.lists[f.range].replace(/^\S+\s/, "")})` : ""), ""];
  const kb: InlineKeyboardButton[][] = [];
  for (const note of notes) {
    const when = note.eventAt ? fmt(user, note.eventAt) : formatDateTime(note.createdAt, user.timezone, user.language);
    const cancelled = note.status === "cancelled" ? ` ❌ (${note.statusReason || L.statusWord.cancelled})` : "";
    if (note.kind === "absence" && note.personName) lines.push(`${L.absenceLine(note.personName, when)} — ${note.title}${cancelled}`);
    else lines.push(`• ${note.title} — ${when}${cancelled}`);
    if (note.status === "active" && kb.length < 10) kb.push([{ text: `📝 ${truncate(note.title, 30)}`, callback_data: `it:n:${note.id}` }]);
  }
  if (!notes.length) lines.push(L.empty);
  return { text: lines.join("\n"), keyboard: kb.length ? { inline_keyboard: kb } : undefined };
}

/** Moliyaviy hisobot: joriy oy — snapshot (fondagi tahlil izohi bilan), boshqa davrlar — jonli hisob. */
export async function financeView(deps: Deps, user: User, period: FinancePeriod): Promise<View> {
  if (period === "this_month") {
    const { stats, insight } = await ensureSnapshot(deps, user);
    return { text: formatReport(user, stats, insight), keyboard: financeKeyboard(user.language) };
  }
  const stats = await computeStats(deps.db, user, period, deps.clock());
  return { text: formatReport(user, stats, null), keyboard: financeKeyboard(user.language) };
}

export async function presentationsView(deps: Deps, user: User): Promise<View> {
  const L = t(user.language);
  const list = await deps.db.presentation.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 });
  const lines = [L.lists.presentations, ""];
  const kb: InlineKeyboardButton[][] = [];
  list.forEach((p, i) => {
    const status = L.pres.statusName[p.status] ?? p.status;
    lines.push(`${i + 1}. ${p.topic} — ${p.slideCount} · ${status}${p.status === "generating" && p.stage ? ` (${L.pres.stages[p.stage] ?? p.stage})` : ""}`);
    if (p.status === "ready" && p.telegramFileId) kb.push([{ text: `${L.btn.openPres} ${i + 1}`, callback_data: `pf:${p.id}` }]);
    if (p.status === "failed") kb.push([{ text: `${L.btn.retry} ${i + 1}`, callback_data: `pr:${p.id}` }]);
  });
  if (!list.length) lines.push(L.empty);
  return { text: lines.join("\n"), keyboard: kb.length ? { inline_keyboard: kb } : undefined };
}

/** Vazifa yoki qayd kartochkasi — tugmalar bilan. */
export async function itemCard(deps: Deps, user: User, type: "t" | "n", id: string): Promise<View | null> {
  const L = t(user.language);
  if (type === "t") {
    const tk = await deps.db.task.findFirst({
      where: { id, userId: user.id },
      include: { reminders: { where: { status: { in: ["scheduled", "sending"] } }, orderBy: { fireAt: "asc" } } },
    });
    if (!tk) return null;
    const lines = [`${catLabel(user, tk.category)}: ${tk.title}`];
    if (tk.description) lines.push(tk.description);
    if (tk.eventAt) lines.push(L.eventLine(fmt(user, tk.eventAt)));
    if (tk.dueAt) lines.push(L.dueLine(fmt(user, tk.dueAt, tk.dueAllDay)));
    for (const r of tk.reminders) lines.push(r.recurrence ? L.repeatLine(describeRecurrence(r.recurrence as unknown as Recurrence, user.language)) : L.reminderLine(fmt(user, r.fireAt)));
    if (tk.status !== "active") {
      lines.push(`— ${L.statusWord[tk.status]}`);
      return { text: lines.join("\n") };
    }
    return { text: lines.join("\n"), keyboard: taskKeyboard(user, tk.id) };
  }
  const note = await deps.db.note.findFirst({
    where: { id, userId: user.id },
    include: { reminders: { where: { status: { in: ["scheduled", "sending"] } }, orderBy: { fireAt: "asc" } } },
  });
  if (!note) return null;
  const lines = [L.noteLine(note.title)];
  if (note.body) lines.push(note.body);
  if (note.eventAt) lines.push(L.eventLine(fmt(user, note.eventAt)));
  for (const r of note.reminders) lines.push(L.reminderLine(fmt(user, r.fireAt)));
  if (note.status !== "active") return { text: [...lines, `— ${L.statusWord.cancelled}`].join("\n") };
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: [[{ text: L.btn.changeTime, callback_data: `ct:n:${note.id}` }, { text: L.btn.cancel, callback_data: `cx:n:${note.id}` }]] },
  };
}

export function taskKeyboard(user: User, taskId: string): InlineKeyboardMarkup {
  const L = t(user.language);
  return {
    inline_keyboard: [
      [{ text: L.btn.done, callback_data: `td:${taskId}` }],
      [
        { text: L.btn.changeTime, callback_data: `ct:t:${taskId}` },
        { text: L.btn.cancel, callback_data: `cx:t:${taskId}` },
      ],
    ],
  };
}
