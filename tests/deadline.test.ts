import { beforeEach, describe, expect, it } from "vitest";
import { a, makeHarness, resetDb } from "./helpers.ts";
import { deadlineReminders } from "../src/reminders/service.ts";

// Harness soati: 2026-10-24 13:00 Toshkent (shanba).
beforeEach(resetDb);

describe("Muddatli vazifalar uchun avtomatik eslatmalar", () => {
  it("«29-gacha prezentatsiya tayyorla» — muddat vazifa sifatida saqlanadi, bir kun oldin va muddat kuni eslatiladi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: [a("create_presentation", { category: "study", due_at: "2026-10-29", presentation_topic: "Moliya va xulq-atvor iqtisodiyoti", presentation_language: "uz" })],
    });
    await h.text("29-gacha moliya va xulq-atvor iqtisodiyoti mavzusida prezentatsiya tayyorla");

    const task = await h.db.task.findFirstOrThrow({ include: { reminders: { orderBy: { fireAt: "asc" } } } });
    expect(task.title).toBe("Prezentatsiya: Moliya va xulq-atvor iqtisodiyoti");
    expect(task.dueAt?.toISOString()).toBe("2026-10-28T19:00:00.000Z");
    expect(task.dueAllDay).toBe(true);
    const pres = await h.db.presentation.findFirstOrThrow();
    expect(pres.taskId).toBe(task.id);
    expect(task.reminders.map((r) => [r.fireAt.toISOString(), r.anchor])).toEqual([
      ["2026-10-28T04:00:00.000Z", "due"],
      ["2026-10-29T04:00:00.000Z", "due"],
    ]);
    expect(task.reminders[0].text).toContain("Ertaga");

    const reply = h.tg.lastText();
    expect(reply).toContain("📅 Muddat: 29-oktabr");
    expect(reply).toContain("🔔 Muddat eslatmasi: 28-oktabr, 09:00 va 29-oktabr, 09:00");
    expect(reply).toContain("📎 Prezentatsiya: 10 slayd");
  });

  it("muddat faqat prezentatsiyada aytilsa — bog'langan vazifaga yoziladi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: [
        a("create_task", { category: "study", title: "Iqtisodiyot topshirig‘i" }),
        a("create_presentation", { category: "study", link_to_action: 0, due_at: "2026-10-29", presentation_topic: "Inflyatsiya", presentation_language: "uz" }),
      ],
    });
    await h.text("Iqtisodiyotdan topshiriq bor, 29-gacha inflyatsiya mavzusida prezentatsiya tayyorla");
    const task = await h.db.task.findFirstOrThrow({ include: { reminders: true, presentations: true } });
    expect(await h.db.task.count()).toBe(1);
    expect(task.dueAt?.toISOString()).toBe("2026-10-28T19:00:00.000Z");
    expect(task.presentations).toHaveLength(1);
    expect(task.reminders.map((r) => r.anchor)).toEqual(["due", "due"]);
    expect(h.tg.lastText()).toContain("📅 Muddat: 29-oktabr");
  });

  it("eslatma o'zi so'ralgan vazifaga avtomatik muddat eslatmasi qo'shilmaydi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: [a("create_task", { category: "study", title: "Referat topshirish", due_at: "2026-10-29", remind_at: "2026-10-27T18:00" })],
    });
    await h.text("29-gacha referat topshirishim kerak, 27-kuni kechqurun 6 da eslat");
    const rems = await h.db.reminder.findMany();
    expect(rems).toHaveLength(1);
    expect(rems[0].anchor).toBe("absolute");
  });

  it("muddat ko'chirilsa avtomatik eslatmalar ham ko'chadi, ro'yxatda muddat ko'rinadi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { category: "work", title: "Hisobot", due_at: "2026-10-29" })] });
    await h.text("29-gacha hisobot topshirishim kerak");
    h.ai.onExtract = (c) => ({ reply: null, actions: [a("update_item", { update_op: "reschedule", related_item_id: c.findRef(/Hisobot/), due_at: "2026-10-31" })] });
    await h.text("Hisobot muddatini 31-ga ko'chir");

    const active = await h.db.reminder.findMany({ where: { status: "scheduled" }, orderBy: { fireAt: "asc" } });
    expect(active.map((r) => r.fireAt.toISOString())).toEqual(["2026-10-30T04:00:00.000Z", "2026-10-31T04:00:00.000Z"]);
    expect(await h.db.reminder.count({ where: { status: "cancelled" } })).toBe(2);
    expect(h.tg.lastText()).toContain("🔔 Muddat eslatmasi: 30-oktabr, 09:00 va 31-oktabr, 09:00");
    expect(h.tg.lastText()).toContain("29-oktabr (payshanba) → 31-oktabr (shanba)");
  });

  it("o'tib ketgan va juda yaqin vaqtlar qo'shilmaydi; soati aniq muddatda kun eslatmasi ertaroq", () => {
    const now = new Date("2026-10-24T08:00:00Z"); // 13:00 Toshkent
    const tz = "Asia/Tashkent";
    // Muddat bugun — ertalabki 09:00 o'tib ketgan
    expect(deadlineReminders({ date: new Date("2026-10-23T19:00:00Z"), allDay: true }, now, tz, "09:00")).toEqual([]);
    // Muddat ertaga — bugungi 09:00 o'tgan, faqat ertangi kun eslatmasi
    expect(deadlineReminders({ date: new Date("2026-10-24T19:00:00Z"), allDay: true }, now, tz, "09:00").map((x) => x.kind)).toEqual(["day"]);
    // Muddat ertaga 08:00 — kun eslatmasi 2 soat oldin (06:00)
    const timed = deadlineReminders({ date: new Date("2026-10-25T03:00:00Z"), allDay: false }, now, tz, "09:00");
    expect(timed.map((x) => x.fireAt.toISOString())).toEqual(["2026-10-25T01:00:00.000Z"]);
  });
});
