import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import type { AiAction } from "../ai/schemas.ts";
import { t } from "../lib/i18n.ts";
import { formatDateTime, isValidTimezone, nextOccurrence, parseLocal, toLocal, toLocalIso, type Recurrence } from "../lib/time.ts";
import { stableRef, type ItemRef, type RefMap } from "./context.ts";

export interface Issue {
  field: string;
  text: string;
  options: Array<{ label: string; value: string }>;
  /** So'rab bo'lmaydigan xato (masalan, yozuv topilmadi) — foydalanuvchiga xabar qilinadi */
  terminal?: boolean;
}

export interface Resolved {
  tz: string;
  due: { date: Date; allDay: boolean } | null;
  event: Date | null;
  remind: Date | null;
  remindAnchor: "absolute" | "event";
  remindOffset: number | null;
  recurrence: Recurrence | null;
  target: ItemRef | null;
}

export interface Planned {
  index: number;
  ai: AiAction;
  resolved: Resolved;
  issue: Issue | null;
  linkTo: number | null;
}

export interface PlanResult {
  ready: Planned[];
  pending: Planned[];
  terminal: Planned[];
}

const TARGET_INTENTS = new Set(["update_item", "complete_task", "cancel_reminder"]);
const CREATE_INTENTS = new Set(["create_task", "create_note", "create_reminder"]);
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export async function planActions(deps: Deps, user: User, actions: AiAction[], refs: RefMap): Promise<PlanResult> {
  const planned: Planned[] = [];
  for (let i = 0; i < actions.length; i++) planned.push(await planOne(deps, user, actions[i], i, actions.length, refs));

  // Bog'langan amallar: ota-amal tayyor bo'lmasa, bola ham kutadi (izchil yaratish uchun)
  const readySet = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of planned) {
      if (readySet.has(p.index) || p.issue) continue;
      if (p.linkTo === null || readySet.has(p.linkTo)) {
        readySet.add(p.index);
        changed = true;
      }
    }
  }
  return {
    ready: planned.filter((p) => readySet.has(p.index)),
    pending: planned.filter((p) => !readySet.has(p.index) && !p.issue?.terminal && !(p.linkTo !== null && planned[p.linkTo]?.issue?.terminal)),
    terminal: planned.filter((p) => p.issue?.terminal),
  };
}

