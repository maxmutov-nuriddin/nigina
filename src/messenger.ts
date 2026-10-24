import { InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

export interface SendOpts {
  keyboard?: InlineKeyboardMarkup;
  replyTo?: number;
}

/**
 * Telegram'ga yuborish uchun yupqa qatlam — scheduler va worker bot kontekstisiz ishlaydi.
 * Testlarda grammY transformer orqali soxta API ulanadi.
 */
export class Messenger {
  constructor(public api: Api) {}

  async send(chatId: number | bigint, text: string, opts: SendOpts = {}): Promise<number> {
    const m = await this.api.sendMessage(Number(chatId), text, {
      reply_markup: opts.keyboard,
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
      link_preview_options: { is_disabled: true },
    });
    return m.message_id;
  }

  /** Xabarni tahrirlaydi; tahrirlab bo'lmasa (o'chirilgan va h.k.) yangisini yuboradi. */
  async edit(chatId: number | bigint, messageId: number | null | undefined, text: string, opts: SendOpts = {}): Promise<number> {
    if (messageId) {
      try {
        await this.api.editMessageText(Number(chatId), messageId, text, { reply_markup: opts.keyboard, link_preview_options: { is_disabled: true } });
        return messageId;
      } catch (err) {
        if (String(err).includes("message is not modified")) return messageId;
      }
    }
    return this.send(chatId, text, opts);
  }

  /** Telegram 4096 belgi chegarasi: uzun matn qatorlar bo'yicha bo'laklanadi, tugmalar oxirgi bo'lakda. */
  async sendLong(chatId: number | bigint, text: string, opts: SendOpts = {}): Promise<number> {
    const parts = splitText(text);
    let id = 0;
    for (let i = 0; i < parts.length; i++) id = await this.send(chatId, parts[i], i === parts.length - 1 ? opts : { replyTo: i === 0 ? opts.replyTo : undefined });
    return id;
  }

  /** Status xabarini birinchi bo'lak bilan tahrirlaydi, qolganini yangi xabar sifatida yuboradi. */
  async editLong(chatId: number | bigint, messageId: number | null | undefined, text: string, opts: SendOpts = {}): Promise<number> {
    const parts = splitText(text);
    let id = await this.edit(chatId, messageId, parts[0], parts.length === 1 ? opts : {});
    for (let i = 1; i < parts.length; i++) id = await this.send(chatId, parts[i], i === parts.length - 1 ? opts : {});
    return id;
  }

  async clearKeyboard(chatId: number | bigint, messageId: number): Promise<void> {
    try {
      await this.api.editMessageReplyMarkup(Number(chatId), messageId, { reply_markup: { inline_keyboard: [] } });
    } catch {
      /* eskirgan xabar — e'tiborsiz */
    }
  }

  async sendDocument(
    chatId: number | bigint,
    doc: { fileId: string } | { buffer: Buffer; fileName: string },
    caption: string,
    opts: SendOpts = {},
  ): Promise<{ messageId: number; fileId: string | null }> {
    const input = "fileId" in doc ? doc.fileId : new InputFile(doc.buffer, doc.fileName);
    const m = await this.api.sendDocument(Number(chatId), input, { caption: caption.slice(0, 1000), reply_markup: opts.keyboard });
    return { messageId: m.message_id, fileId: m.document?.file_id ?? null };
  }
}

export function splitText(text: string, max = 3900): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const chunks = line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, "g"))! : [line];
    for (const c of chunks) {
      if (cur && cur.length + c.length + 1 > max) {
        parts.push(cur);
        cur = c;
      } else cur = cur ? `${cur}\n${c}` : c;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
