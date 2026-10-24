import { GrammyError, HttpError, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { loadConfig } from "../src/config.ts";
import { createDb, type Db } from "../src/db.ts";
import { AiError, type AiProvider, type JsonRequest, type TranscriptionResult } from "../src/ai/provider.ts";
import { Nlu } from "../src/ai/nlu.ts";
import { emptyAction, type AiAction, type Deck, type Extraction, type Outline, type Resolution } from "../src/ai/schemas.ts";
import { Messenger } from "../src/messenger.ts";
import type { Deps } from "../src/deps.ts";
import { createBot } from "../src/bot/bot.ts";
import { ReminderScheduler } from "../src/reminders/scheduler.ts";

export { emptyAction };
export const a = emptyAction;

// ---------------- Soxta AI ----------------

export interface ExtractCtx {
  message: string;
  context: string;
  /** ITEMS bo'limidan ref topish: findRef(/Aziz/) → "N1" */
  findRef: (re: RegExp) => string | null;
  findRefs: (re: RegExp) => string[];
}

/**
 * Groq o'rnini bosuvchi skriptlangan provider. Bu MOCK — real Groq integratsiyasi tekshirilganini anglatmaydi.
 * Har bir javob haqiqiy Zod sxemasi orqali tekshiriladi (provider shartnomasi saqlanadi).
 */
export class FakeAi implements AiProvider {
  readonly name = "fake";
  transcript = "";
  calls: string[] = [];
  failNext: Partial<Record<string, AiError>> = {};
  onExtract: (c: ExtractCtx) => Extraction = () => ({ actions: [], reply: "salom" });
  onResolve: (pending: AiAction[], question: string, answer: string, c: ExtractCtx) => Resolution = () => ({ relates: false, actions: [] });
  onOutline: () => Outline = () => defaultOutline();
  onDeck: () => Deck = () => defaultDeck();
  onInsight: (stats: unknown) => { insights: string[] } = () => ({ insights: ["Eng ko‘p xarajat oziq-ovqatga ketmoqda."] });

  isConfigured() {
    return true;
  }

  async transcribe(): Promise<TranscriptionResult> {
    this.calls.push("transcribe");
    const err = this.failNext.transcribe;
    if (err) {
      delete this.failNext.transcribe;
      throw err;
    }
    return { text: this.transcript, language: "uz", durationSec: 5, avgLogprob: -0.3 };
  }

  async completeJson<T>(req: JsonRequest<T>): Promise<T> {
    this.calls.push(req.kind);
    const err = this.failNext[req.kind];
    if (err) {
      delete this.failNext[req.kind];
      throw err;
    }
    const c = ctxFrom(req.user);
    let out: unknown;
    if (req.kind === "extract") out = this.onExtract(c);
    else if (req.kind === "resolve") {
      const pending = JSON.parse(/PENDING_ACTIONS:\n(.*)\n\nQUESTION:/s.exec(req.user)![1]) as AiAction[];
      const question = /QUESTION: (.*)\n/.exec(req.user)![1];
      out = this.onResolve(pending, question, c.message, c);
    } else if (req.kind === "presentation_outline") out = this.onOutline();
    else if (req.kind === "presentation_content") out = this.onDeck();
    else if (req.kind === "finance_insight") out = this.onInsight(JSON.parse(req.user.replace(/^STATS \(JSON\):\n/, "")));
    return req.schema.parse(out);
  }
}

function ctxFrom(user: string): ExtractCtx {
  const message = (/<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "").trim();
  const items = /ITEMS:\n([\s\S]*?)(\n\n|$)/.exec(user)?.[1] ?? "";
  const lines = items.split("\n");
  const findRefs = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => l.split(" | ")[0]);
  return { message, context: user, findRef: (re) => findRefs(re)[0] ?? null, findRefs };
}

export function defaultOutline(n = 4): Outline {
  const layouts = ["bullets", "process", "table", "conclusion"] as const;
  return { title: "Startaplarni moliyalashtirish", subtitle: "Taqdimot", slides: Array.from({ length: n }, (_, i) => ({ title: `Slayd ${i + 1}`, layout: layouts[Math.min(i, 3)], key_points: ["a"] })) };
}