async function planOne(deps: Deps, user: User, rawAction: AiAction, index: number, total: number, refs: RefMap): Promise<Planned> {
  const L = t(user.language);
  const now = deps.clock();
  const tz = rawAction.timezone && isValidTimezone(rawAction.timezone) ? rawAction.timezone : user.timezone;
  // AI hisoblagan sanalarni foydalanuvchi aytgan hafta kuni / soat bilan solishtiramiz
  const checked = checkTimeHints(rawAction, tz, now, L);
  const a = checked.action;
  const linkTo = a.link_to_action !== null && a.link_to_action >= 0 && a.link_to_action < total && a.link_to_action !== index ? a.link_to_action : null;

  const resolved: Resolved = { tz, due: null, event: null, remind: null, remindAnchor: "absolute", remindOffset: null, recurrence: null, target: null };
  const done = (issue: Issue | null): Planned => ({ index, ai: a, resolved, issue, linkTo });

  // --- vaqtlar ---
  const due = parseLocal(a.due_at, tz);
  const ev = parseLocal(a.event_at, tz);
  resolved.due = due;
  if (ev) {
    if (ev.allDay) {
      if (!resolved.due) resolved.due = ev;
    } else resolved.event = ev.date;
  }
  if (a.recurrence && HHMM.test(a.recurrence.time)) {
    const [h, m] = a.recurrence.time.split(":").map(Number);
    resolved.recurrence = {
      freq: a.recurrence.freq,
      interval: Math.max(1, a.recurrence.interval || 1),
      byWeekday: (a.recurrence.by_weekday ?? []).filter((d) => d >= 1 && d <= 7),
      time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    };
  }

  const remindParsed = parseLocal(a.remind_at, tz);
  if (remindParsed && remindParsed.allDay) {
    // Kun aytildi, vaqt aytilmadi — standart vaqtni taklif qilamiz
    const day = toLocalIso(remindParsed.date, tz).slice(0, 10);
    return done({ field: "remind_at", text: L.whenRemind, options: [{ label: user.defaultReminderTime, value: `${day}T${user.defaultReminderTime}` }] });
  }
  if (remindParsed) resolved.remind = remindParsed.date;
  else if (a.remind_in_minutes !== null && a.remind_in_minutes > 0) resolved.remind = new Date(now.getTime() + a.remind_in_minutes * 60_000);
  else if (a.remind_before_event_minutes !== null && resolved.event) {
    resolved.remind = new Date(resolved.event.getTime() - a.remind_before_event_minutes * 60_000);
    resolved.remindAnchor = "event";
    resolved.remindOffset = a.remind_before_event_minutes;
  }
  if (resolved.recurrence && (!resolved.remind || resolved.remind < now)) {
    resolved.remind = nextOccurrence(resolved.recurrence, now, tz, resolved.remind ?? undefined);
  }

  if (checked.issue) return done(checked.issue);

  // --- intentga xos tekshiruvlar ---
  if (a.intent === "clarify") {
    return done({ field: "intent", text: a.clarification_question || L.whenRemind, options: cleanOptions(a.clarification_options, tz) });
  }

  if (a.intent === "record_transaction" && !(a.amount !== null && a.amount > 0 && a.amount < 1e13)) {
    return done({ field: "amount", text: a.clarification_question || L.fin.amountQ, options: [] });
  }

  if (a.intent === "create_presentation" && !a.presentation_topic?.trim()) {
    return done({ field: "presentation_topic", text: a.clarification_question || L.presTopicQ, options: [] });
  }

  // Joylashuvga bog'liq eslatma — vaqtga yashirincha aylantirmaymiz (backend savoli tugmalar bilan)
  if (a.location_trigger && !resolved.remind && CREATE_INTENTS.has(a.intent)) {
    return done({ field: "remind_at", text: L.locationQ(a.location_trigger), options: suggestEveningOptions(now, tz) });
  }

  // AI o'zi aniqlashtirish so'ragan maydonlar (masalan, AM/PM noaniqligi)
  const aiMissing = a.missing_fields.filter((f) => f && f !== "related_item_id" && !(f === "amount" && a.amount));
  if (aiMissing.length) {
    const options = cleanOptions(a.clarification_options, tz);
    const timeQuestion = /remind|event|due|time|hour|ampm/i.test(aiMissing[0]) && options.length > 0 && options.every((o) => /^\d{4}-\d{2}-\d{2}T/.test(o.value));
    // Vaqt varianti bo'lgan savolda AI matni aralash yozuvda bo'lsa, o'zimizning toza matn bilan beramiz
    const aiQuestion = a.clarification_question?.trim() || null;
    const text = timeQuestion && (!aiQuestion || isMixedScript(aiQuestion)) ? L.whatHour(itemSubject(a)) : aiQuestion || defaultQuestion(aiMissing[0], L);
    return done({ field: aiMissing[0], text, options });
  }

  // Mavjud yozuvga ishora qiluvchi amallar — egalik backend'da tekshiriladi
  const optionalTarget = (a.intent === "create_reminder" || a.intent === "create_presentation") && linkTo === null && (!!a.related_item_id || a.candidate_item_ids.length > 0);
  const needsTarget = TARGET_INTENTS.has(a.intent) || optionalTarget;
  if (needsTarget) {
    const cands = await findTargets(deps, user, a, refs);
    if (a.intent === "complete_task") {
      const tasks = cands.filter((c) => c.type === "task");
      if (tasks.length) cands.splice(0, cands.length, ...tasks);
    }
    if (cands.length === 0) {
      if (optionalTarget) {
        // ishora topilmadi — mustaqil yozuv sifatida yaratiladi
      } else return done({ field: "related_item_id", text: L.notFound, options: [], terminal: true });
    } else if (cands.length > 1) {
      const options = await Promise.all(cands.slice(0, 6).map(async (c) => ({ label: await describeItem(deps, user, c), value: stableRef(c) })));
      return done({ field: "related_item_id", text: L.chooseItem, options });
    } else resolved.target = cands[0];
  }

  if (a.intent === "update_item" && (a.update_op === "reschedule" || (!a.update_op && (resolved.event || resolved.remind || resolved.due)))) {
    if (!resolved.event && !resolved.remind && !resolved.due) return done({ field: "event_at", text: L.newTimeQ, options: [] });
  }

  if (a.intent === "create_reminder" && !resolved.remind) {
    return done({ field: "remind_at", text: L.whenRemind, options: [] });
  }

  // O'tib ketgan vaqtga eslatma
  if (resolved.remind && !resolved.recurrence && resolved.remind.getTime() < now.getTime() - 60_000 && (CREATE_INTENTS.has(a.intent) || a.intent === "update_item")) {
    const in10 = new Date(now.getTime() + 10 * 60_000);
    const tomorrowSame = toLocal(resolved.remind, tz).plus({ days: 1 });
    const options = [{ label: L.in10, value: toLocalIso(in10, tz) }];
    if (tomorrowSame.toJSDate() > now) options.push({ label: `${L.tomorrowSame} (${tomorrowSame.toFormat("HH:mm")})`, value: tomorrowSame.toFormat("yyyy-LL-dd'T'HH:mm") });
    return done({ field: "remind_at", text: L.pastTime(formatDateTime(resolved.remind, tz, user.language)), options });
  }

  return done(null);
}

