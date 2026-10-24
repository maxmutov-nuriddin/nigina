/**
 * END-TO-END REAL tekshiruv: haqiqiy Groq (asosiy + tahlil kaliti) → butun bot oqimi → TEST bazasi.
 * Telegram soxta (javoblar konsolga chiqadi), baza — nigina_test. Real foydalanuvchiga hech narsa yuborilmaydi.
 *
 *   DATABASE_URL=postgresql://USER@localhost:5432/nigina_test npm run e2e:real
 *
 * Groq free tier (8000 TPM) sababli so'rovlar orasida pauza bor (E2E_DELAY_MS, standart 65000).
 */
import { config } from "../src/config.ts";
import { GroqProvider } from "../src/ai/groq.ts";
import { Nlu } from "../src/ai/nlu.ts";
import { makeHarness, resetDb } from "../tests/helpers.ts";

if (!/test/.test(process.env.DATABASE_URL ?? "")) {
  console.error("❌ Faqat test bazasida ishlaydi: DATABASE_URL=...nigina_test");
  process.exit(1);
}
const delay = Number(process.env.E2E_DELAY_MS ?? 65_000);
const log = (e: { kind: string; ok: boolean; latencyMs: number; promptTokens?: number; completionTokens?: number; errorCode?: string }) =>
  console.log(`      [groq] ${e.kind} ok=${e.ok} ${e.latencyMs}ms ${e.promptTokens ?? "-"}/${e.completionTokens ?? "-"}${e.errorCode ? ` ${e.errorCode}` : ""}`);
const main = new GroqProvider(config, log);
const analysis = new GroqProvider({ ...config, GROQ_API_KEY: config.GROQ_ANALYSIS_API_KEY || config.GROQ_API_KEY, GROQ_CHAT_MODEL: config.GROQ_ANALYSIS_MODEL || config.GROQ_CHAT_MODEL }, log);

await resetDb();
const h = makeHarness({ ai: main, now: new Date().toISOString() });
h.deps.nlu = new Nlu(main, { maxTokens: config.GROQ_MAX_COMPLETION_TOKENS });
h.deps.analysisNlu = new Nlu(analysis);
h.clock.now = new Date();

const steps: Array<[string, () => Promise<unknown>]> = [];
const say = (text: string) => steps.push([`👤 ${text}`, () => h.text(text)]);
const clickFirst = (label: RegExp) =>
  steps.push([`👆 tugma ${label}`, async () => {
    const btn = h.tg.lastKeyboard().flat().find((b) => label.test(b.text));
    if (!btn) return console.log("   (tugma topilmadi)");
    await h.click(btn.callback_data);
  }]);

say("Ertaga ertalab soat to‘qqizda mijozga telefon qilishim kerak. Kechqurun uyga qaytayotganda sut olishni eslat. Juma kuni iqtisodiyotdan prezentatsiya topshiraman.");
clickFirst(/19:00/);
say("Juma kuni innovatsion iqtisodiyotdan topshiriq bor. Startaplarni moliyalashtirish mavzusida o‘zbekcha 10 slaydli prezentatsiya tayyorla. Payshanba soat sakkizda o‘qib chiqishimni eslat.");
say("kechqurun");
say("Ertaga soat uchdagi darsga Aziz kelmaydi. Darsdan yarim soat oldin eslat.");
say("Aziz kelarkan, eslatmani bekor qil");
say(`Xullas, eshit. Ertaga ertalab soat to'qqizda direktor bilan yig'ilish bor, yarim soat oldin eslat. Keyin, ha aytgancha, payshanba kuni soat o'n birda yo'q-yo'q, o'n ikkida bankka borishim kerak, hujjatlarni olib. Juma kuni Malika darsga kelmaydi, dars soat to'rtda. Bugun benzinga 300 ming, telefon uchun 70 ming to'ladim. Shanba kuni onamning tug'ilgan kuni, sovg'a olishni unutmay, juma kechqurun soat sakkizda eslat. Завтра в 15:00 позвонить Алексею по поставке.`);
say("Bugun taksiga 35 ming, bozorga ikki yuz ellik ming so'm ketdi, kechqurun kafeda 120 ming to'ladim. Oylik ham tushdi, 6 yarim million.");
say("Oy oxirida foydaga chiqamanmi yoki zararga? Pulim qayerga ketyapti?");
say("Mijozga qo‘ng‘iroqni ertaga o‘nga sur");
say("Bugun nima ishlarim bor?");

for (const [label, run] of steps) {
  console.log(`\n${label}`);
  const before = h.tg.calls.length;
  const t0 = Date.now();
  await run();
  const out = h.tg.calls.slice(before).filter((c) => ["sendMessage", "editMessageText"].includes(c.method));
  for (const c of out) console.log(`🤖 ${String(c.payload.text).replace(/\n/g, "\n   ")}`);
  const kb = h.tg.lastKeyboard();
  if (out.length && kb.length) console.log(`   [${kb.flat().map((b) => b.text).join("] [")}]`);
  console.log(`   (${Date.now() - t0} ms)`);
  if (!label.startsWith("👆")) await new Promise((r) => setTimeout(r, delay));
}

console.log("\n== Baza ==");
console.log("tasks:", (await h.db.task.findMany({ orderBy: { createdAt: "asc" } })).map((x) => `${x.title}[${x.status}]`).join(" | "));
console.log("notes:", (await h.db.note.findMany()).map((x) => `${x.title}[${x.status}]`).join(" | "));
console.log("reminders:", (await h.db.reminder.findMany({ orderBy: { fireAt: "asc" } })).map((x) => `${x.text.slice(0, 30)}@${x.fireAt.toISOString()}[${x.status}]`).join(" | "));
console.log("transactions:", (await h.db.transaction.findMany()).map((x) => `${x.kind}:${x.amount}:${x.category}`).join(" | "));
console.log("presentations:", (await h.db.presentation.findMany()).map((x) => `${x.topic}[${x.status}]`).join(" | "));
process.exit(0);
