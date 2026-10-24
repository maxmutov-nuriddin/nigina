import { beforeEach, describe, expect, it } from "vitest";
import { a, makeHarness, resetDb } from "./helpers.ts";
import { computeFromTransactions, money } from "../src/finance/analytics.ts";
import { FinanceAnalyzer } from "../src/finance/background.ts";
import { splitText } from "../src/messenger.ts";

const TZ = "Asia/Tashkent";
const at = (iso: string) => new Date(iso);
const tx = (kind: "expense" | "income", amount: number, category: string, iso: string, currency = "UZS") => ({ kind, amount, category, currency, occurredAt: at(iso) });

describe("Moliyaviy hisob-kitob (sof funksiya)", () => {
  // 2026-10-11 00:00 Toshkent — oydan aniq 10 kun o'tgan, 21 kun qolgan
  const NOW = at("2026-10-10T19:00:00Z");

  it("oy oxiri prognozi: o'zgaruvchan xarajat sur'ati + kutilayotgan majburiy to'lovlar + daromad o'rtachasi", () => {
    const current = [
      tx("income", 3_000_000, "salary", "2026-10-01T05:00:00Z"),
      tx("expense", 2_000_000, "housing", "2026-10-01T06:00:00Z"),
      tx("expense", 100_000, "food", "2026-10-02T06:00:00Z"),
      tx("expense", 50_000, "transport", "2026-10-05T06:00:00Z"),
      tx("expense", 20, "food", "2026-10-05T06:00:00Z", "USD"),
    ];
    const history = [
      tx("income", 4_000_000, "salary", "2026-09-01T05:00:00Z"),
      tx("expense", 100_000, "food", "2026-09-03T06:00:00Z"),
      tx("expense", 300_000, "utilities", "2026-09-20T06:00:00Z"),
    ];
    const s = computeFromTransactions("this_month", "UZS", NOW, TZ, current, history);
    expect(s.income).toBe(3_000_000);
    expect(s.expense).toBe(2_150_000);
    expect(s.net).toBe(850_000);
    expect(s.otherCurrencies).toEqual([{ currency: "USD", count: 1 }]);
    expect(s.month!.daysElapsed).toBe(10);
    expect(s.month!.avgDailyExpense).toBe(15_000); // majburiy to'lov sur'atga qo'shilmaydi
    // 2 150 000 + 15 000×21 + kommunal 300 000 (o'tgan oyda bor, bu oy hali yo'q)
    expect(s.month!.forecast.expectedFixed).toBe(300_000);
    expect(s.month!.forecast.expense).toBe(2_765_000);
    expect(s.month!.forecast.income).toBe(4_000_000);
    expect(s.month!.forecast.incomeFromAverage).toBe(true);
    expect(s.month!.forecast.net).toBe(1_235_000);
    expect(s.month!.prev!.expenseSamePoint).toBe(100_000);
    expect(s.expenseByCategory[0]).toMatchObject({ category: "housing", total: 2_000_000 });
  });

  it("daromadsiz oy — zarar prognozi", () => {
    const s = computeFromTransactions("this_month", "UZS", NOW, TZ, [tx("expense", 200_000, "food", "2026-10-03T06:00:00Z")]);
    expect(s.month!.forecast.expense).toBe(620_000);
    expect(s.month!.forecast.net).toBe(-620_000);
    expect(s.month!.paceVsPrev).toBeNull();
  });

  it("pul formati", () => {
    expect(money(1_250_000, "UZS")).toBe("1 250 000 so‘m");
    expect(money(-620_000, "UZS")).toBe("−620 000 so‘m");
    expect(money(850_000, "UZS", "uz", true)).toBe("+850 000 so‘m");
    expect(money(12.5, "USD", "ru")).toBe("12,50 $");
  });
});

beforeEach(resetDb);