export function defaultDeck(): Deck {
  const base = { bullets: [], left_title: null, left_bullets: [], right_title: null, right_bullets: [], table_headers: [], table_rows: [], steps: [], notes: null };
  return {
    title: "Startaplarni moliyalashtirish",
    subtitle: "Innovatsion iqtisodiyot",
    slides: [
      { ...base, layout: "bullets", title: "Kirish", bullets: ["Startap tushunchasi", "Moliyalashtirish nima uchun kerak", "Bozor 2024-yilda 37% o'sdi"] },
      { ...base, layout: "process", title: "Bosqichlar", steps: ["Pre-seed", "Seed", "A raund"] },
      { ...base, layout: "table", title: "Manbalar", table_headers: ["Manba", "Afzallik"], table_rows: [["Farishtalar", "Tajriba"], ["Venchur", "Katta mablag'"]] },
      { ...base, layout: "conclusion", title: "Xulosa", bullets: ["Manbani to'g'ri tanlash muhim"] },
    ],
  };
}

// ---------------- Soxta Telegram ----------------

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** grammY transformer orqali barcha Bot API so'rovlarini ushlaydi. Real Telegram bilan aloqa yo'q. */
export class FakeTelegram {
  calls: ApiCall[] = [];
  private nextId = 1000;
  /** method → navbatdagi xato(lar) */
  failures: Record<string, Array<"500" | "429" | "403" | "network">> = {};

  transformer: Transformer = async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    this.calls.push({ method, payload: p });
    const fail = this.failures[method]?.shift();
    if (fail === "network") throw new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));
    if (fail) {
      const code = Number(fail);
      return { ok: false, error_code: code, description: code === 403 ? "Forbidden: bot was blocked by the user" : code === 429 ? "Too Many Requests: retry after 7" : "Internal Server Error", parameters: code === 429 ? { retry_after: 7 } : undefined } as never;
    }
    const chat = { id: Number(p.chat_id ?? 1), type: "private" as const, first_name: "T" };
    switch (method) {
      case "sendMessage":
        return { ok: true, result: { message_id: this.nextId++, date: 0, chat, text: p.text } } as never;
      case "sendDocument":
        return { ok: true, result: { message_id: this.nextId++, date: 0, chat, document: { file_id: typeof p.document === "string" ? p.document : `doc-${this.nextId}`, file_unique_id: "u" } } } as never;
      case "editMessageText":
        return { ok: true, result: { message_id: Number(p.message_id), date: 0, chat, text: p.text } } as never;
      case "getFile":
        return { ok: true, result: { file_id: p.file_id, file_unique_id: "u", file_path: "voice/file_1.oga" } } as never;
      default:
        return { ok: true, result: true } as never;
    }
  };

  sent(method = "sendMessage"): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** sendMessage + editMessageText matnlari */
  texts(): string[] {
    return this.calls.filter((c) => ["sendMessage", "editMessageText", "sendDocument"].includes(c.method)).map((c) => String(c.payload.text ?? c.payload.caption ?? ""));
  }

  lastText(): string {
    const t = this.texts();
    return t[t.length - 1] ?? "";
  }

  lastKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
    const withKb = this.calls.filter((c) => (c.payload.reply_markup as { inline_keyboard?: unknown })?.inline_keyboard);
    const last = withKb[withKb.length - 1];
    return ((last?.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })?.inline_keyboard ?? []) as never;
  }

  answers(): string[] {
    return this.sent("answerCallbackQuery").map((c) => String(c.payload.text ?? ""));
  }

  reset() {
    this.calls = [];
  }
}

// ---------------- Harness ----------------

export const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "Nigina",
  username: "nigina_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

export class Clock {
  constructor(public now: Date) {}
  set(iso: string) {
    this.now = new Date(iso);
  }
  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms);
  }
}

let sharedDb: Db | null = null;
export function testDb(): Db {
  sharedDb ??= createDb(process.env.DATABASE_URL);
  return sharedDb;
}

