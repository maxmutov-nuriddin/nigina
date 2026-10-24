import type { InlineKeyboardMarkup } from "grammy/types";
import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import type { AiAction } from "../ai/schemas.ts";
import { AiError } from "../ai/provider.ts";
import { t } from "../lib/i18n.ts";
import { logger, safeError } from "../logger.ts";
import { buildContext, stableRef, type RefMap } from "./context.ts";
import { DuplicateMessageError, executeActions, type ExecMeta, type ExecOutcome } from "./executor.ts";
import { applyAnswer, planActions, type PlanResult } from "./plan.ts";
import { renderQuery, taskKeyboard } from "./queries.ts";
import { computeStats, formatBrief } from "../finance/analytics.ts";
import { loadState, remember, setPending, setRetry, type Pending } from "./state.ts";

export interface Reply {
  text: string;
  keyboard?: InlineKeyboardMarkup;
  /** true — amallar bazaga yozildi */
  saved: boolean;
  duplicate?: boolean;
}

export interface IncomingText {
  user: User;
  text: string;
  inboundMessageId: string | null;
  messageId: number | null;
  updateId: string;
  kind: string;
  /** Javob boshiga qo'shiladigan qatorlar (masalan, eshitilgan transkripsiya) */
  header?: string[];
}

const MAX_ASKS = 3;
/** Juda uzun javoblar (ko'p amalli katta so'rovlar) uchun yuqori chegara; Telegram'ga bo'laklab yuboriladi */
const MAX_TEXT = 12_000;

/** Foydalanuvchi matni (yoki transkripsiya) uchun to'liq oqim. AI xatolarini ham shu yerda javobga aylantiradi. */
export async function processText(deps: Deps, input: IncomingText): Promise<Reply> {
  const { user } = input;
  const L = t(user.language);
  try {
    const state = await loadState(deps, user.id);
    const prefix = [...(input.header ?? [])];
    if (state.pendingExpired) {
      await setPending(deps, user.id, null);
      prefix.push(L.pendingExpired);
    }
    const { ctx, refs } = await buildContext(deps, user, state);

    let actions: AiAction[] = [];
    let aiReply: string | null = null;
    let asked = 0;
    let prevKey: string | undefined;
    const pending = state.pendingExpired ? null : state.pending;
    if (pending?.kind === "clarify") {
      const res = await deps.nlu.resolve(pending.actions, pending.question.text, input.text, ctx);
      if (res.relates && res.actions.length) {
        actions = res.actions;
        // Javob berilgan maydon: AI yana noaniqlik qo'shgan bo'lsa ham, qiymat to'ldirilgan bo'lsa savol yopiladi
        const q = pending.question;
        const answered = actions[q.actionIndex];
        if (answered && (answered as Record<string, unknown>)[q.field]) {
          actions[q.actionIndex] = {
            ...answered,
            missing_fields: answered.missing_fields.filter((f) => f !== q.field && !/time|remind|ampm|hour/i.test(f)),
            clarification_question: null,
            clarification_options: [],
            time_hints: (answered.time_hints ?? []).filter((h) => h.field !== q.field),
          };
        }
        asked = pending.asked;
        prevKey = pending.key;
      } else {
        await setPending(deps, user.id, null);
        prefix.push(L.pendingDropped);
      }
    }
    if (!actions.length) {
      const ex = await deps.nlu.extract(input.text, ctx);
      actions = ex.actions;
      aiReply = ex.reply;
    }
    await setRetry(deps, user.id, null);
    return await runActions(deps, user, actions, refs, {
      meta: { inboundMessageId: input.inboundMessageId, messageId: input.messageId },
      prefix,
      aiReply,
      asked,
      prevKey,
      hadPending: pending?.kind === "clarify",
      userText: input.text,
    });
  } catch (err) {
    if (err instanceof DuplicateMessageError) return { text: L.duplicate, saved: false, duplicate: true };
    if (err instanceof AiError) {
      logger.warn({ code: err.code, userId: user.id }, "AI xatosi");
      if (err.code === "not_configured" || err.code === "auth") return { text: [...(input.header ?? []), L.aiNotConfigured].join("\n"), saved: false };
      await setRetry(deps, user.id, { text: input.text, updateId: input.updateId, messageId: input.messageId ?? 0, kind: input.kind });
      return { text: [...(input.header ?? []), err.code === "rate_limit" ? L.aiRateLimited(err.retryAfterSec) : L.aiUnavailable].join("\n"), keyboard: { inline_keyboard: [[{ text: L.btn.retry, callback_data: "rt" }]] }, saved: false };
    }
    logger.error({ err: safeError(err), userId: user.id }, "processText xatosi");
    return { text: L.dbFailed, saved: false };
  }
}