describe("Moliya oqimlari", () => {
  const expenses = () =>
    ({
      reply: null,
      actions: [
        a("record_transaction", { transaction_kind: "expense", amount: 30_000, finance_category: "transport", description: "taksi" }),
        a("record_transaction", { transaction_kind: "expense", amount: 250_000, finance_category: "food", description: "bozor" }),
      ],
    });

  it("bitta xabardan bir nechta xarajat + oylik qisqa holat", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => expenses();
    await h.text("Taksiga 30 ming, bozorga 250 ming ketdi");
    const rows = await h.db.transaction.findMany({ orderBy: { actionIndex: "asc" } });
    expect(rows.map((r) => [r.kind, r.amount.toNumber(), r.category, r.currency])).toEqual([
      ["expense", 30_000, "transport", "UZS"],
      ["expense", 250_000, "food", "UZS"],
    ]);
    const reply = h.tg.lastText();
    expect(reply).toContain("💸 Xarajat: 30 000 so‘m — Transport (taksi)");
    expect(reply).toContain("💸 Xarajat: 250 000 so‘m — Oziq-ovqat (bozor)");
    expect(reply).toContain("📊 oktabr 2026: xarajat 280 000 so‘m · daromad 0 so‘m · balans −280 000 so‘m");
    expect(await h.db.task.count()).toBe(0);
  });

  it("summa yetishmasa so'raydi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("record_transaction", { transaction_kind: "expense", finance_category: "health", description: "dori" })] });
    await h.text("Dorixonaga pul ketdi");
    expect(h.tg.lastText()).toContain("Summasi qancha edi?");
    h.ai.onResolve = (pending) => ({ relates: true, actions: [{ ...pending[0], amount: 45_000, missing_fields: [] }] });
    await h.text("45 ming");
    expect((await h.db.transaction.findFirstOrThrow()).amount.toNumber()).toBe(45_000);
  });

  it("hisobot: prognoz + fondagi tahlil izohi (alohida AI kaliti), keshlanadi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => expenses();
    await h.text("x");
    h.ai.onExtract = () => ({ reply: null, actions: [a("record_transaction", { transaction_kind: "income", amount: 6_000_000, finance_category: "salary", description: "oylik" })] });
    await h.text("Oylik tushdi 6 mln");

    h.ai.onExtract = () => ({ reply: null, actions: [a("finance_report", { finance_period: "this_month" })] });
    await h.text("Oy oxirida foydadamanmi?");
    const reply = h.tg.lastText();
    expect(reply).toContain("📊 Moliya — oktabr 2026");
    expect(reply).toContain("💰 Daromad: 6 000 000 so‘m");
    expect(reply).toContain("🔮 Oy oxiri prognozi");
    expect(reply).toMatch(/Natija: ✅ foyda ~/);
    expect(reply).toContain("🤖 Tahlil:\n• Eng ko‘p xarajat oziq-ovqatga ketmoqda.");
    // Tahlil asosiy emas, "analysis" provider orqali
    expect(h.analysisAi.calls).toEqual(["finance_insight"]);
    expect(h.ai.calls).not.toContain("finance_insight");

    // Yangi yozuv yo'q — qayta hisoblanmaydi (AI chaqirilmaydi)
    await h.command("finance");
    expect(h.analysisAi.calls).toHaveLength(1);
    // Yangi xarajat — snapshot yangilanadi
    h.ai.onExtract = () => ({ reply: null, actions: [a("record_transaction", { transaction_kind: "expense", amount: 10_000, finance_category: "cafe" })] });
    await h.text("Kofega 10 ming");
    await h.command("finance");
    expect(h.analysisAi.calls).toHaveLength(2);

    // Davr tugmasi
    await h.click("fr:today");
    expect(h.tg.lastText()).toContain("📊 Moliya — bugun");
  });

  it("tahlil AI ishlamasa — raqamlar baribir ko'rsatiladi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => expenses();
    await h.text("x");
    h.analysisAi.failNext.finance_insight = new (await import("../src/ai/provider.ts")).AiError("rate_limit", "x", true);
    await h.command("finance");
    expect(h.tg.lastText()).toContain("💸 Xarajat: 280 000 so‘m");
    expect(h.tg.lastText()).not.toContain("🤖 Tahlil");
  });

  it("fondagi tahlilchi: zarar kutilsa oyiga bir marta ogohlantiradi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: [1, 2, 3, 4, 5].map((i) => a("record_transaction", { transaction_kind: "expense", amount: 100_000 * i, finance_category: "food" })),
    });
    await h.text("x");
    h.tg.reset();
    const analyzer = new FinanceAnalyzer(h.deps);
    expect(await analyzer.tick()).toBe(1);
    const alerts = h.tg.texts().filter((t) => t.includes("Moliyaviy ogohlantirish"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("zarar bo‘lishi mumkin");
    h.ai.onExtract = () => ({ reply: null, actions: [a("record_transaction", { transaction_kind: "expense", amount: 5_000, finance_category: "food" })] });
    await h.text("yana");
    await analyzer.tick();
    expect(h.tg.texts().filter((t) => t.includes("Moliyaviy ogohlantirish"))).toHaveLength(1);
  });

  it("oxirgi xarajatni o'chirish va summani tuzatish", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => expenses();
    await h.text("x");
    h.ai.onExtract = (c) => ({ reply: null, actions: [a("update_item", { update_op: "edit", related_item_id: c.findRef(/taksi/), amount: 35_000 })] });
    await h.text("Taksi 35 ming edi");
    expect(h.tg.lastText()).toContain("✏️ Yangilandi: 💸 Xarajat: 35 000 so‘m — Transport (taksi)");
    h.ai.onExtract = (c) => ({ reply: null, actions: [a("update_item", { update_op: "cancel", related_item_id: c.findRef(/bozor/) })] });
    await h.text("Bozor xarajatini o'chir");
    expect(h.tg.lastText()).toContain("🗑 O‘chirildi");
    expect((await h.db.transaction.findMany()).map((r) => r.amount.toNumber())).toEqual([35_000]);
  });

  it("boshqa foydalanuvchi moliyasi ko'rinmaydi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => expenses();
    await h.text("x", 1);
    await h.command("finance");
    h.tg.reset();
    await h.text("💰 Moliya", 2);
    expect(h.tg.lastText()).toContain("moliyaviy yozuvlar yo‘q");
  });
});