export async function resetDb(): Promise<void> {
  await testDb().$executeRawUnsafe(
    `TRUNCATE "FinanceSnapshot","Transaction","DeliveryAttempt","Reminder","Presentation","Task","Note","InboundMessage","ConversationState","UsageCounter","ProcessedUpdate","AiUsageLog","AccessRequest","User" CASCADE`,
  );
}

let updateSeq = 1;
export const nextUpdateId = () => updateSeq++;

export function makeHarness(o: { now?: string; ai?: AiProvider; analysisAi?: AiProvider; tg?: FakeTelegram; clock?: Clock; cfg?: Record<string, string> } = {}) {
  const cfg = loadConfig({ ...process.env, ...(o.cfg ?? {}) });
  const db = testDb();
  const clock = o.clock ?? new Clock(new Date(o.now ?? "2026-10-24T08:00:00Z")); // 13:00 Toshkent, shanba
  // Real provider (e2e skripti) ham berilishi mumkin; testlar FakeAi metodlaridan foydalanadi
  const ai = (o.ai ?? new FakeAi()) as FakeAi;
  const analysisAi = (o.analysisAi ?? new FakeAi()) as FakeAi;
  const tg = o.tg ?? new FakeTelegram();
  const enqueued: string[] = [];
  const deps: Deps = {
    cfg,
    db,
    ai,
    nlu: new Nlu(ai),
    analysisNlu: new Nlu(analysisAi),
    messenger: new Messenger(null as never),
    enqueuePresentation: async (id) => {
      enqueued.push(id);
    },
    downloadFile: async () => Buffer.from("OggS-fake-audio"),
    clock: () => clock.now,
  };
  const bot = createBot(deps, cfg.TELEGRAM_BOT_TOKEN, { botInfo: BOT_INFO });
  bot.api.config.use(tg.transformer);
  const scheduler = new ReminderScheduler(deps, "worker-test");

  const from = (uid: number) => ({ id: uid, is_bot: false, first_name: `User${uid}`, language_code: "uz" });
  const chat = (uid: number) => ({ id: uid, type: "private" as const, first_name: `User${uid}` });

  const api = {
    deps,
    db,
    ai,
    analysisAi,
    tg,
    bot,
    clock,
    enqueued,
    scheduler,
    async text(text: string, uid = 1, updateId = nextUpdateId()) {
      const update: Update = { update_id: updateId, message: { message_id: updateId, date: 0, chat: chat(uid), from: from(uid), text } } as Update;
      await bot.handleUpdate(update);
      return update;
    },
    async command(cmd: string, uid = 1) {
      const updateId = nextUpdateId();
      const text = `/${cmd}`;
      await bot.handleUpdate({ update_id: updateId, message: { message_id: updateId, date: 0, chat: chat(uid), from: from(uid), text, entities: [{ type: "bot_command", offset: 0, length: text.length }] } } as Update);
    },
    async voice(uid = 1, updateId = nextUpdateId(), duration = 6) {
      const update: Update = {
        update_id: updateId,
        message: { message_id: updateId, date: 0, chat: chat(uid), from: from(uid), voice: { file_id: `voice-${updateId}`, file_unique_id: `u${updateId}`, duration, mime_type: "audio/ogg", file_size: 20_000 } },
      } as Update;
      await bot.handleUpdate(update);
      return update;
    },
    async click(data: string, uid = 1, messageId = 5000, text = "xabar") {
      const updateId = nextUpdateId();
      await bot.handleUpdate({
        update_id: updateId,
        callback_query: { id: `cb${updateId}`, from: from(uid), chat_instance: "x", data, message: { message_id: messageId, date: 0, chat: chat(uid), text } },
      } as Update);
    },
    async user(uid = 1) {
      return db.user.findUniqueOrThrow({ where: { telegramUserId: BigInt(uid) } });
    },
  };
  return api;
}

export const aiError = (code: AiError["code"] = "unavailable") => new AiError(code, "test", true);
export { GrammyError };
