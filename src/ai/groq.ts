import Groq, { toFile, APIConnectionTimeoutError, APIConnectionError, APIError } from "groq-sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
import type { Config } from "../config.ts";
import { logger, safeError } from "../logger.ts";
import { AiError, type AiProvider, type JsonRequest, type TranscriptionResult, type UsageEvent } from "./provider.ts";
import { toStrictJsonSchema } from "./schemas.ts";

/**
 * Groq integratsiyasi (OpenAI-mos API):
 *  - STT: POST /openai/v1/audio/transcriptions (whisper-large-v3 / whisper-large-v3-turbo)
 *  - Chat: POST /openai/v1/chat/completions, response_format json_schema (strict)
 * Model nomlari faqat env orqali keladi.
 */
export class GroqProvider implements AiProvider {
  readonly name: string;
  private client: Groq | null;
  private fallback: Groq | null;

  constructor(
    private cfg: Config,
    private onUsage: (e: UsageEvent) => void = () => {},
    /** Rate limit'da ishlatiladigan zaxira kalit (ixtiyoriy) */
    fallbackApiKey?: string,
    /** Jurnal va holat uchun nom (asosiy — "groq", tahlil kaliti — "groq:analysis") */
    name = "groq",
  ) {
    this.name = name;
    this.client = cfg.GROQ_API_KEY
      ? new Groq({ apiKey: cfg.GROQ_API_KEY, maxRetries: cfg.GROQ_MAX_RETRIES, timeout: cfg.GROQ_TIMEOUT_MS })
      : null;
    this.fallback =
      fallbackApiKey && fallbackApiKey !== cfg.GROQ_API_KEY ? new Groq({ apiKey: fallbackApiKey, maxRetries: 1, timeout: cfg.GROQ_TIMEOUT_MS }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): Groq {
    if (!this.client) throw new AiError("not_configured", "GROQ_API_KEY sozlanmagan", false);
    return this.client;
  }

  async transcribe(input: { audio: Buffer; filename: string; language?: string; prompt?: string; userId?: string }): Promise<TranscriptionResult> {
    const client = this.requireClient();
    const model = this.cfg.GROQ_TRANSCRIPTION_MODEL;
    const started = Date.now();
    try {
      const file = await toFile(input.audio, input.filename);
      const res = (await this.withRateLimitWait(() => client.audio.transcriptions.create({
        file,
        model,
        response_format: "verbose_json",
        temperature: 0,
        ...(input.language ? { language: input.language } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
      }), "transcribe")) as unknown as { text: string; language?: string; duration?: number; segments?: Array<{ avg_logprob?: number }> };
      const segs = res.segments ?? [];
      const avg = segs.length ? segs.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / segs.length : null;
      this.onUsage({ userId: input.userId, kind: "transcribe", model, audioSeconds: res.duration, latencyMs: Date.now() - started, ok: true, provider: this.name });
      return { text: (res.text ?? "").trim(), language: res.language ?? null, durationSec: res.duration ?? null, avgLogprob: avg };
    } catch (err) {
      const e = mapError(err);
      this.onUsage({ userId: input.userId, kind: "transcribe", model, latencyMs: Date.now() - started, ok: false, errorCode: e.code, provider: this.name, retryAfterSec: e.retryAfterSec, limitScope: e.limitScope });
      throw e;
    }
  }

  /**
   * Groq TPM (daqiqalik token) limitida SDK o'zi qayta urinmaydi. retry-after qisqa bo'lsa — kutib, qayta urinamiz
   * (foydalanuvchi bir necha soniya ko'proq kutadi, lekin xabari muvaffaqiyatli qayta ishlanadi).
   */
  private async withRateLimitWait<R>(fn: () => Promise<R>, kind: string, failFast = false): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        // TPM limitida Groq 429 yoki (so'ralgan token taxmini katta bo'lsa) 413 qaytaradi — ikkalasida ham retry-after bor
        const limited = err instanceof APIError && (err.status === 429 || (err.status === 413 && /rate_limit/.test(JSON.stringify(err.error ?? ""))));
        if (failFast || attempt >= 2 || !limited) throw err;
        const waitMs = retryAfterMs(err);
        if (waitMs === null || waitMs > this.cfg.GROQ_RATE_LIMIT_MAX_WAIT_MS) throw err;
        logger.info({ kind, waitMs }, "Groq rate limit — kutib qayta urinilmoqda");
        await new Promise((r) => setTimeout(r, waitMs + 250));
      }
    }
  }

  async completeJson<T>(req: JsonRequest<T>): Promise<T> {
    const client = this.requireClient();
    const model = req.model || this.cfg.GROQ_CHAT_MODEL;
    const jsonSchema = toStrictJsonSchema(req.schema);
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];

    // Sxemaga mos kelmagan javobda bitta "tuzatish" urinishi
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      let content: string | null | undefined;
      try {
        const params: ChatCompletionCreateParamsNonStreaming = {
          model,
          messages,
          temperature: req.temperature ?? 0.2,
          max_completion_tokens: req.maxTokens ?? this.cfg.GROQ_MAX_COMPLETION_TOKENS,
          // reasoning_effort faqat gpt-oss (reasoning) modellarida qo'llanadi
          ...(this.cfg.GROQ_REASONING_EFFORT && model.startsWith("openai/gpt-oss") ? { reasoning_effort: this.cfg.GROQ_REASONING_EFFORT } : {}),
          response_format: this.cfg.GROQ_STRICT_JSON
            ? { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: jsonSchema } }
            : { type: "json_object" },
        };
        let res;
        try {
          res = await this.withRateLimitWait(() => client.chat.completions.create(params), req.kind, !!this.fallback);
        } catch (err) {
          if (!this.fallback || mapError(err).code !== "rate_limit") throw err;
          logger.info({ kind: req.kind }, "asosiy Groq kaliti rate limit — zaxira kalit bilan");
          res = await this.withRateLimitWait(() => this.fallback!.chat.completions.create(params), req.kind);
        }
        content = res.choices[0]?.message?.content;
        this.onUsage({
          userId: req.userId,
          kind: req.kind,
          model,
          promptTokens: res.usage?.prompt_tokens,
          completionTokens: res.usage?.completion_tokens,
          latencyMs: Date.now() - started,
          ok: true,
          provider: this.name,
        });
      } catch (err) {
        const e = mapError(err);
        this.onUsage({ userId: req.userId, kind: req.kind, model, latencyMs: Date.now() - started, ok: false, errorCode: e.code, provider: this.name, retryAfterSec: e.retryAfterSec, limitScope: e.limitScope });
        // Strict rejimda generatsiya sxemaga tushmadi — bir marta qayta urinamiz
        if (e.code === "bad_output" && attempt === 0) continue;
        throw e;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content ?? "");
      } catch {
        parsed = undefined;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return result.data;

      logger.warn({ kind: req.kind, attempt, issues: result.error?.issues.slice(0, 5).map((i) => i.path.join(".")) }, "AI javobi sxemaga mos emas");
      this.onUsage({ userId: req.userId, kind: req.kind, model, latencyMs: 0, ok: false, errorCode: "bad_output", provider: this.name });
      messages.push({ role: "assistant", content: content ?? "" });
      messages.push({
        role: "user",
        content: `Javob JSON sxemaga mos emas: ${result.error?.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}. Faqat sxemaga mos JSON qaytaring.`,
      });
    }
    throw new AiError("bad_output", "AI javobi sxemaga mos kelmadi", true);
  }
}

