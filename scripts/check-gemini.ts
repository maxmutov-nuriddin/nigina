/**
 * REAL Gemini integratsiyasini tekshirish (mock emas).
 *
 *   npm run check:gemini                      — kalit, modellar mavjudligi + real NLU (muddatli prezentatsiya misoli)
 *   npm run check:gemini -- --audio voice.ogg — Gemini orqali audio transkripsiyasi
 *
 * Diqqat: skript test matnlarini Gemini'ga yuboradi va natijani konsolga chiqaradi.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { config } from "../src/config.ts";
import { GeminiProvider } from "../src/ai/gemini.ts";
import { Nlu, type NluContext } from "../src/ai/nlu.ts";
import { calendarContext, UZ_WEEKDAYS } from "../src/lib/time.ts";

const args = process.argv.slice(2);
const audioArg = args.includes("--audio") ? args[args.indexOf("--audio") + 1] : undefined;

if (!config.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY sozlanmagan. .env faylga qo'shing: https://aistudio.google.com/apikey");
  process.exit(1);
}
const provider = new GeminiProvider(config, (e) => console.log(`   · ${e.kind} ${e.model} ok=${e.ok} ${e.latencyMs}ms tokens=${e.promptTokens ?? "-"}/${e.completionTokens ?? "-"}${e.errorCode ? ` err=${e.errorCode}` : ""}`));
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "  ✅" : "  ⚠️ "} ${label}`);
  if (!ok) failures++;
};

console.log("\n== Modellar ==");
const res = await fetch(`${config.GEMINI_BASE_URL.replace(/\/+$/, "")}/models`, { headers: { Authorization: `Bearer ${config.GEMINI_API_KEY}` } });
if (!res.ok) {
  console.error(`❌ Gemini /models: HTTP ${res.status} — kalit noto'g'ri yoki API yoqilmagan`);
  process.exit(1);
}
const ids = new Set(((await res.json()) as { data?: Array<{ id: string }> }).data?.map((m) => m.id.replace(/^models\//, "")) ?? []);
for (const m of new Set([config.GEMINI_CHAT_MODEL, config.GEMINI_TRANSCRIPTION_MODEL])) check(ids.has(m), `${m} mavjud`);

if (audioArg) {
  console.log(`\n== Transkripsiya: ${audioArg} ==`);
  const tr = await provider.transcribe({ audio: readFileSync(audioArg), filename: path.basename(audioArg) });
  console.log(`   matn: ${tr.text}`);
  check(tr.text.length > 0, "matn bo'sh emas");
}

console.log("\n== NLU ==");
const now = DateTime.now().setZone(config.DEFAULT_TIMEZONE);
const ctx: NluContext = {
  userId: "check",
  nowLocal: now.toFormat("yyyy-LL-dd'T'HH:mm"),
  weekday: UZ_WEEKDAYS[now.weekday - 1],
  timezone: config.DEFAULT_TIMEZONE,
  language: "ru",
  defaultReminderTime: "09:00",
  calendar: calendarContext(now.toJSDate(), config.DEFAULT_TIMEZONE),
  history: "",
  items: "",
};
const nlu = new Nlu(provider, { maxTokens: config.GROQ_MAX_COMPLETION_TOKENS });
const text = "До 29 числа сделай мне презентацию на тему финансы и поведенческая экономика.";
console.log(`   👤 ${text}`);
const out = await nlu.extract(text, ctx);
for (const a of out.actions) console.log(`   → ${a.intent} | ${a.presentation_topic ?? a.title} | due=${a.due_at} remind=${a.remind_at}`);
check(out.actions.some((a) => a.intent === "create_presentation"), "prezentatsiya so'rovi aniqlandi");
check(out.actions.some((a) => a.due_at?.slice(8, 10) === "29"), "muddat (29-sana) olindi");

console.log(failures ? `\n⚠️  ${failures} ta tekshiruv o'tmadi` : "\n✅ Gemini ishlayapti");
process.exit(failures ? 1 : 0);
