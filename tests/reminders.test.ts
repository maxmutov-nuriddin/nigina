import { beforeEach, describe, expect, it } from "vitest";
import { a, makeHarness, resetDb } from "./helpers.ts";
import { ReminderScheduler } from "../src/reminders/scheduler.ts";

beforeEach(resetDb);

async function seedReminder(h: ReturnType<typeof makeHarness>, remindAt = "2026-10-25T09:00", extra = {}) {
  h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { category: "work", title: "Mijozga qo‘ng‘iroq qilish", event_at: remindAt, remind_at: remindAt, ...extra })] });
  await h.text("Ertaga 9 da mijozga qo‘ng‘iroq");
  return h.db.reminder.findFirstOrThrow();
}

describe("5. Restartdan keyin eslatma yetkazish", () => {
  it("yangi scheduler instansiyasi (restart) bazadagi eslatmani yuboradi, tugmalar bilan", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    h.tg.reset();
    const restarted = new ReminderScheduler(h.deps, "worker-after-restart");
    expect(await restarted.tick()).toBe(1);
    expect(h.tg.lastText()).toBe("🔔 Mijozga qo‘ng‘iroq qilish\n🕒 Vaqti: 25-oktabr, 09:00");
    const kb = h.tg.lastKeyboard().flat().map((b) => b.callback_data);
    expect(kb).toEqual([expect.stringMatching(/^td:/), `rs:${rem.id}:1:10`, `rs:${rem.id}:1:60`, expect.stringMatching(/^ct:t:/), expect.stringMatching(/^cx:t:/)]);
    const after = await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id }, include: { deliveries: true } });
    expect(after.status).toBe("sent");
    expect(after.deliveries.map((d) => d.status)).toEqual(["sent"]);
    // Qayta tick — ikkinchi marta yuborilmaydi
    expect(await restarted.tick()).toBe(0);
  });

  it("muddati kelmagan eslatma yuborilmaydi", async () => {
    const h = makeHarness();
    await seedReminder(h);
    h.clock.set("2026-10-25T03:59:00Z");
    expect(await h.scheduler.tick()).toBe(0);
  });

  it("ikki worker bir vaqtda claim qilsa — eslatmani faqat bittasi oladi", async () => {
    const h = makeHarness();
    await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    const w1 = new ReminderScheduler(h.deps, "w1");
    const w2 = new ReminderScheduler(h.deps, "w2");
    const [c1, c2] = await Promise.all([w1.claim(), w2.claim()]);
    expect(c1.length + c2.length).toBe(1);
  });

  it("worker claim qilib yiqilsa — lock muddati o'tgach boshqa worker yuboradi, oldingi urinish 'uncertain'", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    const crashed = new ReminderScheduler(h.deps, "crashed");
    const [claim] = await crashed.claim();
    await h.db.deliveryAttempt.create({ data: { reminderId: rem.id, userId: rem.userId, attemptNo: 1, reminderVersion: claim.version, workerId: "crashed" } });

    const other = new ReminderScheduler(h.deps, "other");
    expect(await other.tick()).toBe(0); // lock hali amalda
    h.clock.advance(121_000);
    h.tg.reset();
    expect(await other.tick()).toBe(1);
    const atts = await h.db.deliveryAttempt.findMany({ where: { reminderId: rem.id }, orderBy: { createdAt: "asc" } });
    expect(atts.map((x) => x.status)).toEqual(["uncertain", "sent"]);
  });

  it("downtime: 3 soat kechikkan — 'kechikkan' belgisi bilan; 20 soat — alohida yuborilmaydi, umumiy xabar", async () => {
    const h = makeHarness();
    await seedReminder(h, "2026-10-25T09:00");
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { category: "home", title: "Gul sug‘orish", remind_at: "2026-10-24T20:00" })] });
    await h.text("Bugun 20 da gul sug‘orishni eslat");

    // Bot 25-okt 12:00 (Toshkent) gacha ishlamadi
    h.clock.set("2026-10-25T07:00:00Z");
    h.tg.reset();
    expect(await h.scheduler.tick()).toBe(1);
    const texts = h.tg.texts();
    expect(texts.find((t) => t.includes("Mijozga"))).toContain("⏰ Kechikkan eslatma (rejada: 25-oktabr, 09:00)");
    expect(texts.find((t) => t.includes("Gul"))).toContain("⚠️ Bot ishlamay qolgan paytda");
    const missed = await h.db.reminder.findFirstOrThrow({ where: { task: { title: "Gul sug‘orish" } } });
    expect(missed.status).toBe("missed");
  });
});

