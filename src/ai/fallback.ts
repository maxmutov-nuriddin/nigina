import { logger } from "../logger.ts";
import { AiError, type AiProvider, type JsonRequest, type TranscriptionResult } from "./provider.ts";

/** Keyingi provayderga o'tish mumkin bo'lgan xatolar (so'rovning o'zi noto'g'ri bo'lsa — o'tilmaydi) */
const SWITCHABLE = new Set(["rate_limit", "unavailable", "timeout", "auth", "not_configured"]);

/**
 * Bir nechta provayderni tartib bilan sinaydi: birinchisi limitga tushsa, ishlamasa yoki kaliti noto'g'ri bo'lsa — keyingisi.
 * Sozlanmagan (kaliti yo'q) provayderlar umuman chaqirilmaydi.
 */
export class FallbackProvider implements AiProvider {
  readonly name: string;

  constructor(
    private chatOrder: AiProvider[],
    private transcribeOrder: AiProvider[] = chatOrder,
  ) {
    this.name = chatOrder.filter((p) => p.isConfigured()).map((p) => p.name).join("+") || "none";
  }

  isConfigured(): boolean {
    return this.chatOrder.some((p) => p.isConfigured()) || this.transcribeOrder.some((p) => p.isConfigured());
  }

  transcribe(input: Parameters<AiProvider["transcribe"]>[0]): Promise<TranscriptionResult> {
    return this.run(this.transcribeOrder, "transcribe", (p) => p.transcribe(input));
  }

  completeJson<T>(req: JsonRequest<T>): Promise<T> {
    return this.run(this.chatOrder, req.kind, (p) => p.completeJson(req));
  }

  private async run<R>(order: AiProvider[], kind: string, fn: (p: AiProvider) => Promise<R>): Promise<R> {
    const active = order.filter((p) => p.isConfigured());
    if (!active.length) throw new AiError("not_configured", "AI kaliti sozlanmagan (GEMINI_API_KEY yoki GROQ_API_KEY)", false);
    let last: AiError | null = null;
    for (let i = 0; i < active.length; i++) {
      try {
        return await fn(active[i]);
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError("unavailable", String(err), true);
        if (!SWITCHABLE.has(e.code) || i === active.length - 1) throw e;
        logger.info({ kind, from: active[i].name, to: active[i + 1].name, code: e.code }, "AI provayder ishlamadi — zaxirasiga o'tilmoqda");
        last = e;
      }
    }
    throw last ?? new AiError("unavailable", "AI provayderlar ishlamadi", true);
  }
}