/** Aniqlashtirish savolidagi tugma bosilganda. */
export async function answerOption(deps: Deps, user: User, version: number, optionIndex: number): Promise<Reply | null> {
  const state = await loadState(deps, user.id);
  const pending = state.pending;
  if (!pending || pending.kind !== "clarify" || state.version !== version || state.pendingExpired) return null;
  const q = pending.question;
  const opt = q.options[optionIndex];
  if (!opt) return null;
  const actions = pending.actions.slice();
  actions[q.actionIndex] = applyAnswer(actions[q.actionIndex], q.field, opt.value);
  const { refs } = await buildContext(deps, user, state);
  try {
    return await runActions(deps, user, actions, refs, { meta: { inboundMessageId: null, messageId: null }, prefix: [], aiReply: null, asked: pending.asked, prevKey: pending.key, hadPending: true, userText: opt.label });
  } catch (err) {
    logger.error({ err: safeError(err), userId: user.id }, "answerOption xatosi");
    return { text: t(user.language).dbFailed, saved: false };
  }
}

/** Tashqaridan (tugmalar) tayyor amallarni aniqlashtirish oqimiga qo'yish — masalan, "Vaqtini o'zgartirish". */
export async function startClarification(deps: Deps, user: User, action: AiAction, question: string): Promise<number> {
  const field = action.missing_fields[0] ?? "event_at";
  const pending: Pending = { kind: "clarify", actions: [action], question: { actionIndex: 0, field, text: question, options: [] }, asked: 1, key: questionKey(action, field) };
  return setPending(deps, user.id, pending);
}

interface RunOpts {
  meta: ExecMeta;
  prefix: string[];
  aiReply: string | null;
  asked: number;
  prevKey?: string;
  hadPending: boolean;
  userText: string;
}

async function runActions(deps: Deps, user: User, actions: AiAction[], refs: RefMap, o: RunOpts): Promise<Reply> {
  const L = t(user.language);
  const plan = await planActions(deps, user, actions, refs);

  let outcome: ExecOutcome | null = null;
  // Alohida eslatma so'ralgan (hali aniqlashtirilayotgan bo'lsa ham) vazifalarga avtomatik muddat eslatmasi qo'yilmaydi
  const linkOf = new Map([...plan.ready, ...plan.pending].map((p) => [p.index, p.linkTo]));
  const explicitReminderFor: number[] = [];
  for (const p of [...plan.ready, ...plan.pending]) {
    if (p.ai.intent !== "create_reminder") continue;
    // eslatma → prezentatsiya → vazifa: zanjirdagi har bir yozuv "eslatmasi bor" hisoblanadi
    for (let i = p.linkTo; i !== null && i !== undefined && !explicitReminderFor.includes(i); i = linkOf.get(i) ?? null) explicitReminderFor.push(i);
  }
  if (plan.ready.length) outcome = await executeActions(deps, user, plan.ready, { ...o.meta, explicitReminderFor });

  const lines = [...o.prefix];
  let keyboard: InlineKeyboardMarkup | undefined;

  if (outcome?.blocks.length) {
    lines.push(L.saved);
    outcome.blocks.forEach((b, i) => {
      if (outcome!.blocks.length > 1) lines.push("", `${i + 1}. ${b[0]}`, ...b.slice(1));
      else lines.push(...b);
    });
  }
  if (outcome?.changes.length) {
    if (outcome.blocks.length) lines.push("");
    lines.push(...outcome.changes);
  }
  if (outcome?.financeChanged && !outcome.queries.some((q) => q.intent === "finance_report")) {
    lines.push("", formatBrief(user, await computeStats(deps.db, user, "this_month", deps.clock())));
  }
  if (outcome?.failures.length) lines.push("", L.partialFail, ...outcome.failures);
  for (const p of plan.terminal) lines.push(p.issue!.text);

  if (outcome?.queries.length) {
    for (const q of outcome.queries) {
      const view = await renderQuery(deps, user, q.intent, q.filter, q.period);
      if (lines.length) lines.push("");
      lines.push(view.text);
      if (!keyboard && view.keyboard && outcome.queries.length === 1) keyboard = view.keyboard;
    }
  }

  // Aniqlashtirish
  const question = await savePending(deps, user, plan, outcome, refs, o);
  if (question) {
    if (lines.length) lines.push("");
    lines.push(L.question(question.text, 1, question.total));
    if (question.options.length) {
      keyboard = { inline_keyboard: question.options.map((opt, i) => [{ text: opt.label, callback_data: `cl:${question.version}:${i}` }]) };
    }
  } else if (question === null) {
    lines.push(L.gaveUp);
  }

  if (!keyboard && outcome?.singleTaskId && !outcome.offerPresentationForTask) keyboard = taskKeyboard(user, outcome.singleTaskId);
  if (!keyboard && outcome?.offerPresentationForTask) keyboard = { inline_keyboard: [[{ text: L.btn.makePres, callback_data: `mp:${outcome.offerPresentationForTask}` }]] };

  if (lines.length === o.prefix.length) lines.push(o.aiReply?.trim() || L.unclear);

  const text = lines.join("\n").slice(0, MAX_TEXT);
  await remember(
    deps,
    user.id,
    [
      { role: "user", text: o.userText },
      { role: "bot", text },
    ],
    outcome?.touched ?? [],
  ).catch((err) => logger.warn({ err: safeError(err) }, "history saqlanmadi"));
  return { text, keyboard, saved: !!outcome && (outcome.blocks.length > 0 || outcome.changes.length > 0) };
}