const TIME_FIELDS = ["event_at", "due_at", "remind_at"] as const;
/** Ertalab ham, kechqurun ham bo'lishi mumkin bo'lgan soatlar (3 → 15:00, 10 → 10:00 kabi aniqlari so'ralmaydi) */
const AMBIGUOUS_HOURS = new Set([6, 7, 8]);

/**
 * Deterministik himoya: AI sanani hafta kuniga noto'g'ri bog'lasa — eng yaqin to'g'ri kunga tuzatiladi;
 * soat foydalanuvchi aytgan raqamga mos kelmasa (12 soatlik farqdan tashqari) — so'raladi.
 */
export function checkTimeHints(a: AiAction, tz: string, now: Date, L: ReturnType<typeof t>): { action: AiAction; issue: Issue | null } {
  const next: AiAction = { ...a };
  let issue: Issue | null = null;
  const today = toLocal(now, tz).startOf("day");
  for (const hint of a.time_hints ?? []) {
    if (!TIME_FIELDS.includes(hint.field)) continue;
    const raw = next[hint.field];
    const parsed = parseLocal(raw, tz);
    if (!raw || !parsed) continue;
    let local = toLocal(parsed.date, tz);
    // Hafta kuni nomi bilan aytilgan sana o'tmishda yoki boshqa kunda bo'lmasligi kerak ("juma" — eng yaqin kelasi juma)
    if (hint.weekday && hint.weekday >= 1 && hint.weekday <= 7 && (local.weekday !== hint.weekday || local.startOf("day") < today)) {
      let d = today;
      while (d.weekday !== hint.weekday) d = d.plus({ days: 1 });
      local = d.set({ hour: local.hour, minute: local.minute });
      next[hint.field] = parsed.allDay ? local.toFormat("yyyy-LL-dd") : local.toFormat("yyyy-LL-dd'T'HH:mm");
    }
    const sh = hint.spoken_hour;
    // "darsga soat uchda" — kun qismi aytilmagan 1–5 soat amalda kunduzi (13–17): tungi 03:00 emas
    if (sh !== null && sh >= 1 && sh <= 5 && !hint.day_part_said && !parsed.allDay && local.hour === sh) {
      local = local.plus({ hours: 12 });
      next[hint.field] = local.toFormat("yyyy-LL-dd'T'HH:mm");
    }
    // "soat sakkiz" — ertalab ham, kechqurun ham real: kun qismi aytilmagan bo'lsa taxmin qilmaymiz
    const ambiguousHalfDay = sh !== null && AMBIGUOUS_HOURS.has(sh) && !hint.day_part_said;
    if (!issue && !parsed.allDay && sh !== null && sh >= 0 && sh <= 24 && (local.hour % 12 !== sh % 12 || ambiguousHalfDay)) {
      const day = local.toFormat("yyyy-LL-dd");
      const hours = sh < 12 && sh > 0 ? [sh, sh + 12] : [sh % 24];
      issue = {
        field: hint.field,
        text: L.whatHour(itemSubject(a)),
        options: hours.map((h) => ({ label: `${String(h).padStart(2, "0")}:${local.toFormat("mm")}`, value: `${day}T${String(h).padStart(2, "0")}:${local.toFormat("mm")}` })),
      };
    }
  }
  // Voqea vaqti 12 soatga surilgan bo'lsa, AI unga nisbatan hisoblagan absolyut eslatma ham suriladi
  if (next.event_at !== a.event_at && a.event_at && a.remind_at && !next.time_hints.some((h) => h.field === "remind_at")) {
    const oldEv = parseLocal(a.event_at, tz);
    const newEv = parseLocal(next.event_at, tz);
    const rem = parseLocal(a.remind_at, tz);
    if (oldEv && newEv && rem) next.remind_at = toLocal(new Date(rem.date.getTime() + (newEv.date.getTime() - oldEv.date.getTime())), tz).toFormat("yyyy-LL-dd'T'HH:mm");
  }
  return { action: next, issue };
}

