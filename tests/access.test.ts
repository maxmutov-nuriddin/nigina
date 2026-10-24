import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, resetDb } from "./helpers.ts";

beforeEach(resetDb);

// Asosiy foydalanuvchi — 1; yangi odam — 2
const OWNER = { OWNER_CHAT_ID: "1" };

describe("Botga kirish so'rovlari (asosiy foydalanuvchi ruxsat beradi)", () => {
  it("ruxsatsiz /start → so'rov; asosiy foydalanuvchi ro'yxatda ko'radi, ruxsat beradi; odamga xabar boradi", async () => {
    const h = makeHarness({ cfg: OWNER });

    // Ruxsatsiz oddiy xabar — e'tiborsiz, bazaga yozilmaydi
    await h.text("salom", 2);
    expect(h.tg.sent("sendMessage")).toHaveLength(0);

    // /start — so'rov saqlanadi, qisqa javob
    await h.command("start", 2);
    expect(h.tg.lastText()).toContain("so‘rovingiz yuborildi");
    expect((await h.db.accessRequest.findUniqueOrThrow({ where: { telegramUserId: 2n } })).status).toBe("pending");
    expect(await h.db.user.count()).toBe(0);

    // Asosiy foydalanuvchi: /settings → «Yangi so'rovlar (1)»
    await h.command("settings", 1);
    const btn = h.tg.lastKeyboard().flat().find((b) => b.callback_data === "ad:list");
    expect(btn?.text).toBe("📥 Yangi so‘rovlar (1)");

    await h.click("ad:list", 1);
    expect(h.tg.lastText()).toContain("📥 Botga /start bosganlar");
    expect(h.tg.lastText()).toContain("User2 — ⏳ ruxsat kutmoqda");
    expect(h.tg.lastKeyboard()[0][0]).toEqual({ text: "✅ Ruxsat berish — User2", callback_data: "ad:ok:2" });

    // Ruxsat berish — odamga xabar boradi, ro'yxat yangilanadi
    await h.click("ad:ok:2", 1);
    const toUser = h.tg.sent("sendMessage").filter((c) => Number(c.payload.chat_id) === 2).at(-1);
    expect(toUser?.payload.text).toBe("✅ Sizga botdan foydalanishga ruxsat berildi. Boshlash uchun /start ni bosing.");
    expect((await h.db.accessRequest.findUniqueOrThrow({ where: { telegramUserId: 2n } })).status).toBe("approved");
    expect(h.tg.answers().at(-1)).toContain("User2: ruxsat berildi");

    // Endi u botdan foydalana oladi
    await h.command("start", 2);
    expect(h.tg.lastText()).toContain("Assalomu alaykum");
    expect(await h.db.user.count({ where: { telegramUserId: 2n } })).toBe(1);
  });

  it("asosiy foydalanuvchi bo'lmagan odam so'rovlarni ko'ra olmaydi va tugma chiqmaydi", async () => {
    const h = makeHarness({ cfg: { ...OWNER, ALLOWED_CHAT_IDS: "3" } });
    await h.command("settings", 3);
    expect(h.tg.lastKeyboard().flat().some((b) => b.callback_data === "ad:list")).toBe(false);
    await h.click("ad:list", 3);
    expect(h.tg.answers().at(-1)).toContain("eskirgan");
  });

  it("asosiy foydalanuvchining o'zi doim kira oladi; so'rov bo'lmasa tugma raqamsiz", async () => {
    const h = makeHarness({ cfg: OWNER });
    await h.command("start", 1);
    expect(h.tg.lastText()).toContain("Assalomu alaykum");
    await h.command("settings", 1);
    expect(h.tg.lastKeyboard().flat().find((b) => b.callback_data === "ad:list")?.text).toBe("📥 Yangi so‘rovlar");
  });
});
