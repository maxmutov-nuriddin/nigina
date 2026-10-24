import type { Config } from "../config.ts";
import { logger, safeError } from "../logger.ts";
import { AiError, type AiProvider, type JsonRequest, type TranscriptionResult, type UsageEvent } from "./provider.ts";
import { toStrictJsonSchema } from "./schemas.ts";

/**
 * Google Gemini integratsiyasi — rasmiy OpenAI-mos endpoint orqali (hujjat: ai.google.dev/gemini-api/docs/openai, 2026-10-24):
 *  - Chat: POST {GEMINI_BASE_URL}/chat/completions, response_format json_schema, Authorization: Bearer <kalit>
 *  - Audio: user xabarida { type: "input_audio", input_audio: { data: base64, format } } (so'rov hajmi ≤ 20 MB)
 * Model nomlari faqat env orqali keladi. Javob Zod bilan qayta tekshiriladi, mos kelmasa 1 marta "tuzatish" so'rovi.
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";

  constructor(
    private cfg: Config,
    private onUsage: (e: UsageEvent) => void = () => {},
  ) {}

  isConfigured(): boolean {
    return !!this.cfg.GEMINI_API_KEY;
  }

  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    if (!this.cfg.GEMINI_API_KEY) throw new AiError("not_configured", "GEMINI_API_KEY sozlanmagan", false);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.GEMINI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.GEMINI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.GEMINI_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new AiError("timeout", "Gemini timeout", true);
      throw new AiError("unavailable", `Gemini bilan aloqa yo'q: ${safeError(err)}`, true);
    }
    if (!res.ok) throw await mapHttpError(res);
    return (await res.json()) as ChatResponse;
  }

  async transcribe(input: { audio: Buffer; filename: string; language?: string; prompt?: string; userId?: string }): Promise<TranscriptionResult> {
    const model = this.cfg.GEMINI_TRANSCRIPTION_MODEL;
    const started = Date.now();
    const format = (input.filename.split(".").pop() ?? "ogg").toLowerCase().replace("oga", "ogg");
    const instruction =
      "Transcribe the speech in this audio verbatim. Speakers use Uzbek (Latin script), Russian, or a mix — keep each word in the language it was spoken. " +
      "Output only the transcript text, nothing else." +
      (input.language ? ` Main language: ${input.language}.` : "") +
      (input.prompt ? ` Spelling hints: ${input.prompt}` : "");
    try {
      const res = await this.post({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              { type: "input_audio", input_audio: { data: input.audio.toString("base64"), format } },
            ],
          },
        ],
      });
      const text = (res.choices?.[0]?.message?.content ?? "").trim();
      this.onUsage({ userId: input.userId, kind: "transcribe", model, promptTokens: res.usage?.prompt_tokens, completionTokens: res.usage?.completion_tokens, latencyMs: Date.now() - started, ok: true, provider: this.name });
      return { text, language: null, durationSec: null, avgLogprob: null };
    } catch (err) {
      const e = err instanceof AiError ? err : new AiError("unavailable", safeError(err), true);
      this.onUsage({ userId: input.userId, kind: "transcribe", model, latencyMs: Date.now() - started, ok: false, errorCode: e.code, provider: this.name, retryAfterSec: e.retryAfterSec, limitScope: e.limitScope });
      throw e;
    }
  }

  async completeJson<T>(req: JsonRequest<T>): Promise<T> {
    // GROQ_PRESENTATION_MODEL kabi boshqa provayder modeli kelsa — Gemini o'z modelidan foydalanadi
    const model = req.model?.startsWith("gemini") ? req.model : this.cfg.GEMINI_CHAT_MODEL;
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    const jsonSchema = toStrictJsonSchema(req.schema);

    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      let content: string | null | undefined;
      try {
        const res = await this.post({
          model,
          messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? this.cfg.GROQ_MAX_COMPLETION_TOKENS,
          ...(this.cfg.GEMINI_REASONING_EFFORT ? { reasoning_effort: this.cfg.GEMINI_REASONING_EFFORT } : {}),
          response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: jsonSchema } },
        });
        content = res.choices?.[0]?.message?.content;
        this.onUsage({ userId: req.userId, kind: req.kind, model, promptTokens: res.usage?.prompt_tokens, completionTokens: res.usage?.completion_tokens, latencyMs: Date.now() - started, ok: true, provider: this.name });
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError("unavailable", safeError(err), true);
        this.onUsage({ userId: req.userId, kind: req.kind, model, latencyMs: Date.now() - started, ok: false, errorCode: e.code, provider: this.name, retryAfterSec: e.retryAfterSec, limitScope: e.limitScope });
        throw e;
      }

      let parsed: unknown;
      try {
        // Ba'zan JSON ```json ... ``` ichida keladi
        parsed = JSON.parse((content ?? "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
      } catch {
        parsed = undefined;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return result.data;

      logger.warn({ kind: req.kind, attempt, provider: "gemini", issues: result.error?.issues.slice(0, 5).map((i) => i.path.join(".")) }, "AI javobi sxemaga mos emas");
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

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** HTTP xatosini AiError'ga aylantiradi. Xabar matni loglanmaydi (unda so'rov mazmuni bo'lishi mumkin) — faqat status. */
async function mapHttpError(res: Response): Promise<AiError> {
  const status = res.status;
  let body = "";
  try {
    body = await res.text();
  } catch {
    // ahamiyatsiz
  }
  if (status === 429) {
    const wait = retryAfterSec(res, body);
    // Google kvota nomida davr bo'ladi: "...PerDay...", "...PerMinute..." (so'rov mazmuni yo'q)
    const scope = /PerDay|per day/i.test(body) ? "day" : /PerMinute|per minute/i.test(body) ? "minute" : wait !== null && wait > 120 ? "day" : "minute";
    return new AiError("rate_limit", "Gemini rate limit", true, wait, scope);
  }
  if (status === 401 || status === 403) return new AiError("auth", `Gemini auth xatosi (${status})`, false);
  if (status === 400 || status === 404 || status === 422) return new AiError("bad_request", `Gemini so'rov xatosi (${status})`, false);
  return new AiError("unavailable", `Gemini server xatosi (${status})`, true);
}

/** retry-after sarlavhasi yoki Google RetryInfo ("retryDelay": "30s") */
function retryAfterSec(res: Response, body: string): number | null {
  const header = res.headers.get("retry-after");
  if (header && Number.isFinite(Number(header))) return Math.ceil(Number(header));
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  return m ? Math.ceil(Number(m[1])) : null;
}
