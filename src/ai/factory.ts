import type { Config } from "../config.ts";
import { FallbackProvider } from "./fallback.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import type { AiProvider, UsageEvent } from "./provider.ts";

/**
 * AI provayderlarini env bo'yicha yig'adi:
 *  - GEMINI_API_KEY bor → matn (NLU, prezentatsiya, tahlil) Gemini'da, limit/xatoda Groq'ga o'tadi (AI_PRIMARY=groq — teskarisi);
 *  - GEMINI_API_KEY yo'q → hammasi Groq'da, avvalgidek;
 *  - ovoz: Groq Whisper asosiy, Gemini zaxira.
 */
export function createAiProviders(cfg: Config, onUsage: (e: UsageEvent) => void = () => {}): { ai: AiProvider; analysisAi: AiProvider } {
  const gemini = new GeminiProvider(cfg, onUsage);
  const groq = new GroqProvider(cfg, onUsage, cfg.GROQ_FALLBACK_TO_ANALYSIS_KEY ? cfg.GROQ_ANALYSIS_API_KEY : undefined);
  // Fondagi moliyaviy tahlil — alohida Groq akkaunt kaliti (rate limit asosiy so'rovlarga ta'sir qilmasin)
  const groqAnalysis = new GroqProvider(
    { ...cfg, GROQ_API_KEY: cfg.GROQ_ANALYSIS_API_KEY || cfg.GROQ_API_KEY, GROQ_CHAT_MODEL: cfg.GROQ_ANALYSIS_MODEL || cfg.GROQ_CHAT_MODEL },
    onUsage,
    undefined,
    // Alohida kalit bo'lsa — alohida limit; bo'lmasa asosiy Groq kaliti bilan bir xil
    cfg.GROQ_ANALYSIS_API_KEY && cfg.GROQ_ANALYSIS_API_KEY !== cfg.GROQ_API_KEY ? "groq:analysis" : "groq",
  );
  const geminiFirst = cfg.AI_PRIMARY === "gemini";
  return {
    ai: new FallbackProvider(geminiFirst ? [gemini, groq] : [groq, gemini], [groq, gemini]),
    analysisAi: new FallbackProvider(geminiFirst ? [gemini, groqAnalysis] : [groqAnalysis, gemini]),
  };
}
