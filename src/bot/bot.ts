import { Bot, Keyboard, type Context, type NextFunction } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import type { UserFromGetMe } from "grammy/types";
import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { isValidTimezone } from "../lib/time.ts";
import { consumeQuota } from "../lib/usage.ts";
import { logger, safeError } from "../logger.ts";
import { processText } from "../core/pipeline.ts";
import { defaultFilter, notesView, presentationsView, tasksView, type View } from "../core/queries.ts";
import { loadState, setPending } from "../core/state.ts";
import { handleCallback } from "./callbacks.ts";
import { settingsView } from "./settings.ts";
import { handleVoiceFile } from "./voice.ts";
import { hasAccess } from "../lib/access.ts";
import { splitText } from "../messenger.ts";
import { financeView } from "../core/queries.ts";

export interface BotContext extends Context {
  user: User;
}

export function mainMenu(user: User) {
  const M = t(user.language).menu;
  return new Keyboard().text(M.today).text(M.tasks).row().text(M.notes).text(M.finance).row().text(M.presentations).text(M.settings).resized().persistent();
}

export function createBot(deps: Deps, token: string, opts: { botInfo?: UserFromGetMe; sequential?: boolean } = {}): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  // API'ni Messenger ham ishlatadi (scheduler, worker)
  deps.messenger.api = bot.api;

  // Bir chat ichidagi update'lar ketma-ket — suhbat holati poygasiz (runner/webhook parallel ishlaganda)
  if (opts.sequential) bot.use(sequentialize((ctx) => ctx.chat?.id.toString() ?? ctx.from?.id.toString()));

  // Faqat ruxsat berilganlar. Boshqalar e'tiborsiz qoldiriladi va bazaga yozilmaydi;
  // shaxsiy chatda /start bossa — asosiy foydalanuvchiga so'rov sifatida saqlanadi
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
    if (!(await hasAccess(deps, chatId, ctx.from?.id))) {
      logger.info({ chatId }, "ruxsat etilmagan chat — e'tiborsiz");
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      else if (deps.cfg.OWNER_CHAT_ID && ctx.chat?.type === "private" && ctx.from && !ctx.from.is_bot && /^\/start(@\w+)?(\s|$)/.test(ctx.message?.text ?? "")) {
        await requestAccess(deps, ctx);
      }
      return;
    }
    await next();
  });
  bot.use(privateOnly);
  bot.use(dedupeUpdates(deps));
  bot.use(loadUser(deps));

  bot.command("start", async (ctx) => {
    const L = t(ctx.user.language);
    await ctx.reply(L.welcome(ctx.from?.first_name ?? "", ctx.user.timezone), { reply_markup: mainMenu(ctx.user) });
  });
  bot.command("help", (ctx) => ctx.reply(t(ctx.user.language).help, { reply_markup: mainMenu(ctx.user) }));
  bot.command("today", (ctx) => sendView(ctx, tasksView(deps, ctx.user, defaultFilter({ range: "today" }))));
  bot.command("week", (ctx) => sendView(ctx, tasksView(deps, ctx.user, defaultFilter({ range: "this_week" }))));
  bot.command("tasks", (ctx) => sendView(ctx, tasksView(deps, ctx.user, defaultFilter({ range: "all" }))));
  bot.command("notes", (ctx) => sendView(ctx, notesView(deps, ctx.user, defaultFilter({ range: "all", item_type: "note" }))));
  bot.command("presentations", (ctx) => sendView(ctx, presentationsView(deps, ctx.user)));
  bot.command("finance", (ctx) => sendView(ctx, financeView(deps, ctx.user, "this_month")));
  bot.command("settings", (ctx) => sendView(ctx, settingsView(deps, ctx.user)));
  bot.command("cancel", async (ctx) => {
    const L = t(ctx.user.language);
    const state = await loadState(deps, ctx.user.id);
    if (state.pending) {
      await setPending(deps, ctx.user.id, null);
      await ctx.reply(L.cancelled);
    } else await ctx.reply(L.nothingToCancel);
  });

  bot.on("message:text", async (ctx) => {
    const user = ctx.user;
    const L = t(user.language);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return void (await ctx.reply(L.help));

    // Asosiy menyu tugmalari (ikkala tilda ham)
    const menu = menuAction(text);
    if (menu === "today") return sendView(ctx, tasksView(deps, user, defaultFilter({ range: "today" })));
    if (menu === "tasks") return sendView(ctx, tasksView(deps, user, defaultFilter({ range: "all" })));
    if (menu === "notes") return sendView(ctx, notesView(deps, user, defaultFilter({ range: "all", item_type: "note" })));
    if (menu === "presentations") return sendView(ctx, presentationsView(deps, user));
    if (menu === "finance") return sendView(ctx, financeView(deps, user, "this_month"));
    if (menu === "settings") return sendView(ctx, settingsView(deps, user));

    // Sozlamalar uchun kutilayotgan kiritish
    const state = await loadState(deps, user.id);
    if (state.pending?.kind === "settings_tz") {
      if (!isValidTimezone(text)) return void (await ctx.reply(L.badTz));
      await deps.db.user.update({ where: { id: user.id }, data: { timezone: text } });
      await setPending(deps, user.id, null);
      return void (await ctx.reply(L.tzSet(text)));
    }
    if (state.pending?.kind === "settings_time") {
      const m = /^(\d{1,2})[:.](\d{2})$/.exec(text);
      if (!m || +m[1] > 23 || +m[2] > 59) return void (await ctx.reply(L.badTime));
      const hhmm = `${m[1].padStart(2, "0")}:${m[2]}`;
      await deps.db.user.update({ where: { id: user.id }, data: { defaultReminderTime: hhmm } });
      await setPending(deps, user.id, null);
      return void (await ctx.reply(L.defaultTimeSet(hhmm)));
    }

    if (!(await consumeQuota(deps.db, user.id, "ai", deps.cfg.DAILY_AI_LIMIT, deps.clock()))) return void (await ctx.reply(L.dailyLimit));
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const inbound = await deps.db.inboundMessage.upsert({
      where: { updateId: BigInt(ctx.update.update_id) },
      create: { userId: user.id, updateId: BigInt(ctx.update.update_id), messageId: ctx.message.message_id, kind: "text", transcript: text },
      update: {},
    });
    const reply = await processText(deps, {
      user,
      text,
      inboundMessageId: inbound.id,
      messageId: ctx.message.message_id,
      updateId: String(ctx.update.update_id),
      kind: "text",
    });
    if (reply.duplicate) return;
    await deps.messenger.sendLong(ctx.chat.id, reply.text, { keyboard: reply.keyboard, replyTo: ctx.message.message_id });
  });

  bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
    const user = ctx.user;
    const L = t(user.language);
    const msg = ctx.message;
    const media = msg.voice ?? msg.audio ?? msg.video_note;
    if (!media) return;
    const kind = msg.voice ? "voice" : msg.audio ? "audio" : "video_note";
    if ((media.duration ?? 0) > deps.cfg.MAX_VOICE_SECONDS) return void (await ctx.reply(L.voiceTooLong(deps.cfg.MAX_VOICE_SECONDS)));
    if ((media.file_size ?? 0) > deps.cfg.MAX_VOICE_BYTES) return void (await ctx.reply(L.voiceTooBig));
    if (!(await consumeQuota(deps.db, user.id, "voice", deps.cfg.DAILY_VOICE_LIMIT, deps.clock()))) return void (await ctx.reply(L.dailyLimit));

    const status = await ctx.reply(L.listening, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    const reply = await handleVoiceFile(deps, {
      user,
      fileId: media.file_id,
      kind,
      updateId: String(ctx.update.update_id),
      messageId: msg.message_id,
      chatId: ctx.chat.id,
      statusMessageId: status.message_id,
    });
    if (reply.duplicate) return;
    await deps.messenger.editLong(ctx.chat.id, status.message_id, reply.text, { keyboard: reply.keyboard });
  });

  bot.on("callback_query:data", (ctx) => handleCallback(deps, ctx));

  bot.on("message", (ctx) => ctx.reply(t(ctx.user.language).unsupported));

  bot.catch(async (err) => {
    logger.error({ err: safeError(err.error), updateId: err.ctx.update.update_id }, "bot handler xatosi");
    try {
      if (err.ctx.callbackQuery) await err.ctx.answerCallbackQuery();
      else if (err.ctx.chat) await err.ctx.reply(t((err.ctx as BotContext).user?.language).error);
    } catch {
      /* ignore */
    }
  });

  return bot;
}