function mapError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof APIConnectionTimeoutError) return new AiError("timeout", "Groq timeout", true);
  if (err instanceof APIConnectionError) return new AiError("unavailable", "Groq bilan aloqa yo'q", true);
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    // Groq xato kodi (masalan json_validate_failed) — xabar matni emas: unda model chiqishi/foydalanuvchi matni bo'lishi mumkin
    const groqCode = (err.error as { error?: { code?: string } } | undefined)?.error?.code ?? (err.error as { code?: string } | undefined)?.code;
    // Strict rejimda model sxemaga mos JSON yarata olmadi — qayta urinish mumkin
    if (status === 400 && groqCode === "json_validate_failed") return new AiError("bad_output", "Groq json_validate_failed", true);
    if (status === 401 || status === 403) return new AiError("auth", `Groq auth xatosi (${status})`, false);
    const wait = status === 429 || status === 413 ? retryAfterMs(err) : null;
    const waitSec = wait === null ? null : Math.ceil(wait / 1000);
    // Groq xabarida limit turi yoziladi: "tokens per day (TPD)", "requests per minute (RPM)" — foydalanuvchi matni yo'q
    const scope = /per day|\((?:TPD|RPD)\)/i.test(String(err.message)) ? "day" : /per minute|\((?:TPM|RPM)\)/i.test(String(err.message)) ? "minute" : waitSec !== null && waitSec > 120 ? "day" : "minute";
    if (status === 429) return new AiError("rate_limit", "Groq rate limit", true, waitSec, scope);
    if (status === 413) return new AiError("rate_limit", "Groq: so'rov hajmi TPM limitidan katta (413)", true, waitSec, scope);
    if (status === 400 || status === 404 || status === 422) return new AiError("bad_request", `Groq so'rov xatosi (${status}${groqCode ? ` ${groqCode}` : ""})`, false);
    return new AiError("unavailable", `Groq server xatosi (${status})`, true);
  }
  return new AiError("unavailable", safeError(err), true);
}

/** retry-after sarlavhasi yoki "try again in 11.7s" matnidan kutish vaqti */
function retryAfterMs(err: InstanceType<typeof APIError>): number | null {
  const h = err.headers as Headers | undefined;
  const header = h?.get?.("retry-after");
  if (header && Number.isFinite(Number(header))) return Number(header) * 1000;
  const m = /try again in ([\d.]+)(ms|s)/i.exec(String(err.message));
  if (m) return m[2] === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
  return null;
}
