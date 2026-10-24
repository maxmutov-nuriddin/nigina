import type { Deps } from "../deps.ts";
import type { Prisma, User } from "../db.ts";
import type { ListFilter } from "../ai/schemas.ts";
import { t } from "../lib/i18n.ts";
import { consumeQuota } from "../lib/usage.ts";
import { logger, safeError } from "../logger.ts";
import { activeRemindersFor, cancelRemindersFor, createReminder, deadlineReminders, rescheduleReminder } from "../reminders/service.ts";
import type { ItemRef } from "./context.ts";
import { fmt, itemBlock } from "./format.ts";
import { categoryLabel, money } from "../finance/analytics.ts";
import { parseLocal, toLocalIso } from "../lib/time.ts";

const toLocalDay = (d: Date, tz: string) => toLocalIso(d, tz).slice(0, 10);
import type { Planned } from "./plan.ts";

type Tx = Prisma.TransactionClient;

export class DuplicateMessageError extends Error {
  constructor() {
    super("Xabar allaqachon qayta ishlangan");
  }
}

export interface ExecMeta {
  inboundMessageId: string | null;
  messageId: number | null;
  /** Shu xabarda alohida eslatma so'ralgan (hali aniqlashtirilayotgan bo'lsa ham) amallar indekslari — ularga avtomatik muddat eslatmasi qo'yilmaydi */
  explicitReminderFor?: number[];
}

export interface ExecOutcome {
  created: Map<number, ItemRef>;
  /** "Saqlandi" bloki (yaratilgan yozuvlar) */
  blocks: string[][];
  /** O'zgartirishlar (bajarildi, ko'chirildi, bekor qilindi) */
  changes: string[];
  queries: Array<{ intent: "list_items" | "search_notes" | "finance_report"; filter: ListFilter | null; period?: string | null }>;
  /** Moliyaviy yozuvlar o'zgardi — javobga qisqa oylik holat qo'shiladi */
  financeChanged: boolean;
  presentations: string[];
  failures: string[];
  touched: ItemRef[];
  offerPresentationForTask: string | null;
  /** Bitta vazifa yaratilgan bo'lsa — ostiga tugmalar qo'yish uchun */
  singleTaskId: string | null;
}