/** Savoldagi yozuv nomi: birinchi bo'sh bo'lmagan maydon (bog'langan eslatmada title bo'sh bo'ladi). */
function itemSubject(a: AiAction): string {
  return [a.title, a.presentation_topic, a.description].map((v) => v?.trim()).find((v) => !!v)?.slice(0, 60) ?? "";
}

/** Bitta so'z ichida lotin va kirill harflari aralashgan ("ertalabмi") — STT/LLM xatosi belgisi. */
function isMixedScript(text: string): boolean {
  return text.split(/\s+/).some((w) => /[a-z]/i.test(w) && /[\u0400-\u04FF]/.test(w));
}

function defaultQuestion(field: string, L: ReturnType<typeof t>): string {
  if (field.startsWith("presentation")) return L.presTopicQ;
  return L.whenRemind;
}

function cleanOptions(opts: Array<{ label: string; value: string }>, tz: string) {
  return opts
    .filter((o) => o.label?.trim() && o.value?.trim())
    .filter((o) => !/^\d{4}-\d{2}-\d{2}/.test(o.value) || parseLocal(o.value, tz) !== null)
    .slice(0, 4)
    .map((o) => ({ label: o.label.slice(0, 40), value: o.value.slice(0, 200) }));
}

function suggestEveningOptions(now: Date, tz: string) {
  const local = toLocal(now, tz);
  const out: Array<{ label: string; value: string }> = [];
  for (const h of [18, 19, 20]) {
    let d = local.set({ hour: h, minute: 0, second: 0, millisecond: 0 });
    if (d <= local) d = d.plus({ days: 1 });
    out.push({ label: d.hasSame(local, "day") ? d.toFormat("HH:mm") : d.toFormat("dd.LL HH:mm"), value: d.toFormat("yyyy-LL-dd'T'HH:mm") });
  }
  return out;
}

