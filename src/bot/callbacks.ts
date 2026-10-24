import type { Deps } from "../deps.ts";
import { emptyAction } from "../ai/schemas.ts";
import { t } from "../lib/i18n.ts";
import { logger, safeError } from "../logger.ts";
import { fmt } from "../core/format.ts";
import { answerOption, processText, startClarification } from "../core/pipeline.ts";
import { financeView, itemCard } from "../core/queries.ts";
import { loadState, setPending, setRetry } from "../core/state.ts";
import { cancelRemindersFor, createReminder, rescheduleReminder } from "../reminders/service.ts";
import type { BotContext } from "./bot.ts";
import { deleteUserData, settingsView } from "./settings.ts";
import { handleVoiceFile } from "./voice.ts";

/**
 * Inline tugmalar. Har bir amalda egalik (userId) va joriy holat tekshiriladi:
 * eskirgan tugma bosilsa — tushunarli javob va tugmalar olib tashlanadi.
 */
export async function handleCallback(deps: Deps, ctx: BotContext): Promise<void> {
  const user = ctx.user;
  const L = t(user.language);
  const data = ctx.callbackQuery?.data ?? "";
  const [cmd, a1, a2, a3] = data.split(":");
  const msg = ctx.callbackQuery?.message;
  const chatId = msg?.chat.id ?? Number(user.chatId);
  const msgText = msg && "text" in msg ? (msg.text ?? "") : "";

  const stale = async (text = L.stale) => {
    await ctx.answerCallbackQuery({ text, show_alert: false });
    if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
  };
  /** Xabar matniga natija qatorini qo'shib, tugmalarni olib tashlaydi */
  const appendResult = async (line: string) => {
    await ctx.answerCallbackQuery({ text: line.slice(0, 190) });
    if (msg && msgText) await deps.messenger.edit(chatId, msg.message_id, `${msgText}\n\n${line}`).catch(() => undefined);
    else if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
  };

  try {
    switch (cmd) {
      // Aniqlashtirish varianti
      case "cl": {
        const reply = await answerOption(deps, user, Number(a1), Number(a2));
        if (!reply) return stale();
        await ctx.answerCallbackQuery();
        if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
        await deps.messenger.sendLong(chatId, reply.text, { keyboard: reply.keyboard });
        return;
      }

      // Vazifa bajarildi
      case "td": {
        const task = await deps.db.task.findFirst({ where: { id: a1, userId: user.id } });
        if (!task) return stale();
        if (task.status !== "active") return stale(L.staleItem(task.title, L.statusWord[task.status]));
        await deps.db.$transaction(async (tx) => {
          await tx.task.update({ where: { id: task.id }, data: { status: "done", completedAt: deps.clock() } });
          await cancelRemindersFor(tx, user.id, { taskId: task.id });
        });
        return appendResult(L.completed(task.title));
      }

      // Eslatmani surish: rs:<reminderId>:<version>:<minutes>
      case "rs": {
        const minutes = Number(a3);
        if (![10, 60].includes(minutes)) return stale();
        const rem = await deps.db.reminder.findFirst({ where: { id: a1, userId: user.id }, include: { task: true, note: true } });
        if (!rem || rem.version !== Number(a2)) return stale();
        if (rem.task && rem.task.status !== "active") return stale(L.staleItem(rem.task.title, L.statusWord[rem.task.status]));
        if (rem.note && rem.note.status !== "active") return stale(L.staleItem(rem.note.title, L.statusWord.cancelled));
        const fireAt = new Date(deps.clock().getTime() + minutes * 60_000);
        await deps.db.$transaction(async (tx) => {
          if (rem.recurrence) {
            // Takroriy eslatma seriyasi buzilmaydi — alohida bir martalik nusxa yaratiladi
            await createReminder(tx, { userId: user.id, taskId: rem.taskId, noteId: rem.noteId, presentationId: rem.presentationId, text: rem.text, fireAt });
          } else {
            if (rem.status !== "sent") throw new StaleError();
            await rescheduleReminder(tx, rem.id, user.id, fireAt);
          }
        });
        return appendResult(L.snoozed(fmt(user, fireAt)));
      }

      // Vaqtini o'zgartirish: ct:t|n:<id>
      case "ct": {
        const item = a1 === "t" ? await deps.db.task.findFirst({ where: { id: a2, userId: user.id } }) : await deps.db.note.findFirst({ where: { id: a2, userId: user.id } });
        if (!item) return stale();
        if (item.status !== "active") return stale(L.staleItem(item.title, L.statusWord[item.status]));
        await startClarification(
          deps,
          user,
          emptyAction("update_item", { update_op: "reschedule", related_item_id: `id:${a1 === "t" ? "task" : "note"}:${item.id}`, title: item.title, missing_fields: ["event_at"] }),
          L.askNewTime(item.title),
        );
        await ctx.answerCallbackQuery();
        if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
        await deps.messenger.send(chatId, L.askNewTime(item.title));
        return;
      }

      // Bekor qilish: cx:t|n:<id>
      case "cx": {
        if (a1 === "t") {
          const task = await deps.db.task.findFirst({ where: { id: a2, userId: user.id } });
          if (!task) return stale();
          if (task.status !== "active") return stale(L.staleItem(task.title, L.statusWord[task.status]));
          await deps.db.$transaction(async (tx) => {
            await tx.task.update({ where: { id: task.id }, data: { status: "cancelled" } });
            await cancelRemindersFor(tx, user.id, { taskId: task.id });
          });
          return appendResult(L.itemCancelled(task.title));
        }
        const note = await deps.db.note.findFirst({ where: { id: a2, userId: user.id } });
        if (!note) return stale();
        if (note.status !== "active") return stale(L.staleItem(note.title, L.statusWord.cancelled));
        await deps.db.$transaction(async (tx) => {
          await tx.note.update({ where: { id: note.id }, data: { status: "cancelled" } });
          await cancelRemindersFor(tx, user.id, { noteId: note.id });
        });
        return appendResult(L.itemCancelled(note.title));
      }

      // Kartochka: it:t|n:<id>
      case "it": {
        const view = await itemCard(deps, user, a1 === "n" ? "n" : "t", a2);
        if (!view) return stale();
        await ctx.answerCallbackQuery();
        await deps.messenger.send(chatId, view.text, { keyboard: view.keyboard });
        return;
      }

      // Prezentatsiya faylini qayta yuborish
      case "pf": {
        const pres = await deps.db.presentation.findFirst({ where: { id: a1, userId: user.id } });
        if (!pres || pres.status !== "ready" || !pres.telegramFileId) return stale();
        await ctx.answerCallbackQuery();
        await deps.messenger.sendDocument(chatId, { fileId: pres.telegramFileId }, L.pres.caption(pres.topic));
        return;
      }

      // Prezentatsiyani qayta yaratish
      case "pr": {
        const pres = await deps.db.presentation.findFirst({ where: { id: a1, userId: user.id } });
        if (!pres || pres.status !== "failed") return stale();
        const updated = await deps.db.presentation.updateMany({ where: { id: pres.id, userId: user.id, status: "failed" }, data: { status: "queued", error: null, stage: null } });
        if (!updated.count) return stale();
        await ctx.answerCallbackQuery();
        if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
        const statusId = await deps.messenger.send(chatId, L.pres.queued(pres.topic));
        await deps.db.presentation.update({ where: { id: pres.id }, data: { statusMessageId: statusId, statusChatId: BigInt(chatId) } });
        await deps.enqueuePresentation(pres.id, `r${Date.now()}`);
        return;
      }

      // Vazifa uchun prezentatsiya taklifi: mp:<taskId>
      case "mp": {
        const task = await deps.db.task.findFirst({ where: { id: a1, userId: user.id } });
        if (!task || task.status !== "active") return stale();
        await startClarification(
          deps,
          user,
          emptyAction("create_presentation", {
            related_item_id: `id:task:${task.id}`,
            category: task.category,
            title: task.title,
            presentation_language: user.language,
            missing_fields: ["presentation_topic"],
          }),
          L.presTopicQ,
        );
        await ctx.answerCallbackQuery();
        if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
        await deps.messenger.send(chatId, `❓ ${L.presTopicQ}`);
        return;
      }

      // Moliyaviy hisobot davri: fr:<period>
      case "fr": {
        if (!["today", "this_week", "this_month", "last_month"].includes(a1)) return stale();
        await ctx.answerCallbackQuery();
        const view = await financeView(deps, user, a1 as "today");
        await deps.messenger.sendLong(chatId, view.text, { keyboard: view.keyboard });
        return;
      }

      // AI xatosidan keyin qayta urinish
      case "rt": {
        const state = await loadState(deps, user.id);
        const retry = state.retry;
        if (!retry) return stale();
        await setRetry(deps, user.id, null);
        await ctx.answerCallbackQuery();
        if (msg) await deps.messenger.edit(chatId, msg.message_id, retry.fileId ? L.listening : L.thinking);
        let reply;
        if (retry.fileId) {
          reply = await handleVoiceFile(deps, { user, fileId: retry.fileId, kind: retry.kind, updateId: retry.updateId, messageId: retry.messageId, chatId, statusMessageId: msg?.message_id ?? 0 });
        } else {
          const inbound = await deps.db.inboundMessage.findUnique({ where: { updateId: BigInt(retry.updateId) } });
          reply = await processText(deps, { user, text: retry.text ?? "", inboundMessageId: inbound?.userId === user.id ? inbound.id : null, messageId: retry.messageId, updateId: retry.updateId, kind: retry.kind });
        }
        await deps.messenger.editLong(chatId, msg?.message_id, reply.text, { keyboard: reply.keyboard });
        return;
      }

      // Sozlamalar
      case "st": {
        if (a1 === "lang" && (a2 === "uz" || a2 === "ru")) {
          const u = await deps.db.user.update({ where: { id: user.id }, data: { language: a2 } });
          await ctx.answerCallbackQuery({ text: t(a2).langSet });
          if (msg) {
            const v = await settingsView(deps, u);
            await deps.messenger.edit(chatId, msg.message_id, v.text, { keyboard: v.keyboard });
          }
          return;
        }
        if (a1 === "tz" || a1 === "time") {
          await setPending(deps, user.id, { kind: a1 === "tz" ? "settings_tz" : "settings_time" });
          await ctx.answerCallbackQuery();
          await deps.messenger.send(chatId, a1 === "tz" ? L.askTz : L.askDefaultTime);
          return;
        }
        if (a1 === "ai") {
          await ctx.answerCallbackQuery({ text: L.ai.refreshed });
          if (msg) {
            const v = await settingsView(deps, user);
            // Matn o'zgarmagan bo'lsa Telegram "message is not modified" qaytaradi — e'tiborsiz
            await deps.messenger.edit(chatId, msg.message_id, v.text, { keyboard: v.keyboard }).catch(() => {});
          }
          return;
        }
        if (a1 === "rem") {
          const u = await deps.db.user.update({ where: { id: user.id }, data: { remindersEnabled: !user.remindersEnabled } });
          await ctx.answerCallbackQuery();
          if (msg) {
            const v = await settingsView(deps, u);
            await deps.messenger.edit(chatId, msg.message_id, v.text, { keyboard: v.keyboard });
          }
          return;
        }
        if (a1 === "del") {
          await ctx.answerCallbackQuery();
          await deps.messenger.send(chatId, L.confirmDelete, {
            keyboard: { inline_keyboard: [[{ text: L.btn.yes, callback_data: "st:delok" }, { text: L.btn.no, callback_data: "st:delno" }]] },
          });
          return;
        }
        if (a1 === "delok") {
          await deleteUserData(deps, user);
          await ctx.answerCallbackQuery();
          if (msg) await deps.messenger.edit(chatId, msg.message_id, L.deleted);
          return;
        }
        if (a1 === "delno") {
          await ctx.answerCallbackQuery();
          if (msg) await deps.messenger.clearKeyboard(chatId, msg.message_id);
          return;
        }
        return stale();
      }

      default:
        return stale();
    }
  } catch (err) {
    if (err instanceof StaleError) return stale();
    logger.error({ err: safeError(err), cmd }, "callback xatosi");
    await ctx.answerCallbackQuery({ text: L.error }).catch(() => undefined);
  }
}

class StaleError extends Error {}
