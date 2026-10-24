import type { IncomingMessage, ServerResponse } from "node:http";
import type { Redis } from "ioredis";
import type { Db } from "./db.ts";
import { safeError } from "./logger.ts";

export interface HealthDeps {
  db: Db;
  /** Redis'siz rejimda null — tekshirilmaydi */
  redis: Redis | null;
  /** Eslatmalar scheduler'i (worker roli) — oxirgi muvaffaqiyatli sikl */
  scheduler?: { lastTickOkAt: Date | null } | null;
  schedulerIntervalMs: number;
  /** Telegram polling ishlayaptimi (bot roli, polling rejimi) */
  pollingRunning?: (() => boolean) | null;
  startedAt: Date;
}

type Check = { ok: boolean; ms?: number; error?: string };

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);

async function timed(fn: () => Promise<unknown>): Promise<Check> {
  const t0 = Date.now();
  try {
    await withTimeout(fn(), 5_000);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    // Xato matni qisqa va sirsiz (ulanish manzili/parol chiqmaydi)
    return { ok: false, ms: Date.now() - t0, error: safeError(err).slice(0, 120) };
  }
}

/**
 * Uptime monitorlar uchun:
 *  GET /health        — jarayon tirik (200 "ok")
 *  GET /health/ready  — baza, Redis, eslatmalar scheduler'i, Telegram polling; biror narsa ishlamasa 503
 * Javobda sir yo'q: faqat holat, kechikish va qisqa xato.
 */
export async function handleHealth(req: IncomingMessage, res: ServerResponse, d: HealthDeps): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0];
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return true;
  }
  if (url !== "/health/ready") return false;

  const checks: Record<string, Check> = {};
  checks.database = await timed(() => d.db.$queryRaw`SELECT 1`);
  if (d.redis) {
    const redis = d.redis;
    checks.redis = await timed(() => redis.ping());
  }
  if (d.scheduler) {
    // Sikl har SCHEDULER_INTERVAL_MS da; 3 ta sikl + 30 s ichida muvaffaqiyatli bo'lmasa — muammo
    const staleMs = d.schedulerIntervalMs * 3 + 30_000;
    const last = d.scheduler.lastTickOkAt;
    const age = last ? Date.now() - last.getTime() : Date.now() - d.startedAt.getTime();
    checks.reminders = age <= staleMs ? { ok: true } : { ok: false, error: last ? `oxirgi sikl ${Math.round(age / 1000)} s oldin` : "hali sikl bo'lmagan" };
  }
  if (d.pollingRunning) checks.telegram = d.pollingRunning() ? { ok: true } : { ok: false, error: "polling to'xtagan" };

  const ok = Object.values(checks).every((c) => c.ok);
  const body = JSON.stringify({ status: ok ? "ok" : "fail", uptimeSec: Math.round((Date.now() - d.startedAt.getTime()) / 1000), checks });
  res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(req.method === "HEAD" ? undefined : body);
  return true;
}