export async function executeActions(deps: Deps, user: User, actions: Planned[], meta: ExecMeta): Promise<ExecOutcome> {
  const L = t(user.language);
  const now = deps.clock();
  const out: ExecOutcome = {
    created: new Map(),
    blocks: [],
    changes: [],
    queries: [],
    presentations: [],
    failures: [],
    touched: [],
    offerPresentationForTask: null,
    singleTaskId: null,
    financeChanged: false,
  };

  // Tranzaksiyadan oldingi cheklovlar (limitlar) — rad etilgan amal boshqalarini to'xtatmaydi, lekin yashirilmaydi
  const accepted: Planned[] = [];
  for (const p of actions) {
    if (p.ai.intent === "create_presentation") {
      const active = await deps.db.presentation.count({ where: { userId: user.id, status: { in: ["queued", "generating"] } } });
      if (active >= deps.cfg.MAX_ACTIVE_PRESENTATIONS_PER_USER) {
        out.failures.push(`📎 ${p.ai.presentation_topic}: ${L.presActiveLimit}`);
        continue;
      }
      if (!(await consumeQuota(deps.db, user.id, "presentation", deps.cfg.DAILY_PRESENTATION_LIMIT, now))) {
        out.failures.push(`📎 ${p.ai.presentation_topic}: ${L.dailyLimit}`);
        continue;
      }
    }
    accepted.push(p);
  }
  const acceptedIdx = new Set(accepted.map((p) => p.index));
  // Muddatli, lekin eslatmasi so'ralmagan vazifalar — tranzaksiya oxirida avtomatik muddat eslatmalari qo'yiladi
  const deadlineTasks: Array<{ p: Planned; taskId: string; title: string; due: { date: Date; allDay: boolean } }> = [];
  const explicitReminder = new Set(meta.explicitReminderFor ?? []);

  const blockOf = new Map<number, string[]>();
  const rootOf = (p: Planned): number => {
    let cur = p;
    const seen = new Set<number>();
    while (cur.linkTo !== null && acceptedIdx.has(cur.linkTo) && !seen.has(cur.index)) {
      seen.add(cur.index);
      const next = accepted.find((x) => x.index === cur.linkTo);
      if (!next) break;
      cur = next;
    }
    return cur.index;
  };
  const addLines = (p: Planned, lines: string[]) => {
    const root = rootOf(p);
    const block = blockOf.get(root);
    if (block) block.push(...lines);
    else {
      const b = [...lines];
      blockOf.set(root, b);
      out.blocks.push(b);
    }
  };

  await deps.db.$transaction(async (tx) => {
    if (meta.inboundMessageId) {
      // Atomar idempotentlik: bitta kiruvchi xabar faqat bir marta "bajariladi"
      const r = await tx.inboundMessage.updateMany({ where: { id: meta.inboundMessageId, processedAt: null }, data: { processedAt: now } });
      if (r.count === 0) throw new DuplicateMessageError();
    }

    for (const p of accepted) {
      const a = p.ai;
      const r = p.resolved;
      const title = (a.title?.trim() || a.description?.trim().slice(0, 60) || a.person_name?.trim() || "—").slice(0, 200);
      const category = a.category ?? "other";
      const common = { userId: user.id, inboundMessageId: meta.inboundMessageId, sourceMessageId: meta.messageId, actionIndex: meta.inboundMessageId ? p.index : null };

      switch (a.intent) {
        case "create_task": {
          const task = await tx.task.create({
            data: {
              ...common,
              category,
              title,
              description: a.description,
              personName: a.person_name,
              dueAt: r.due?.date ?? null,
              dueAllDay: r.due?.allDay ?? false,
              eventAt: r.event,
            },
          });
          if (r.remind) {
            await createReminder(tx, { userId: user.id, taskId: task.id, text: a.reminder_text || title, fireAt: r.remind, anchor: r.remindAnchor, offsetMinutes: r.remindOffset, recurrence: r.recurrence });
          }
          out.created.set(p.index, { type: "task", id: task.id });
          out.touched.push({ type: "task", id: task.id });
          if (r.due && !r.remind) deadlineTasks.push({ p, taskId: task.id, title, due: r.due });
          if (a.mentions_presentation) out.offerPresentationForTask = task.id;
          addLines(p, itemBlock(user, { category, title, event: r.event, due: r.due, remind: r.remind, recurrence: r.recurrence }));
          break;
        }
        case "create_note": {
          const kind = a.note_kind ?? "general";
          const note = await tx.note.create({
            data: { ...common, category, kind, title, body: a.description, personName: a.person_name, eventAt: r.event },
          });
          if (r.remind) {
            await createReminder(tx, { userId: user.id, noteId: note.id, text: a.reminder_text || title, fireAt: r.remind, anchor: r.remindAnchor, offsetMinutes: r.remindOffset, recurrence: r.recurrence });
          }
          out.created.set(p.index, { type: "note", id: note.id });
          out.touched.push({ type: "note", id: note.id });
          const lines = [L.noteLine(title)];
          if (r.event) lines.push(L.eventLine(fmt(user, r.event)));
          if (r.remind) lines.push(L.reminderLine(fmt(user, r.remind)));
          addLines(p, lines);
          break;
        }
        case "create_presentation": {
          let parent = p.linkTo !== null ? out.created.get(p.linkTo) : r.target;
          const parentGiven = !!parent;
          const slideCount = Math.min(Math.max(a.slide_count ?? 10, 3), deps.cfg.MAX_SLIDES);
          const language = a.presentation_language ?? user.language;
          const topic = (a.presentation_topic ?? title).trim().slice(0, 200);
          // "29-gacha prezentatsiya tayyorla" — muddat yo'qolmasligi uchun prezentatsiya muddatli vazifaga bog'lanadi
          let autoTaskLines: string[] = [];
          if (!parent && r.due) {
            const taskTitle = L.presTaskTitle(topic).slice(0, 200);
            const task = await tx.task.create({ data: { ...common, actionIndex: null, category, title: taskTitle, description: a.description, dueAt: r.due.date, dueAllDay: r.due.allDay } });
            parent = { type: "task", id: task.id };
            out.touched.push(parent);
            if (!r.remind) deadlineTasks.push({ p, taskId: task.id, title: taskTitle, due: r.due });
            autoTaskLines = itemBlock(user, { category, title: taskTitle, due: r.due });
          }
          // Bog'langan vazifada muddat yo'q bo'lsa — prezentatsiyada aytilgan muddat unga yoziladi
          else if (parent?.type === "task" && r.due) {
            const task = await tx.task.findFirst({ where: { id: parent.id, userId: user.id, dueAt: null } });
            if (task) {
              await tx.task.update({ where: { id: task.id }, data: { dueAt: r.due.date, dueAllDay: r.due.allDay } });
              const hasReminder = await tx.reminder.count({ where: { userId: user.id, taskId: task.id, status: { in: ["scheduled", "sending"] } } });
              if (!r.remind && !hasReminder && !deadlineTasks.some((d) => d.taskId === task.id)) deadlineTasks.push({ p, taskId: task.id, title: task.title, due: r.due });
              autoTaskLines = [L.dueLine(fmt(user, r.due.date, r.due.allDay))];
            }
          }
          const pres = await tx.presentation.create({
            data: {
              userId: user.id,
              taskId: parent?.type === "task" ? parent.id : null,
              topic,
              language,
              slideCount,
              requirements: a.presentation_requirements,
              inboundMessageId: meta.inboundMessageId,
              statusChatId: user.chatId,
            },
          });
          out.created.set(p.index, { type: "presentation", id: pres.id });
          out.touched.push({ type: "presentation", id: pres.id });
          out.presentations.push(pres.id);
          const lines = [L.presLine(slideCount, language), L.presQueued];
          if (autoTaskLines.length && !parentGiven) lines.unshift(...autoTaskLines);
          else if (p.linkTo === null) lines.unshift(`${L.cat[category]}: ${topic}`);
          else lines[0] += ` — «${topic}»`;
          if (autoTaskLines.length && parentGiven) lines.push(...autoTaskLines);
          addLines(p, lines);
          break;
        }
        case "create_reminder": {
          const parent = p.linkTo !== null ? out.created.get(p.linkTo) : r.target;
          const remind = r.remind!;
          if (parent) {
            const link = await reminderLink(tx, user.id, parent);
            await createReminder(tx, { userId: user.id, ...link.ids, text: a.reminder_text || link.title, fireAt: remind, anchor: r.remindAnchor, offsetMinutes: r.remindOffset, recurrence: r.recurrence });
            out.touched.push(parent);
            const line = r.recurrence ? L.repeatLine(`${link.title}`) : L.reminderLine(fmt(user, remind));
            if (p.linkTo !== null) addLines(p, [line]);
            else addLines(p, [`${line} — ${link.title}`]);
          } else {
            const task = await tx.task.create({ data: { ...common, category, title, description: a.description, personName: a.person_name, eventAt: r.event } });
            await createReminder(tx, { userId: user.id, taskId: task.id, text: a.reminder_text || title, fireAt: remind, anchor: r.remindAnchor, offsetMinutes: r.remindOffset, recurrence: r.recurrence });
            out.created.set(p.index, { type: "task", id: task.id });
            out.touched.push({ type: "task", id: task.id });
            addLines(p, itemBlock(user, { category, title, event: r.event, remind, recurrence: r.recurrence }));
          }
          break;
        }
        case "complete_task": {
          const target = r.target!;
          if (target.type === "transaction" || target.type === "presentation") break;
          if (target.type === "task") {
            const task = await tx.task.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
            if (task.status === "active") {
              await tx.task.update({ where: { id: task.id }, data: { status: "done", completedAt: now } });
              await cancelRemindersFor(tx, user.id, { taskId: task.id });
            }
            out.changes.push(L.completed(task.title));
          } else if (target.type === "note") {
            const note = await tx.note.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
            await tx.note.update({ where: { id: note.id }, data: { status: "cancelled", statusReason: a.description } });
            await cancelRemindersFor(tx, user.id, { noteId: note.id });
            out.changes.push(L.completed(note.title));
          }
          out.touched.push(target);
          break;
        }
        case "cancel_reminder": {
          const target = r.target!;
          out.touched.push(target);
          if (target.type === "transaction") break;
          if (target.type === "presentation") {
            const n = await tx.reminder.updateMany({ where: { userId: user.id, presentationId: target.id, status: { in: ["scheduled", "sending"] } }, data: { status: "cancelled", version: { increment: 1 } } });
            const pres = await tx.presentation.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
            out.changes.push(n.count ? L.reminderCancelled(pres.topic) : L.noReminders(pres.topic));
            break;
          }
          const where = target.type === "task" ? { taskId: target.id } : { noteId: target.id };
          const n = await cancelRemindersFor(tx, user.id, where);
          if (target.type === "note") {
            const note = await tx.note.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
            out.changes.push(n ? L.reminderCancelled(note.title) : L.noReminders(note.title));
            // "Aziz kelarkan" — kelmaslik haqidagi qayd endi dolzarb emas
            if (note.kind === "absence" || a.description) {
              await tx.note.update({ where: { id: note.id }, data: { status: "cancelled", statusReason: a.description?.slice(0, 300) ?? null } });
              out.changes.push(L.noteClosed(note.title, a.description));
            }
          } else {
            const task = await tx.task.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
            out.changes.push(n ? L.reminderCancelled(task.title) : L.noReminders(task.title));
          }
          break;
        }
        case "update_item": {
          const target = r.target!;
          out.touched.push(target);
          if (target.type === "transaction") {
            out.changes.push(await updateTransaction(tx, user, p, target.id));
            out.financeChanged = true;
          } else out.changes.push(await updateItem(tx, user, p, target, now));
          break;
        }
        case "record_transaction": {
          const income = a.transaction_kind === "income";
          const currency = a.currency && /^[A-Z]{3}$/.test(a.currency) ? a.currency : user.currency;
          const when = parseLocal(a.occurred_at, r.tz);
          // Faqat kun aytilgan bo'lsa ("kecha") — shu kunning hozirgi soati emas, kun o'rtasi
          const occurredAt = when ? (when.allDay ? new Date(when.date.getTime() + 12 * 3600_000) : when.date) : now;
          const category = a.finance_category ?? (income ? "salary" : "other");
          const description = (a.description?.trim() || a.title?.trim() || null)?.slice(0, 200) ?? null;
          const x = await tx.transaction.create({
            data: {
              userId: user.id,
              kind: income ? "income" : "expense",
              amount: a.amount!,
              currency,
              category,
              description,
              occurredAt,
              inboundMessageId: meta.inboundMessageId,
              actionIndex: meta.inboundMessageId ? p.index : null,
            },
          });
          out.created.set(p.index, { type: "transaction", id: x.id });
          out.touched.push({ type: "transaction", id: x.id });
          out.financeChanged = true;
          const line = L.fin.txLine(income, money(a.amount!, currency, user.language), categoryLabel(category, user.language), description);
          const otherDay = when && toLocalDay(occurredAt, user.timezone) !== toLocalDay(now, user.timezone);
          addLines(p, [otherDay ? `${line} · ${fmt(user, occurredAt, when!.allDay)}` : line]);
          break;
        }
        case "finance_report":
          out.queries.push({ intent: "finance_report", filter: null, period: a.finance_period });
          break;
        case "list_items":
        case "search_notes":
          out.queries.push({ intent: a.intent, filter: a.list_filter });
          break;
        case "clarify":
          break;
      }
    }

    for (const d of deadlineTasks) {
      if (explicitReminder.has(d.p.index)) continue;
      const plan = deadlineReminders(d.due, now, user.timezone, user.defaultReminderTime);
      for (const x of plan) {
        const text = x.kind === "before" ? L.deadlineBefore(d.title) : L.deadlineToday(d.title);
        await createReminder(tx, { userId: user.id, taskId: d.taskId, text, fireAt: x.fireAt, anchor: "due", offsetMinutes: x.offsetMinutes });
      }
      if (plan.length) addLines(d.p, [L.deadlineRemindersLine(plan.map((x) => fmt(user, x.fireAt)))]);
    }
  });

  const createdTasks = [...out.created.values()].filter((c) => c.type === "task");
  if (out.created.size === 1 && createdTasks.length === 1) out.singleTaskId = createdTasks[0].id;

  // Tranzaksiyadan keyin: navbatga qo'yish. Xato bo'lsa sweeper qayta qo'yadi (status=queued qoladi).
  for (const id of out.presentations) {
    await deps.enqueuePresentation(id).catch((err) => logger.error({ err: safeError(err), presentationId: id }, "Navbatga qo'yib bo'lmadi — sweeper qayta urinadi"));
  }
  return out;
}