/**
 * Kutilayotgan amallarni bazaga saqlaydi (restartdan keyin ham saqlanadi).
 * Ref'lar barqaror "id:" ko'rinishiga o'tkaziladi, bog'lanishlar qayta indekslanadi.
 */
async function savePending(
  deps: Deps,
  user: User,
  plan: PlanResult,
  outcome: ExecOutcome | null,
  refs: RefMap,
  o: RunOpts,
): Promise<{ text: string; options: Array<{ label: string; value: string }>; total: number; version: number } | null | undefined> {
  if (!plan.pending.length) {
    if (o.hadPending) await setPending(deps, user.id, null);
    return undefined;
  }
  const withIssue = plan.pending.filter((p) => p.issue);
  const first = withIssue[0];
  if (!first) {
    await setPending(deps, user.id, null);
    return undefined;
  }
  const issue = first.issue!;
  // Bir xil savol takror-takror berilsa — to'xtaymiz (cheksiz aylanishdan himoya)
  const key = questionKey(first.ai, issue.field);
  const asked = key === o.prevKey ? o.asked + 1 : 1;
  if (asked > MAX_ASKS) {
    await setPending(deps, user.id, null);
    return null;
  }
  const newIndex = new Map(plan.pending.map((p, i) => [p.index, i]));
  const actions: AiAction[] = plan.pending.map((p) => {
    const a: AiAction = { ...p.ai };
    if (p.resolved.target) {
      a.related_item_id = stableRef(p.resolved.target);
      a.candidate_item_ids = [];
    } else {
      a.related_item_id = refs.toStable(a.related_item_id);
      a.candidate_item_ids = a.candidate_item_ids.map((c) => refs.toStable(c)).filter((c): c is string => !!c);
    }
    if (p.linkTo !== null) {
      const created = outcome?.created.get(p.linkTo);
      if (created) {
        a.related_item_id = stableRef(created);
        a.link_to_action = null;
      } else if (newIndex.has(p.linkTo)) a.link_to_action = newIndex.get(p.linkTo)!;
      else a.link_to_action = null;
    }
    return a;
  });
  const version = await setPending(deps, user.id, {
    kind: "clarify",
    actions,
    question: { actionIndex: newIndex.get(first.index)!, field: issue.field, text: issue.text, options: issue.options },
    asked,
    key,
  });
  return { text: issue.text, options: issue.options, total: withIssue.length, version };
}

function questionKey(a: AiAction, field: string): string {
  return `${a.intent}|${a.title ?? ""}|${a.presentation_topic ?? ""}|${field}`;
}
