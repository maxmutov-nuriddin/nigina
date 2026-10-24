import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Api, webhookCallback } from "grammy";
import { run } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { config } from "./config.ts";
import { createDb } from "./db.ts";
import { logger, safeError } from "./logger.ts";
import { createAiProviders } from "./ai/factory.ts";
import { Nlu } from "./ai/nlu.ts";
import { usageRecorder } from "./lib/usage.ts";
import { Messenger } from "./messenger.ts";
import type { Deps } from "./deps.ts";
import { createBot } from "./bot/bot.ts";
import { ReminderScheduler } from "./reminders/scheduler.ts";
import { createPresentationQueue, createRedis, startPresentationWorker } from "./presentations/queue.ts";
import { LocalPresentationQueue } from "./presentations/local-queue.ts";
import { sweepQueued } from "./presentations/generate.ts";
import { runMaintenance } from "./maintenance.ts";
import { FinanceAnalyzer } from "./finance/background.ts";
import { handleHealth, type HealthDeps } from "./health.ts";

async function main(): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN sozlanmagan (.env)");
  if (!config.GROQ_API_KEY && !config.GEMINI_API_KEY) logger.warn("GROQ_API_KEY ham, GEMINI_API_KEY ham sozlanmagan — AI funksiyalari ishlamaydi, foydalanuvchiga xabar beriladi");

  const db = createDb();
  // REDIS_URL bo'sh — prezentatsiya navbati jarayon ichida (bitta jarayon, Render kabi Redis'siz hosting uchun)
  const redis = config.REDIS_URL ? createRedis(config) : null;
  if (!redis && config.APP_ROLE !== "all") throw new Error("APP_ROLE=bot/worker alohida ishlaganda REDIS_URL kerak (navbat jarayonlar orasida bo'linadi)");
  const localQueue = redis ? null : new LocalPresentationQueue(config.PRESENTATION_CONCURRENCY);
  const bullQueue = redis ? createPresentationQueue(redis) : null;
  const enqueue = bullQueue?.enqueue ?? localQueue!.enqueue;
  if (!redis) logger.info("REDIS_URL yo'q — prezentatsiya navbati jarayon ichida");
  const { ai, analysisAi } = createAiProviders(config, usageRecorder(db));
  logger.info({ chat: ai.name }, "AI provayderlari");
  if (config.ALLOWED_CHAT_IDS.length) logger.info({ allowed: config.ALLOWED_CHAT_IDS.length }, "Bot faqat ruxsat berilgan chat(lar) uchun");
  const api = new Api(config.TELEGRAM_BOT_TOKEN);
  // Telegram 429/5xx — cheklangan qayta urinish
  api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  const deps: Deps = {
    cfg: config,
    db,
    ai,
    nlu: new Nlu(ai, { maxTokens: config.GROQ_MAX_COMPLETION_TOKENS }),
    analysisNlu: analysisAi.isConfigured() ? new Nlu(analysisAi) : null,
    messenger: new Messenger(api),
    enqueuePresentation: enqueue,
    downloadFile: async (filePath) => {
      const res = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Telegram fayl yuklab olinmadi: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    clock: () => new Date(),
  };

  const stops: Array<() => Promise<unknown>> = [];
  const role = config.APP_ROLE;
  const health: HealthDeps = { db, redis, schedulerIntervalMs: config.SCHEDULER_INTERVAL_MS, startedAt: new Date() };
  let webhookHandle: ((req: IncomingMessage, res: ServerResponse) => unknown) | null = null;

  if (role === "all" || role === "worker") {
    const scheduler = new ReminderScheduler(deps);
    scheduler.start();
    health.scheduler = scheduler;
    stops.push(() => scheduler.stop());

    if (localQueue) {
      await localQueue.start(deps);
      stops.push(() => localQueue.close());
    } else {
      const worker = startPresentationWorker(deps, createRedis(config));
      stops.push(() => worker.close());
    }

    const analyzer = new FinanceAnalyzer(deps);
    analyzer.start();
    stops.push(() => analyzer.stop());

    const timer = setInterval(() => {
      void sweepQueued(deps).catch((err) => logger.warn({ err: safeError(err) }, "sweep xatosi"));
      void runMaintenance(deps).catch((err) => logger.warn({ err: safeError(err) }, "maintenance xatosi"));
    }, 60_000);
    stops.push(async () => clearInterval(timer));
  }

  if (role === "all" || role === "bot") {
    const bot = createBot(deps, config.TELEGRAM_BOT_TOKEN, { sequential: true });
    bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
    deps.messenger.api = bot.api;
    await bot.init();
    await bot.api.setMyCommands([
      { command: "start", description: "Boshlash / Начать" },
      { command: "help", description: "Yordam / Помощь" },
      { command: "today", description: "Bugungi ishlar" },
      { command: "week", description: "Haftalik ishlar" },
      { command: "tasks", description: "Faol vazifalar" },
      { command: "notes", description: "Qaydlar" },
      { command: "finance", description: "Moliya: xarajat, daromad, prognoz" },
      { command: "settings", description: "Sozlamalar" },
      { command: "cancel", description: "Joriy jarayonni bekor qilish" },
    ]);

    const allowed_updates = ["message", "callback_query"] as const;
    if (config.BOT_MODE === "webhook") {
      if (!config.WEBHOOK_URL || !config.WEBHOOK_SECRET) throw new Error("Webhook rejimi uchun WEBHOOK_URL va WEBHOOK_SECRET kerak");
      webhookHandle = webhookCallback(bot, "http", { secretToken: config.WEBHOOK_SECRET, onTimeout: "return", timeoutMilliseconds: 55_000 });
      await bot.api.setWebhook(config.WEBHOOK_URL, { secret_token: config.WEBHOOK_SECRET, allowed_updates: [...allowed_updates] });
      logger.info("Webhook rejimi");
    } else {
      await bot.api.deleteWebhook();
      const runner = run(bot, { runner: { fetch: { allowed_updates: [...allowed_updates] } } });
      health.pollingRunning = () => runner.isRunning();
      logger.info({ username: bot.botInfo.username }, "Polling rejimi");
      stops.push(() => runner.stop());
    }
  }

  // HTTP: uptime monitor uchun /health, /health/ready; webhook rejimida — Telegram webhook ham
  if (config.HTTP_ENABLED || webhookHandle) {
    const server = createServer((req, res) => {
      if (webhookHandle && req.method === "POST" && req.url === "/telegram/webhook") return void webhookHandle(req, res);
      void handleHealth(req, res, health)
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        })
        .catch(() => res.writeHead(500).end());
    });
    server.listen(config.WEBHOOK_PORT);
    logger.info({ port: config.WEBHOOK_PORT }, "HTTP: /health, /health/ready");
    stops.unshift(() => new Promise((r) => server.close(r)));
  }

  if (bullQueue && redis) stops.push(() => bullQueue.queue.close(), () => redis.quit());
  stops.push(() => db.$disconnect());

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "To'xtatilmoqda…");
    for (const stop of stops) await stop().catch((err) => logger.warn({ err: safeError(err) }, "stop xatosi"));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: safeError(err) }, "Ishga tushmadi");
  process.exit(1);
});