async function updateTransaction(tx: Tx, user: User, p: Planned, id: string): Promise<string> {
  const L = t(user.language);
  const a = p.ai;
  const x = await tx.transaction.findFirstOrThrow({ where: { id, userId: user.id } });
  const line = (v: { kind: string; amount: number; currency: string; category: string; description: string | null }) =>
    L.fin.txLine(v.kind === "income", money(v.amount, v.currency, user.language), categoryLabel(v.category, user.language), v.description);
  if (a.update_op === "cancel") {
    await tx.transaction.delete({ where: { id: x.id } });
    return L.fin.deleted(line({ ...x, amount: x.amount.toNumber() }));
  }
  const when = parseLocal(a.occurred_at, p.resolved.tz);
  const data = {
    amount: a.amount && a.amount > 0 ? a.amount : x.amount.toNumber(),
    category: a.finance_category ?? x.category,
    description: a.description?.trim() || x.description,
    kind: a.transaction_kind ?? x.kind,
    currency: a.currency && /^[A-Z]{3}$/.test(a.currency) ? a.currency : x.currency,
    ...(when ? { occurredAt: when.allDay ? new Date(when.date.getTime() + 12 * 3600_000) : when.date } : {}),
  };
  await tx.transaction.update({ where: { id: x.id }, data });
  return L.fin.updated(line(data));
}