async function findTargets(deps: Deps, user: User, a: AiAction, refs: RefMap): Promise<ItemRef[]> {
  const out: ItemRef[] = [];
  const push = (r: ItemRef | null) => {
    if (r && !out.some((o) => o.id === r.id)) out.push(r);
  };
  push(await refs.resolve(deps, user.id, a.related_item_id));
  if (out.length === 0) {
    for (const c of a.candidate_item_ids.slice(0, 10)) push(await refs.resolve(deps, user.id, c));
  }
  // AI aniq yozuv bermagan bo'lsa, ism bo'yicha faol yozuvlarni qidiramiz — noaniqlik bo'lsa so'raymiz
  if (out.length === 0 && a.person_name?.trim()) {
    const name = a.person_name.trim();
    const [notes, tasks] = await Promise.all([
      deps.db.note.findMany({ where: { userId: user.id, status: "active", personName: { equals: name, mode: "insensitive" } }, take: 6 }),
      deps.db.task.findMany({ where: { userId: user.id, status: "active", personName: { equals: name, mode: "insensitive" } }, take: 6 }),
    ]);
    notes.forEach((n) => push({ type: "note", id: n.id }));
    tasks.forEach((tk) => push({ type: "task", id: tk.id }));
  }
  return out;
}

export async function describeItem(deps: Deps, user: User, ref: ItemRef): Promise<string> {
  const tz = user.timezone;
  const lang = user.language;
  if (ref.type === "task") {
    const tk = await deps.db.task.findFirst({ where: { id: ref.id, userId: user.id } });
    if (!tk) return "?";
    const when = tk.eventAt ? formatDateTime(tk.eventAt, tz, lang) : tk.dueAt ? formatDateTime(tk.dueAt, tz, lang, { allDay: tk.dueAllDay }) : null;
    return `${tk.title}${when ? ` — ${when}` : ""}`.slice(0, 60);
  }
  if (ref.type === "note") {
    const n = await deps.db.note.findFirst({ where: { id: ref.id, userId: user.id } });
    if (!n) return "?";
    return `${n.title}${n.eventAt ? ` — ${formatDateTime(n.eventAt, tz, lang)}` : ""}`.slice(0, 60);
  }
  if (ref.type === "transaction") {
    const x = await deps.db.transaction.findFirst({ where: { id: ref.id, userId: user.id } });
    return x ? `${x.kind === "income" ? "💰" : "💸"} ${x.amount.toString()} ${x.currency} ${x.description ?? x.category} — ${formatDateTime(x.occurredAt, tz, lang)}`.slice(0, 60) : "?";
  }
  const p = await deps.db.presentation.findFirst({ where: { id: ref.id, userId: user.id } });
  return p ? `📎 ${p.topic}`.slice(0, 60) : "?";
}

/** "50 000", "1,5" kabi qiymatni songa aylantiradi (so'z bilan aytilgani AI orqali hal qilinadi). */
function parseAmount(v: string): number | null {
  const n = Number(v.replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Tugma orqali tanlangan javobni kutilayotgan amalga qo'llaydi. */
export function applyAnswer(a: AiAction, field: string, value: string): AiAction {
  const next: AiAction = {
    ...a,
    missing_fields: a.missing_fields.filter((f) => f !== field),
    clarification_question: null,
    clarification_options: [],
    // Foydalanuvchi aniq javob berdi — shu maydon uchun eski ishoralar endi kerak emas
    time_hints: (a.time_hints ?? []).filter((h) => h.field !== field),
  };
  const isDate = /^\d{4}-\d{2}-\d{2}/.test(value);
  const key = field in next ? field : isDate ? (a.intent === "update_item" && !a.remind_at ? "event_at" : "remind_at") : a.intent === "create_presentation" ? "presentation_topic" : "title";
  (next as Record<string, unknown>)[key] = key === "amount" ? parseAmount(value) : value;
  if (key === "remind_at") {
    next.remind_in_minutes = null;
    next.remind_before_event_minutes = null;
    next.location_trigger = null;
  }
  if (key === "related_item_id") next.candidate_item_ids = [];
  // "remind_at_ampm" kabi nostandart maydon nomlari ham tozalanadi
  next.missing_fields = next.missing_fields.filter((f) => !(isDate && /time|remind|ampm|hour/i.test(f)));
  return next;
}
