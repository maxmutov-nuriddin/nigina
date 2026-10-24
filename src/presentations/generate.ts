import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Deps } from "../deps.ts";
import type { Presentation, User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { logger, safeError } from "../logger.ts";
import { renderDeck } from "./render.ts";
import { sanitizeDeck } from "./sanitize.ts";

export class PresentationError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "prezentatsiya"
  );
}

/**
 * Prezentatsiyani yaratadi va Telegram'ga yuboradi.
 * "Tayyor" holati faqat fayl muvaffaqiyatli yuborilib, file_id saqlangandan keyin qo'yiladi.
 * Xato bo'lsa va urinishlar qolgan bo'lsa — xato tashlanadi (BullMQ qayta urinadi).
 */
export async function generatePresentation(deps: Deps, presentationId: string, o: { finalAttempt: boolean }): Promise<void> {
  const { db } = deps;
  const pres = await db.presentation.findUnique({ where: { id: presentationId }, include: { user: true, inbound: true } });
  if (!pres) return;
  if (pres.status === "ready" || pres.status === "failed") return; // idempotent: allaqachon yakunlangan
  const user = pres.user;
  const L = t(user.language);
  const chatId = pres.statusChatId ?? user.chatId;

  let statusMessageId = pres.statusMessageId;
  const stage = async (name: string) => {
    await db.presentation.update({ where: { id: pres.id }, data: { status: "generating", stage: name } });
    statusMessageId = await deps.messenger
      .edit(chatId, statusMessageId, L.pres.generating(pres.topic, L.pres.stages[name] ?? name))
      .catch(() => statusMessageId ?? 0);
    if (statusMessageId && statusMessageId !== pres.statusMessageId) {
      await db.presentation.update({ where: { id: pres.id }, data: { statusMessageId } });
    }
  };

  try {
    await db.presentation.update({ where: { id: pres.id }, data: { attempts: { increment: 1 } } });
    const input = {
      topic: pres.topic,
      language: pres.language,
      slideCount: pres.slideCount,
      requirements: pres.requirements,
      // Foydalanuvchi o'zi aytgan matn — "manba" sifatida (raqamlarni tekshirish uchun)
      sourceMaterial: pres.inbound?.transcript ?? null,
    };
    const model = deps.cfg.GROQ_PRESENTATION_MODEL || undefined;

    await stage("outline");
    const outline = await deps.nlu.outline(input, user.id, model);
    if (!outline.slides.length) throw new PresentationError("Bo'sh reja", true);
    await db.presentation.update({ where: { id: pres.id }, data: { outline: outline as object } });

    await stage("content");
    const rawDeck = await deps.nlu.deck(input, outline, user.id, model);
    const source = [pres.topic, pres.requirements ?? "", input.sourceMaterial ?? ""].join("\n");
    const { deck, removedClaims } = sanitizeDeck(rawDeck, { language: pres.language, contentSlides: pres.slideCount - 1, source });
    if (deck.slides.length < 2) throw new PresentationError("Slaydlar mazmuni yetarli emas", true);
    if (removedClaims) logger.info({ presentationId: pres.id, removedClaims }, "tekshirilmagan raqamli da'volar olib tashlandi");

    await stage("render");
    const { buffer, slideCount } = await renderDeck(deck, { language: pres.language });
    const fileName = `${slugify(deck.title || pres.topic)}.pptx`;
    const dir = path.resolve(deps.cfg.STORAGE_DIR, "presentations", user.id);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${pres.id}.pptx`);
    await writeFile(filePath, buffer);
    await db.presentation.update({ where: { id: pres.id }, data: { filePath, fileName, fileSize: buffer.length } });

    await stage("upload");
    const sent = await deps.messenger.sendDocument(chatId, { buffer, fileName }, L.pres.caption(deck.title || pres.topic));
    await db.presentation.update({
      where: { id: pres.id },
      data: { status: "ready", stage: null, error: null, telegramFileId: sent.fileId, slideCount },
    });
    await deps.messenger.edit(chatId, statusMessageId, L.pres.ready(pres.topic, slideCount)).catch(() => undefined);
    logger.info({ presentationId: pres.id, slides: slideCount, bytes: buffer.length }, "prezentatsiya tayyor");
  } catch (err) {
    const msg = safeError(err);
    logger.warn({ presentationId: pres.id, err: msg, final: o.finalAttempt }, "prezentatsiya xatosi");
    if (!o.finalAttempt) {
      await db.presentation.update({ where: { id: pres.id }, data: { status: "generating", stage: "retry", error: msg } });
      throw err;
    }
    await markFailed(deps, pres, user, msg, statusMessageId);
  }
}

export async function markFailed(deps: Deps, pres: Presentation, user: User, error: string, statusMessageId?: number | null): Promise<void> {
  const L = t(user.language);
  await deps.db.presentation.update({ where: { id: pres.id }, data: { status: "failed", stage: null, error } });
  await deps.messenger
    .edit(pres.statusChatId ?? user.chatId, statusMessageId ?? pres.statusMessageId, L.pres.failed(pres.topic), {
      keyboard: { inline_keyboard: [[{ text: L.btn.retry, callback_data: `pr:${pres.id}` }]] },
    })
    .catch(() => undefined);
}

/** Navbatga qo'yilgan, lekin job'i yo'qolgan prezentatsiyalarni qayta navbatga qo'yadi. */
export async function sweepQueued(deps: Deps, olderThanMs = 120_000): Promise<number> {
  const stale = await deps.db.presentation.findMany({
    where: { status: "queued", updatedAt: { lt: new Date(deps.clock().getTime() - olderThanMs) } },
    take: 20,
  });
  for (const p of stale) {
    await deps.enqueuePresentation(p.id).catch((err) => logger.warn({ err: safeError(err) }, "sweep enqueue xatosi"));
    await deps.db.presentation.update({ where: { id: p.id }, data: { updatedAt: deps.clock() } });
  }
  return stale.length;
}