async function reminderLink(tx: Tx, userId: string, parent: ItemRef) {
  if (parent.type === "task") {
    const task = await tx.task.findFirstOrThrow({ where: { id: parent.id, userId } });
    return { ids: { taskId: task.id }, title: task.title };
  }
  if (parent.type === "note") {
    const note = await tx.note.findFirstOrThrow({ where: { id: parent.id, userId } });
    return { ids: { noteId: note.id }, title: note.title };
  }
  const pres = await tx.presentation.findFirstOrThrow({ where: { id: parent.id, userId } });
  return { ids: { presentationId: pres.id, taskId: pres.taskId }, title: pres.topic };
}

async function updateItem(tx: Tx, user: User, p: Planned, target: ItemRef, now: Date): Promise<string> {
  if (target.type === "transaction") throw new Error("transaction updateTransaction orqali");
  const L = t(user.language);
  const a = p.ai;
  const r = p.resolved;
  if (target.type === "presentation") {
    const pres = await tx.presentation.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
    return L.edited(pres.topic);
  }
  const isTask = target.type === "task";
  const item = isTask
    ? await tx.task.findFirstOrThrow({ where: { id: target.id, userId: user.id } })
    : await tx.note.findFirstOrThrow({ where: { id: target.id, userId: user.id } });
  const where = isTask ? { taskId: item.id } : { noteId: item.id };

  if (a.update_op === "cancel") {
    if (isTask) await tx.task.update({ where: { id: item.id }, data: { status: "cancelled" } });
    else await tx.note.update({ where: { id: item.id }, data: { status: "cancelled", statusReason: a.description } });
    await cancelRemindersFor(tx, user.id, where);
    return L.itemCancelled(item.title);
  }

  // Vaqt berilmagan o'zgartirish — matnni tahrirlash
  if (a.update_op !== "reschedule" && !r.event && !r.remind && !r.due) {
    const data = { title: a.title?.trim() || item.title, ...(a.description ? (isTask ? { description: a.description } : { body: a.description }) : {}) };
    if (isTask) await tx.task.update({ where: { id: item.id }, data });
    else await tx.note.update({ where: { id: item.id }, data });
    return L.edited(data.title);
  }

  // Vaqtni o'zgartirish
  const allReminders = await activeRemindersFor(tx, user.id, where);
  // Avtomatik muddat eslatmalari faqat muddat bilan birga ko'chadi
  const reminders = allReminders.filter((x) => x.anchor !== "due");
  const dueReminders = allReminders.filter((x) => x.anchor === "due");
  const oldEvent = item.eventAt;
  const oldDue = isTask ? (item as { dueAt: Date | null }).dueAt : null;
  const oldPrimary = oldEvent ?? reminders[0]?.fireAt ?? oldDue;

  const data: Record<string, unknown> = {};
  if (r.event) data.eventAt = r.event;
  if (r.due && isTask) {
    data.dueAt = r.due.date;
    data.dueAllDay = r.due.allDay;
  }
  if (Object.keys(data).length) {
    if (isTask) await tx.task.update({ where: { id: item.id }, data });
    else await tx.note.update({ where: { id: item.id }, data });
  }

  const retime = (rem: (typeof reminders)[number], fireAt: Date) => rescheduleReminder(tx, rem.id, user.id, fireAt);

  if (r.remind) {
    if (reminders.length) await retime(reminders[0], r.remind);
    else await createReminder(tx, { userId: user.id, ...where, text: item.title, fireAt: r.remind, anchor: r.remindAnchor, offsetMinutes: r.remindOffset });
  } else if (r.event) {
    if (reminders.length) {
      for (const rem of reminders) {
        const fireAt =
          rem.anchor === "event" && rem.offsetMinutes !== null
            ? new Date(r.event.getTime() - rem.offsetMinutes * 60_000)
            : oldEvent
              ? new Date(rem.fireAt.getTime() + (r.event.getTime() - oldEvent.getTime()))
              : r.event;
        await retime(rem, fireAt);
      }
    } else {
      // Avval eslatma bo'lgan (yuborilgan) bo'lsa — yangi vaqtga yana eslatamiz
      const last = await tx.reminder.findFirst({ where: { userId: user.id, ...where }, orderBy: { fireAt: "desc" } });
      if (last) {
        const offset = oldEvent ? oldEvent.getTime() - last.fireAt.getTime() : 0;
        await createReminder(tx, { userId: user.id, ...where, text: last.text, fireAt: new Date(r.event.getTime() - Math.max(0, offset)) });
      }
    }
  }

  // Yangi muddat — avtomatik eslatmalar qayta hisoblanadi (o'zi eslatma qo'ygan vazifalarga qo'shilmaydi)
  let deadlineLine: string | null = null;
  if (r.due && isTask && !r.remind && (dueReminders.length > 0 || allReminders.length === 0)) {
    if (dueReminders.length) {
      await tx.reminder.updateMany({ where: { id: { in: dueReminders.map((x) => x.id) }, userId: user.id }, data: { status: "cancelled", version: { increment: 1 }, lockedUntil: null, lockedBy: null } });
    }
    const plan = deadlineReminders(r.due, now, user.timezone, user.defaultReminderTime);
    for (const x of plan) {
      const text = x.kind === "before" ? L.deadlineBefore(item.title) : L.deadlineToday(item.title);
      await createReminder(tx, { userId: user.id, taskId: item.id, text, fireAt: x.fireAt, anchor: "due", offsetMinutes: x.offsetMinutes });
    }
    if (plan.length) deadlineLine = L.deadlineRemindersLine(plan.map((x) => fmt(user, x.fireAt)));
  }

  const newPrimary = r.event ?? r.remind ?? r.due?.date ?? null;
  const oldDueAllDay = isTask && oldPrimary !== null && oldPrimary === oldDue && (item as { dueAllDay: boolean }).dueAllDay;
  const from = oldPrimary ? fmt(user, oldPrimary, oldDueAllDay) : "—";
  const to = newPrimary ? fmt(user, newPrimary, !r.event && !r.remind && !!r.due?.allDay) : "—";
  const msg = L.rescheduled(item.title, from, to);
  return deadlineLine ? `${msg}\n${deadlineLine}` : msg;
}