async function sendView(ctx: BotContext, view: Promise<View>): Promise<void> {
  const v = await view;
  const parts = splitText(v.text);
  for (let i = 0; i < parts.length; i++) await ctx.api.sendMessage(ctx.chat!.id, parts[i], i === parts.length - 1 ? { reply_markup: v.keyboard } : {});
}

function menuAction(text: string): string | null {
  for (const lang of ["uz", "ru"] as const) {
    const M = t(lang).menu;
    for (const [key, label] of Object.entries(M)) if (label === text) return key;
  }
  return null;
}

/** Ruxsatsiz foydalanuvchining /start'i — so'rov (qayta bossa, ma'lumoti yangilanadi). */
async function requestAccess(deps: Deps, ctx: Context): Promise<void> {
  const from = ctx.from!;
  const language = from.language_code?.startsWith("ru") ? "ru" : "uz";
  await deps.db.accessRequest.upsert({
    where: { telegramUserId: BigInt(from.id) },
    create: { telegramUserId: BigInt(from.id), chatId: BigInt(ctx.chat!.id), firstName: from.first_name, username: from.username, language },
    update: { chatId: BigInt(ctx.chat!.id), firstName: from.first_name, username: from.username },
  });
  await ctx.reply(t(language).access.requested).catch(() => undefined);
}

