import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { GeminiProvider } from "../src/ai/gemini.ts";
import { FallbackProvider } from "../src/ai/fallback.ts";
import { createAiProviders } from "../src/ai/factory.ts";
import { AiError, type AiProvider, type JsonRequest } from "../src/ai/provider.ts";

const Schema = z.object({ answer: z.string() });
const req: JsonRequest<z.infer<typeof Schema>> = { kind: "test", system: "sys", user: "salom", schema: Schema, schemaName: "answer" };
const cfg = (env: Record<string, string> = {}) => loadConfig({ ...process.env, GEMINI_API_KEY: "g-key", GROQ_API_KEY: "", ...env });

const okJson = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

/** Soxta provayder — chaqiruvlarni yozib boradi */
class StubProvider implements AiProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private configured = true,
    private result: () => unknown = () => ({ answer: name }),
  ) {}
  isConfigured() {
    return this.configured;
  }
  async transcribe() {
    this.calls++;
    return { text: this.name, language: null, durationSec: null, avgLogprob: null };
  }
  async completeJson<T>(): Promise<T> {
    this.calls++;
    return this.result() as T;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Gemini provayderi", () => {
  it("OpenAI-mos endpoint'ga json_schema bilan so'rov yuboradi va javobni Zod bilan tekshiradi", async () => {
    const fetchMock = vi.fn(async () => okJson('{"answer":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);
    const g = new GeminiProvider(cfg());
    expect(await g.completeJson(req)).toEqual({ answer: "ok" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer g-key");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gemini-3.8-flash");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.required).toEqual(["answer"]);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("sxemaga mos kelmasa bir marta tuzatish so'raydi; ```json``` o'ramini qabul qiladi", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson('{"wrong":1}')).mockResolvedValueOnce(okJson('```json\n{"answer":"fixed"}\n```'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new GeminiProvider(cfg()).completeJson(req)).toEqual({ answer: "fixed" });
    const second = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(second.messages.at(-1).content).toContain("sxemaga mos emas");
  });

  it("429 — rate_limit va Google retryDelay soniyalari", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"details":[{"retryDelay":"42s"}]}}', { status: 429 })));
    const err = await new GeminiProvider(cfg()).completeJson(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterSec).toBe(42);
  });

  it("boshqa provayder modeli (GROQ_PRESENTATION_MODEL) berilsa — Gemini o'z modelini ishlatadi", async () => {
    const fetchMock = vi.fn(async () => okJson('{"answer":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);
    await new GeminiProvider(cfg()).completeJson({ ...req, model: "openai/gpt-oss-120b" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("gemini-3.8-flash");
  });
});

describe("Zaxira provayder (Gemini → Groq)", () => {
  it("birinchisi limitga tushsa — keyingisiga o'tadi", async () => {
    const first = new StubProvider("gemini", true, () => {
      throw new AiError("rate_limit", "x", true, 60);
    });
    const second = new StubProvider("groq");
    expect(await new FallbackProvider([first, second]).completeJson(req)).toEqual({ answer: "groq" });
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it("so'rov xatosida (bad_request) boshqasiga o'tilmaydi", async () => {
    const first = new StubProvider("gemini", true, () => {
      throw new AiError("bad_request", "x", false);
    });
    const second = new StubProvider("groq");
    await expect(new FallbackProvider([first, second]).completeJson(req)).rejects.toMatchObject({ code: "bad_request" });
    expect(second.calls).toBe(0);
  });

  it("kaliti yo'q provayder chaqirilmaydi; hech qaysi sozlanmagan bo'lsa — not_configured", async () => {
    const gemini = new StubProvider("gemini", false);
    const groq = new StubProvider("groq");
    expect(await new FallbackProvider([gemini, groq]).completeJson(req)).toEqual({ answer: "groq" });
    expect(gemini.calls).toBe(0);
    await expect(new FallbackProvider([new StubProvider("a", false)]).completeJson(req)).rejects.toMatchObject({ code: "not_configured" });
  });

  it("factory: GEMINI_API_KEY bo'lsa matn Gemini'da, bo'lmasa faqat Groq", () => {
    expect(createAiProviders(cfg({ GROQ_API_KEY: "q" })).ai.name).toBe("gemini+groq");
    expect(createAiProviders(cfg({ GROQ_API_KEY: "q", AI_PRIMARY: "groq" })).ai.name).toBe("groq+gemini");
    expect(createAiProviders(cfg({ GROQ_API_KEY: "q", GEMINI_API_KEY: "" })).ai.name).toBe("groq");
  });
});
