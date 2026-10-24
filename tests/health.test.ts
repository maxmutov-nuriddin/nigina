import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { createRedis } from "../src/presentations/queue.ts";
import { handleHealth, type HealthDeps } from "../src/health.ts";

const cfg = loadConfig();
const db = createDb();
const redis = createRedis(cfg);
const deps: HealthDeps = { db, redis, schedulerIntervalMs: 5_000, startedAt: new Date(), scheduler: { lastTickOkAt: new Date() }, pollingRunning: () => true };
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => void handleHealth(req, res, deps).then((h) => (h ? undefined : res.writeHead(404).end())));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await redis.quit();
  await db.$disconnect();
});

describe("Health endpoint'lari (uptime monitor)", () => {
  it("/health — jarayon tirik", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/health/ready — baza, Redis, eslatmalar va Telegram ishlasa 200", async () => {
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, { ok: boolean }> };
    expect(body.status).toBe("ok");
    expect(Object.keys(body.checks)).toEqual(["database", "redis", "reminders", "telegram"]);
  });

  it("eslatmalar scheduler'i to'xtab qolsa yoki polling o'chsa — 503", async () => {
    deps.scheduler = { lastTickOkAt: new Date(Date.now() - 10 * 60_000) };
    deps.pollingRunning = () => false;
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, { ok: boolean }> };
    expect(body.checks.reminders.ok).toBe(false);
    expect(body.checks.telegram.ok).toBe(false);
    expect(body.checks.database.ok).toBe(true);
  });

  it("noma'lum yo'l — 404", async () => {
    expect((await fetch(`${base}/nimadir`)).status).toBe(404);
  });
});
