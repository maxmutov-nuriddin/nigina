import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { a, makeHarness, resetDb } from "./helpers.ts";
import { createPresentationQueue, createRedis, startPresentationWorker } from "../src/presentations/queue.ts";
import { AudioFormatError, prepareAudio } from "../src/bot/audio.ts";
import { loadConfig } from "../src/config.ts";

beforeEach(resetDb);

describe("BullMQ + Redis (haqiqiy Redis, soxta AI/Telegram)", () => {
  const prefix = `nigina-test-${randomBytes(4).toString("hex")}`;
  const cfg = loadConfig();
  const r1 = createRedis(cfg);
  const r2 = createRedis(cfg);
  afterAll(async () => {
    await r1.quit();
    await r2.quit();
  });

  it("navbatga qo'yilgan prezentatsiya worker tomonidan yaratiladi va bir marta yuboriladi", async () => {
    const h = makeHarness();
    const { queue, enqueue } = createPresentationQueue(r1, prefix);
    h.deps.enqueuePresentation = enqueue;
    const worker = startPresentationWorker(h.deps, r2, prefix);
    try {
      h.ai.onExtract = () => ({ reply: null, actions: [a("create_presentation", { presentation_topic: "Navbat testi", slide_count: 5 })] });
      await h.text("Navbat testi mavzusida prezentatsiya tayyorla");
      const pres = await h.db.presentation.findFirstOrThrow();
      await enqueue(pres.id); // takroriy enqueue — bir xil jobId, dublikat bo'lmaydi
      const deadline = Date.now() + 15_000;
      let status = "queued";
      while (Date.now() < deadline && status !== "ready") {
        await new Promise((r) => setTimeout(r, 200));
        status = (await h.db.presentation.findUniqueOrThrow({ where: { id: pres.id } })).status;
      }
      expect(status).toBe("ready");
      await new Promise((r) => setTimeout(r, 300));
      expect(h.tg.sent("sendDocument")).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

describe("Audio formatlari", () => {
  const cfg = loadConfig({ ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg" });
  it("Telegram .oga — konvertatsiyasiz .ogg sifatida yuboriladi", async () => {
    const r = await prepareAudio(Buffer.from("x"), "oga", cfg);
    expect(r).toMatchObject({ filename: "audio.ogg", converted: false });
    expect((await prepareAudio(Buffer.from("x"), "m4a", cfg)).filename).toBe("audio.m4a");
  });
  it("mos kelmagan format ffmpeg talab qiladi; ffmpeg yo'q bo'lsa aniq xato, vaqtinchalik fayl qolmaydi", async () => {
    await expect(prepareAudio(Buffer.from("x"), "amr", cfg)).rejects.toBeInstanceOf(AudioFormatError);
    const { readdirSync, existsSync } = await import("node:fs");
    const dir = cfg.TMP_DIR;
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });
});
