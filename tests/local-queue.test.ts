import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, resetDb } from "./helpers.ts";
import { LocalPresentationQueue } from "../src/presentations/local-queue.ts";

beforeEach(resetDb);

const until = async (cond: () => boolean, ms = 3_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("kutish tugadi");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("Redis'siz prezentatsiya navbati (REDIS_URL bo'sh)", () => {
  it("bir xil job ikki marta bajarilmaydi; xato bo'lsa 3 marta urinadi, oxirgisi finalAttempt", async () => {
    const h = makeHarness();
    const calls: Array<{ id: string; final: boolean }> = [];
    const q = new LocalPresentationQueue(2, 5, async (_d, id, o) => {
      calls.push({ id, final: o.finalAttempt });
      if (id === "bad") throw new Error("Groq xatosi");
    });
    await q.start(h.deps);
    await q.enqueue("ok");
    await q.enqueue("ok"); // dublikat
    await q.enqueue("bad");
    await until(() => calls.length >= 4);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.id === "ok")).toHaveLength(1);
    expect(calls.filter((c) => c.id === "bad").map((c) => c.final)).toEqual([false, false, true]);
    // Qo'lda "Qayta urinish" — yangi raund, yangi job
    await q.enqueue("ok", "r2");
    await until(() => calls.filter((c) => c.id === "ok").length === 2);
    await q.close();
  });

  it("parallellik cheklanadi", async () => {
    const h = makeHarness();
    let active = 0;
    let peak = 0;
    const q = new LocalPresentationQueue(2, 5, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });
    await q.start(h.deps);
    for (const id of ["a", "b", "c", "d", "e"]) await q.enqueue(id);
    await until(() => active === 0 && peak > 0, 3_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(peak).toBe(2);
    await q.close();
  });

  it("restartdan keyin yarim qolgan (generating) prezentatsiya navbatga qaytariladi", async () => {
    const h = makeHarness();
    const user = await h.db.user.create({ data: { telegramUserId: 99n, chatId: 99n } });
    await h.db.presentation.create({ data: { userId: user.id, topic: "Test", status: "generating", stage: "outline" } });
    const q = new LocalPresentationQueue(1, 5, async () => {});
    await q.start(h.deps);
    const p = await h.db.presentation.findFirstOrThrow();
    expect(p.status).toBe("queued");
    expect(p.stage).toBeNull();
    await q.close();
  });
});