describe("7. Vaqt o'zgarganda eski eslatma yuborilmaydi", () => {
  it("ko'chirilgan eslatma eski vaqtda emas, yangi vaqtda bir marta yuboriladi", async () => {
    const h = makeHarness();
    await seedReminder(h);
    h.ai.onExtract = (c) => ({ reply: null, actions: [a("update_item", { update_op: "reschedule", related_item_id: c.findRef(/Mijozga/), event_at: "2026-10-25T10:00" })] });
    await h.text("Mijozga qo‘ng‘iroqni o‘nga sur");

    h.clock.set("2026-10-25T04:00:30Z");
    h.tg.reset();
    expect(await h.scheduler.tick()).toBe(0);
    h.clock.set("2026-10-25T05:00:30Z");
    expect(await h.scheduler.tick()).toBe(1);
    expect(await h.scheduler.tick()).toBe(0);
    expect(h.tg.sent("sendMessage")).toHaveLength(1);
  });

  it("claim qilingandan keyin bekor qilingan eslatma yuborilmaydi va holati qayta yozilmaydi", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    const w = new ReminderScheduler(h.deps, "w");
    const [claim] = await w.claim();
    // Shu orada foydalanuvchi "Bekor qilish"ni bosdi
    const task = await h.db.task.findFirstOrThrow();
    await h.click(`cx:t:${task.id}`);
    h.tg.reset();
    const delivered = await (w as unknown as { deliver: (c: unknown, m: Map<string, unknown>) => Promise<boolean> }).deliver(claim, new Map());
    expect(delivered).toBe(false);
    expect(h.tg.sent("sendMessage")).toHaveLength(0);
    expect((await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } })).status).toBe("cancelled");
  });

  it("'10 daqiqaga surish' — eski xabar tugmasi qayta bosilsa eskirgan", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    await h.scheduler.tick();
    await h.click(`rs:${rem.id}:1:10`);
    const snoozed = await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } });
    expect(snoozed.status).toBe("scheduled");
    expect(snoozed.fireAt.toISOString()).toBe("2026-10-25T04:10:10.000Z");
    expect(snoozed.version).toBe(2);
    await h.click(`rs:${rem.id}:1:10`);
    expect(h.tg.answers().at(-1)).toContain("eskirgan");
    h.clock.set("2026-10-25T04:10:20Z");
    expect(await h.scheduler.tick()).toBe(1);
  });
});

describe("Takroriy eslatmalar", () => {
  it("har kuni 08:00 — yuborilgach keyingi kunga o'tadi; downtime'dagi takrorlar spam qilinmaydi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { category: "personal", title: "Dori ichish", recurrence: { freq: "daily", interval: 1, by_weekday: [], time: "08:00" } })] });
    await h.text("Har kuni soat 8 da dori ichishni eslat");
    expect(h.tg.lastText()).toContain("🔁 Takror: har kuni, 08:00");
    const rem = await h.db.reminder.findFirstOrThrow();
    expect(rem.fireAt.toISOString()).toBe("2026-10-25T03:00:00.000Z");

    h.clock.set("2026-10-25T03:00:05Z");
    expect(await h.scheduler.tick()).toBe(1);
    let r = await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } });
    expect(r.status).toBe("scheduled");
    expect(r.fireAt.toISOString()).toBe("2026-10-26T03:00:00.000Z");

    // 26 va 27 o'tkazib yuborildi (bot ishlamadi) — 28-okt 08:30 da bitta umumiy xabar, keyingisi 29-okt
    h.clock.set("2026-10-28T03:30:00Z");
    h.tg.reset();
    await h.scheduler.tick();
    r = await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } });
    expect(r.fireAt.toISOString()).toBe("2026-10-29T03:00:00.000Z");
    expect(h.tg.sent("sendMessage")).toHaveLength(1);
  });
});

describe("10. Telegram xatolaridan tiklanish", () => {
  it("500 xato — backoff bilan qayta urinish, keyin yuboriladi", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    h.tg.failures.sendMessage = ["500"];
    expect(await h.scheduler.tick()).toBe(0);
    let r = await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } });
    expect(r.status).toBe("scheduled");
    expect(r.nextAttemptAt.toISOString()).toBe("2026-10-25T04:00:40.000Z");
    expect(r.fireAt.toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(await h.scheduler.tick()).toBe(0); // backoff hali tugamagan
    h.clock.advance(31_000);
    expect(await h.scheduler.tick()).toBe(1);
    r = await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id }, include: { deliveries: { orderBy: { createdAt: "asc" } } } });
    expect(r.status).toBe("sent");
    expect((r as unknown as { deliveries: Array<{ status: string }> }).deliveries.map((d) => d.status)).toEqual(["failed", "sent"]);
  });

  it("429 — retry_after hurmat qilinadi; tarmoq uzilishi — 'uncertain'", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    h.tg.failures.sendMessage = ["network"];
    await h.scheduler.tick();
    const att = await h.db.deliveryAttempt.findFirstOrThrow({ where: { reminderId: rem.id } });
    expect(att.status).toBe("uncertain");
  });

  it("403 (bot bloklangan) — foydalanuvchi belgilanadi, eslatma 'failed', qayta urinilmaydi", async () => {
    const h = makeHarness();
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    h.tg.failures.sendMessage = ["403"];
    await h.scheduler.tick();
    expect((await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } })).status).toBe("failed");
    expect((await h.user()).blockedAt).not.toBeNull();
    // /start bosilsa blok olib tashlanadi
    await h.command("start");
    expect((await h.user()).blockedAt).toBeNull();
  });

  it("maksimal urinishlardan keyin to'xtaydi", async () => {
    const h = makeHarness({ cfg: { REMINDER_MAX_ATTEMPTS: "2" } });
    const rem = await seedReminder(h);
    h.clock.set("2026-10-25T04:00:10Z");
    h.tg.failures.sendMessage = ["500", "500", "500"];
    await h.scheduler.tick();
    h.clock.advance(60_000);
    await h.scheduler.tick();
    expect((await h.db.reminder.findUniqueOrThrow({ where: { id: rem.id } })).status).toBe("failed");
  });
});