describe("Kirish cheklovi (ALLOWED_CHAT_IDS)", () => {
  it("faqat ruxsat berilgan chat ishlaydi; boshqasiga javob yo'q va bazaga yozilmaydi", async () => {
    const h = makeHarness({ cfg: { ALLOWED_CHAT_IDS: "1" } });
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { title: "Vazifa" })] });
    await h.text("vazifa", 2);
    await h.command("start");
    expect(await h.db.user.count()).toBe(1);
    expect(h.tg.sent("sendMessage").every((c) => c.payload.chat_id === 1)).toBe(true);
    await h.click("st:del", 2);
    expect(h.tg.sent("sendMessage").filter((c) => c.payload.chat_id === 2)).toHaveLength(0);
    await h.text("vazifa", 1);
    expect(await h.db.task.count()).toBe(1);
  });

  it("cheklovdan oldin yaratilgan begona foydalanuvchiga eslatma yuborilmaydi", async () => {
    const open = makeHarness();
    open.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { title: "Eski", remind_at: "2026-10-24T14:00" })] });
    await open.text("x", 2);
    const h = makeHarness({ cfg: { ALLOWED_CHAT_IDS: "1" }, clock: open.clock });
    h.clock.set("2026-10-24T09:00:10Z");
    expect(await h.scheduler.tick()).toBe(0);
    expect((await h.db.reminder.findFirstOrThrow()).lastError).toBe("chat_not_allowed");
  });
});

describe("Katta so'rovlar", () => {
  it("ko'p amalli javob Telegram chegarasidan oshsa bo'laklab yuboriladi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: Array.from({ length: 40 }, (_, i) =>
        a("create_task", { category: "work", title: `Juda muhim vazifa raqami ${i + 1} — mijoz bilan batafsil kelishuv va hujjatlar`, event_at: "2026-10-25T10:00", remind_at: "2026-10-25T10:00" }),
      ),
    });
    await h.text("katta xabar");
    expect(await h.db.task.count()).toBe(40);
    const msgs = h.tg.sent("sendMessage");
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => String(m.payload.text).length <= 4096)).toBe(true);
    expect(msgs.map((m) => m.payload.text).join("\n")).toContain("40. 💼 Ish: Juda muhim vazifa raqami 40");
  });

  it("splitText qatorlarni buzmasdan bo'laklaydi", () => {
    const text = Array.from({ length: 300 }, (_, i) => `qator ${i}`).join("\n");
    const parts = splitText(text, 500);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
});
