import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, resetDb } from "./helpers.ts";

// Harness soati: 2026-10-24 13:00 Toshkent (08:00 UTC).
beforeEach(resetDb);

describe("/settings — AI holati (limit qachon ochilishi)", () => {
  it("kunlik limitda ochilish vaqti, keyin «ochilgan», muvaffaqiyatli so'rovdan keyin «ishlayapti»", async () => {
    const h = makeHarness();
    h.deps.cfg = { ...h.deps.cfg, GROQ_API_KEY: "q", GEMINI_API_KEY: "g" };
    const log = (data: Record<string, unknown>) => h.db.aiUsageLog.create({ data: { kind: "extract", model: "openai/gpt-oss-120b", latencyMs: 1, ok: true, provider: "groq", ...data } });
    await log({ promptTokens: 5000, completionTokens: 2000, createdAt: new Date("2026-10-24T07:00:00Z") });
    await log({ ok: false, errorCode: "rate_limit", limitScope: "day", retryUntil: new Date("2026-10-24T08:31:00Z"), createdAt: new Date("2026-10-24T07:30:00Z") });

    await h.command("settings");
    let text = h.tg.lastText();
    expect(text).toContain("🤖 AI holati");
    expect(text).toContain("Groq: ⏳ kunlik limit tugagan — taxminan 13:31 da ochiladi (31 daqiqadan keyin)");
    expect(text).toContain("24 soatda: 7 000 token / 200 000 (kunlik limit)");
    expect(text).toContain("Gemini: ❔ hali so‘rov bo‘lmagan");
    expect(h.tg.lastKeyboard().flat().some((b) => b.callback_data === "st:ai")).toBe(true);

    h.clock.now = new Date("2026-10-24T08:40:00Z");
    await h.click("st:ai");
    expect(h.tg.lastText()).toContain("Groq: ✅ limit ochilgan bo‘lishi kerak (13:31 dan beri)");

    await log({ createdAt: new Date("2026-10-24T08:45:00Z") });
    await h.click("st:ai");
    expect(h.tg.lastText()).toContain("Groq: ✅ ishlayapti (oxirgi so‘rov: 13:45)");
  });

  it("AI kaliti yo'q bo'lsa bo'lim ko'rsatilmaydi", async () => {
    const h = makeHarness();
    await h.command("settings");
    expect(h.tg.lastText()).toContain("⚙️ Sozlamalar");
    expect(h.tg.lastText()).not.toContain("AI holati");
  });
});
