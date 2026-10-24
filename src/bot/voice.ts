import path from "node:path";
import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import { AiError } from "../ai/provider.ts";
import { t } from "../lib/i18n.ts";
import { logger, safeError } from "../logger.ts";
import { truncate } from "../core/format.ts";
import { processText, type Reply } from "../core/pipeline.ts";
import { setRetry } from "../core/state.ts";
import { AudioFormatError, prepareAudio } from "./audio.ts";

/** Whisper uchun yo'naltiruvchi matn: o'zbekcha lotin imlosi va tez-tez uchraydigan so'zlar. */
const TRANSCRIBE_PROMPT =
  "Ertaga soat to‘qqizda mijozga qo‘ng‘iroq qilishim kerak. Prezentatsiya tayyorla, eslat, dars, vazifa, juma kuni. Завтра в девять напомни.";

export interface VoiceInput {
  user: User;
  fileId: string;
  kind: string;
  updateId: string;
  messageId: number;
  chatId: number;
  statusMessageId: number;
}

/**
 * Ovoz → transkripsiya → pipeline. Status xabari tahrirlanadi (keraksiz yangi xabar yuborilmaydi).
 * Xatoda "Qayta urinish" uchun file_id saqlanadi.
 */
export async function handleVoiceFile(deps: Deps, v: VoiceInput): Promise<Reply> {
  const L = t(v.user.language);
  let transcript: string;
  let durationSec: number | null = null;
  let lowConfidence = false;
  try {
    const file = await deps.messenger.api.getFile(v.fileId);
    if (!file.file_path) throw new AudioFormatError("file_path yo'q");
    const raw = await deps.downloadFile(file.file_path);
    if (raw.length > deps.cfg.MAX_VOICE_BYTES) return { text: L.voiceTooBig, saved: false };
    const ext = path.extname(file.file_path).slice(1) || "ogg";
    const audio = await prepareAudio(raw, ext, deps.cfg);
    const tr = await deps.ai.transcribe({
      audio: audio.buffer,
      filename: audio.filename,
      language: deps.cfg.GROQ_TRANSCRIPTION_LANGUAGE || undefined,
      prompt: TRANSCRIBE_PROMPT,
      userId: v.user.id,
    });
    // Audio buferlari shu yerda tugaydi — diskka faqat ffmpeg kerak bo'lganda yoziladi va darhol o'chiriladi
    transcript = tr.text;
    durationSec = tr.durationSec ? Math.round(tr.durationSec) : null;
    lowConfidence = tr.avgLogprob !== null && tr.avgLogprob < -1.0;
  } catch (err) {
    if (err instanceof AudioFormatError) {
      logger.warn({ err: safeError(err), userId: v.user.id }, "audio format");
      return { text: L.unsupported, saved: false };
    }
    if (err instanceof AiError) {
      if (err.code === "not_configured" || err.code === "auth") return { text: L.aiNotConfigured, saved: false };
      await setRetry(deps, v.user.id, { fileId: v.fileId, updateId: v.updateId, messageId: v.messageId, kind: v.kind });
      return { text: err.code === "rate_limit" ? L.aiRateLimited(err.retryAfterSec) : L.aiUnavailable, keyboard: { inline_keyboard: [[{ text: L.btn.retry, callback_data: "rt" }]] }, saved: false };
    }
    logger.error({ err: safeError(err), userId: v.user.id }, "ovozni qayta ishlash xatosi");
    await setRetry(deps, v.user.id, { fileId: v.fileId, updateId: v.updateId, messageId: v.messageId, kind: v.kind });
    return { text: L.error, keyboard: { inline_keyboard: [[{ text: L.btn.retry, callback_data: "rt" }]] }, saved: false };
  }

  if (!transcript.trim()) return { text: L.emptyTranscript, saved: false };

  const inbound = await deps.db.inboundMessage.upsert({
    where: { updateId: BigInt(v.updateId) },
    create: { userId: v.user.id, updateId: BigInt(v.updateId), messageId: v.messageId, kind: v.kind, transcript, durationSec },
    update: { transcript, durationSec },
  });
  const header = [L.heard(truncate(transcript, 300))];
  if (lowConfidence) header.push(L.lowConfidence);
  header.push("");
  return processText(deps, {
    user: v.user,
    text: transcript,
    inboundMessageId: inbound.id,
    messageId: v.messageId,
    updateId: v.updateId,
    kind: v.kind,
    header,
  });
}
