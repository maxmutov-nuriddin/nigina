import type { z } from "zod";

export interface TranscriptionResult {
  text: string;
  language: string | null;
  durationSec: number | null;
  /** Segmentlarning o'rtacha log-ehtimoli — past bo'lsa transkripsiya ishonchsiz */
  avgLogprob: number | null;
}

export interface JsonRequest<T> {
  kind: string;
  userId?: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface UsageEvent {
  userId?: string;
  kind: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  audioSeconds?: number;
  latencyMs: number;
  ok: boolean;
  errorCode?: string;
  /** groq | groq:analysis | gemini */
  provider?: string;
  /** Limit xatosida: necha soniyadan keyin ochiladi */
  retryAfterSec?: number | null;
  limitScope?: LimitScope | null;
}

export type LimitScope = "day" | "minute";

export type AiErrorCode = "not_configured" | "auth" | "rate_limit" | "timeout" | "unavailable" | "bad_request" | "bad_output";

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public retryable: boolean,
    /** Limitda: Groq aytgan kutish vaqti (soniya) — kunlik limitda daqiqalar/soatlar bo'lishi mumkin */
    public retryAfterSec: number | null = null,
    /** Limit turi: kunlik (TPD/RPD) yoki daqiqalik (TPM/RPM) */
    public limitScope: LimitScope | null = null,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** Boshqa provider qo'shish uchun shu interfeysni implement qilish kifoya. */
export interface AiProvider {
  readonly name: string;
  isConfigured(): boolean;
  transcribe(input: { audio: Buffer; filename: string; language?: string; prompt?: string; userId?: string }): Promise<TranscriptionResult>;
  completeJson<T>(req: JsonRequest<T>): Promise<T>;
}