async function privateOnly(ctx: Context, next: NextFunction): Promise<void> {
  const type = ctx.chat?.type ?? ctx.callbackQuery?.message?.chat.type;
  if (type && type !== "private") return;
  await next();
}

/**
 * Telegram update idempotentligi: bir xil update_id ikkinchi marta qayta ishlanmaydi.
 * Xatoda "failed" — qayta yuborilsa (webhook retry) qayta ishlanadi. 10 daqiqadan uzoq "processing" — eskirgan deb hisoblanadi.
 */
function dedupeUpdates(deps: Deps) {
  return async (ctx: Context, next: NextFunction) => {
    const id = BigInt(ctx.update.update_id);
    const now = deps.clock();
    const stale = new Date(now.getTime() - 10 * 60_000);
    const n = await deps.db.$executeRaw`
      INSERT INTO "ProcessedUpdate" ("updateId", "status", "startedAt") VALUES (${id}, 'processing'::"UpdateStatus", ${now})
      ON CONFLICT ("updateId") DO UPDATE SET "status" = 'processing'::"UpdateStatus", "startedAt" = ${now}
      WHERE "ProcessedUpdate"."status" = 'failed'::"UpdateStatus"
         OR ("ProcessedUpdate"."status" = 'processing'::"UpdateStatus" AND "ProcessedUpdate"."startedAt" < ${stale})`;
    if (n === 0) {
      logger.info({ updateId: ctx.update.update_id }, "takroriy update — o'tkazib yuborildi");
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    try {
      await next();
      await deps.db.processedUpdate.update({ where: { updateId: id }, data: { status: "done", finishedAt: deps.clock(), userId: (ctx as BotContext).user?.id } });
    } catch (err) {
      await deps.db.processedUpdate.update({ where: { updateId: id }, data: { status: "failed", finishedAt: deps.clock() } }).catch(() => undefined);
      throw err;
    }
  };
}

function loadUser(deps: Deps) {
  return async (ctx: BotContext, next: NextFunction) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
    if (!from || from.is_bot || !chatId) return;
    const lang = from.language_code?.startsWith("ru") ? "ru" : "uz";
    ctx.user = await deps.db.user.upsert({
      where: { telegramUserId: BigInt(from.id) },
      create: { telegramUserId: BigInt(from.id), chatId: BigInt(chatId), firstName: from.first_name, username: from.username, language: lang, timezone: deps.cfg.DEFAULT_TIMEZONE, currency: deps.cfg.DEFAULT_CURRENCY },
      update: { chatId: BigInt(chatId), firstName: from.first_name, username: from.username, blockedAt: null },
    });
    await next();
  };
}
