import { beforeEach, describe, expect, it } from "vitest";
import { a, aiError, Clock, FakeAi, FakeTelegram, makeHarness, resetDb } from "./helpers.ts";
import { generatePresentation } from "../src/presentations/generate.ts";

// Harness soati: 2026-10-24 13:00 Toshkent (shanba). Payshanba = 29-okt, juma = 30-okt.
beforeEach(resetDb);

describe("1. Ovoz → transkripsiya → vazifa → baza", () => {
  it("ovozli xabardan vazifa va eslatma saqlanadi, status xabari tahrirlanadi", async () => {
    const h = makeHarness();
    h.ai.transcript = "Ertaga ertalab soat to'qqizda mijozga telefon qilishim kerak";
    h.ai.onExtract = (c) => {
      expect(c.message).toBe(h.ai.transcript);
      return { actions: [a("create_task", { category: "work", title: "Mijozga qo‘ng‘iroq qilish", event_at: "2026-10-25T09:00", remind_at: "2026-10-25T09:00" })], reply: null };
    };
    await h.voice();

    const tasks = await h.db.task.findMany({ include: { reminders: true, inbound: true } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].category).toBe("work");
    expect(tasks[0].eventAt?.toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(tasks[0].reminders[0].fireAt.toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(tasks[0].inbound?.transcript).toBe(h.ai.transcript);
    expect(tasks[0].inbound?.kind).toBe("voice");

    // Bitta status xabari + uni tahrirlash (keraksiz ko'p xabar yo'q)
    expect(h.tg.sent("sendMessage")).toHaveLength(1);
    expect(h.tg.sent("sendMessage")[0].payload.text).toBe("🎧 Ovozingizni tushunyapman…");
    const final = h.tg.sent("editMessageText").at(-1)!.payload.text as string;
    expect(final).toContain("🗣 «Ertaga ertalab");
    expect(final).toContain("✅ Saqlandi");
    expect(final).toContain("💼 Ish: Mijozga qo‘ng‘iroq qilish");
    expect(final).toContain("🔔 Eslatma: 25-oktabr, 09:00");
    expect(h.ai.calls).toEqual(["transcribe", "extract"]);
  });

  it("juda uzun ovoz rad etiladi, AI chaqirilmaydi", async () => {
    const h = makeHarness();
    await h.voice(1, undefined, 10_000);
    expect(h.tg.lastText()).toContain("juda uzun");
    expect(h.ai.calls).toEqual([]);
  });
});

describe("2. Bitta xabardan bir nechta vazifa (Misol A)", () => {
  it("aniqlarini saqlaydi, joylashuvga bog'liq eslatma uchun vaqt so'raydi, prezentatsiya yaratmaydi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: [
        a("create_task", { category: "work", title: "Mijozga qo‘ng‘iroq qilish", event_at: "2026-10-25T09:00", remind_at: "2026-10-25T09:00" }),
        a("create_task", { category: "home", title: "Sut olish", location_trigger: "uyga qaytayotganda" }),
        a("create_task", { category: "study", title: "Iqtisodiyotdan prezentatsiya topshirish", due_at: "2026-10-30", mentions_presentation: true }),
      ],
    });
    await h.text("Ertaga ertalab soat to‘qqizda mijozga telefon qilishim kerak. Kechqurun uyga qaytayotganda sut olishni eslat. Juma kuni iqtisodiyotdan prezentatsiya topshiraman.");

    const tasks = await h.db.task.findMany({ orderBy: { actionIndex: "asc" } });
    expect(tasks.map((t) => [t.category, t.title])).toEqual([
      ["work", "Mijozga qo‘ng‘iroq qilish"],
      ["study", "Iqtisodiyotdan prezentatsiya topshirish"],
    ]);
    expect(tasks[1].dueAt?.toISOString()).toBe("2026-10-29T19:00:00.000Z");
    expect(tasks[1].dueAllDay).toBe(true);
    expect(await h.db.presentation.count()).toBe(0);
    expect(h.enqueued).toEqual([]);

    const reply = h.tg.lastText();
    expect(reply).toContain("✅ Saqlandi");
    expect(reply).toContain("1. 💼 Ish: Mijozga qo‘ng‘iroq qilish");
    expect(reply).toContain("📚 O‘qish: Iqtisodiyotdan prezentatsiya topshirish");
    expect(reply).toContain("📅 Muddat: 30-oktabr (juma)");
    expect(reply).toContain("📍 «uyga qaytayotganda» — men joylashuvni kuzatmayman");
    const kb = h.tg.lastKeyboard();
    expect(kb.map((r) => r[0].text)).toEqual(["18:00", "19:00", "20:00"]);

    // Variant tanlanadi → uy vazifasi eslatma bilan saqlanadi
    await h.click(kb[1][0].callback_data);
    const milk = await h.db.task.findFirstOrThrow({ where: { title: "Sut olish" }, include: { reminders: true } });
    expect(milk.category).toBe("home");
    expect(milk.reminders[0].fireAt.toISOString()).toBe("2026-10-24T14:00:00.000Z");
    expect(h.tg.lastText()).toContain("🔔 Eslatma: 24-oktabr, 19:00");
    const state = await h.db.conversationState.findFirstOrThrow();
    expect(state.pending).toBeNull();
  });
});

describe("3. Yetishmayotgan vaqtni aniqlashtirish + restartdan keyin davom (Misol B)", () => {
  it("'soat sakkiz' noaniqligini so'raydi, javobni restartdan keyin ham qabul qiladi", async () => {
    const clock = new Clock(new Date("2026-10-24T08:00:00Z"));
    const h = makeHarness({ clock });
    h.ai.onExtract = () => ({
      reply: null,
      actions: [
        a("create_task", { category: "study", title: "Innovatsion iqtisodiyot topshirig‘i", due_at: "2026-10-30" }),
        a("create_presentation", { category: "study", link_to_action: 0, presentation_topic: "Startaplarni moliyalashtirish", presentation_language: "uz", slide_count: 10 }),
        a("create_reminder", {
          link_to_action: 1,
          missing_fields: ["remind_at"],
          clarification_question: "Payshanba soat 8 — ertalabmi yoki kechqurunmi?",
          clarification_options: [
            { label: "08:00", value: "2026-10-29T08:00" },
            { label: "20:00", value: "2026-10-29T20:00" },
          ],
          reminder_text: "{due_weekday} kungi prezentatsiyangiz tayyor. O‘qib chiqishni unutmang.",
        }),
      ],
    });
    await h.text("Juma kuni innovatsion iqtisodiyotdan topshiriq bor. Startaplarni moliyalashtirish mavzusida o‘zbekcha 10 slaydli prezentatsiya tayyorla. Payshanba soat sakkizda o‘qib chiqishimni eslat.");

    const task = await h.db.task.findFirstOrThrow();
    const pres = await h.db.presentation.findFirstOrThrow();
    expect(pres.taskId).toBe(task.id);
    expect(pres.status).toBe("queued");
    expect(pres.slideCount).toBe(10);
    expect(h.enqueued).toEqual([pres.id]);
    expect(await h.db.reminder.count()).toBe(0);
    const reply = h.tg.lastText();
    expect(reply).toContain("📎 Prezentatsiya: 10 slayd, o‘zbekcha — «Startaplarni moliyalashtirish»");
    expect(reply).toContain("❓ Payshanba soat 8 — ertalabmi yoki kechqurunmi?");

    // --- Bot qayta ishga tushdi: yangi instansiya, xotira bo'sh, holat faqat bazada ---
    const ai2 = new FakeAi();
    ai2.onResolve = (pending, question, answer) => {
      expect(question).toContain("ertalabmi");
      expect(answer).toBe("kechqurun");
      expect(pending).toHaveLength(1);
      expect(pending[0].related_item_id).toBe(`id:presentation:${pres.id}`);
      return { relates: true, actions: [{ ...pending[0], remind_at: "2026-10-29T20:00", missing_fields: [], clarification_question: null, clarification_options: [] }] };
    };
    const h2 = makeHarness({ clock, ai: ai2 });
    await h2.text("kechqurun");

    const rem = await h2.db.reminder.findFirstOrThrow();
    expect(rem.presentationId).toBe(pres.id);
    expect(rem.taskId).toBe(task.id);
    expect(rem.fireAt.toISOString()).toBe("2026-10-29T15:00:00.000Z");
    expect(h2.tg.lastText()).toContain("✅ Saqlandi");
    expect(h2.tg.lastText()).toContain("🔔 Eslatma: 29-oktabr, 20:00");
    expect((await h2.db.conversationState.findFirstOrThrow()).pending).toBeNull();

    // Prezentatsiya fon worker'ida tayyorlanadi
    await generatePresentation(h2.deps, pres.id, { finalAttempt: true });
    const ready = await h2.db.presentation.findUniqueOrThrow({ where: { id: pres.id } });
    expect(ready.status).toBe("ready");
    expect(ready.telegramFileId).toMatch(/^doc-/);

    // Payshanba 20:00 — eslatma faylni qayta yuboradi
    clock.set("2026-10-29T15:00:20Z");
    h2.tg.reset();
    expect(await h2.scheduler.tick()).toBe(1);
    const doc = h2.tg.sent("sendDocument");
    expect(doc).toHaveLength(1);
    expect(doc[0].payload.document).toBe(ready.telegramFileId);
    expect(doc[0].payload.caption).toContain("Juma kungi prezentatsiyangiz tayyor. O‘qib chiqishni unutmang.");
  });

  it("o'tib ketgan vaqtga eslatmada tushunarli savol beradi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { category: "personal", title: "Dori ichish", remind_at: "2026-10-24T10:00" })] });
    await h.text("Bugun soat 10 da dori ichishni eslat");
    expect(await h.db.task.count()).toBe(0);
    expect(h.tg.lastText()).toContain("24-oktabr, 10:00 allaqachon o‘tib ketgan. Qachon eslatay?");
    const kb = h.tg.lastKeyboard();
    expect(kb[0][0].text).toBe("10 daqiqadan keyin");
    expect(kb[1][0].text).toContain("Ertaga shu vaqtda (10:00)");
    await h.click(kb[0][0].callback_data);
    const rem = await h.db.reminder.findFirstOrThrow();
    expect(rem.fireAt.toISOString()).toBe("2026-10-24T08:10:00.000Z");
  });

  it("/cancel kutilayotgan savolni bekor qiladi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_presentation", { title: "Prezentatsiya" })] });
    await h.text("prezentatsiya tayyorla");
    expect(h.tg.lastText()).toContain("Prezentatsiya qaysi mavzuda bo‘lsin?");
    await h.command("cancel");
    expect(h.tg.lastText()).toBe("Joriy jarayon bekor qilindi.");
    expect((await h.db.conversationState.findFirstOrThrow()).pending).toBeNull();
  });
});

describe("8. 'Aziz kelmaydi' → 'Aziz kelarkan' (Misol C va D)", () => {
  const azizNote = (event = "2026-10-25T15:00") =>
    a("create_note", {
      category: "study",
      note_kind: "absence",
      person_name: "Aziz",
      title: "Aziz darsga kelmaydi",
      event_at: event,
      remind_before_event_minutes: 30,
      reminder_text: "{event_day} soat {event_time} dagi darsga Aziz kelmasligini aytgandingiz.",
    });

  it("qayd va darsdan 30 daqiqa oldingi eslatma; vaqtida to'g'ri matn yuboriladi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [azizNote()] });
    await h.text("Ertaga soat uchdagi darsga Aziz kelmaydi. Darsdan yarim soat oldin eslat.");
    const note = await h.db.note.findFirstOrThrow({ include: { reminders: true } });
    expect(note.kind).toBe("absence");
    expect(note.personName).toBe("Aziz");
    expect(note.eventAt?.toISOString()).toBe("2026-10-25T10:00:00.000Z");
    expect(note.reminders[0].fireAt.toISOString()).toBe("2026-10-25T09:30:00.000Z");
    expect(note.reminders[0].anchor).toBe("event");
    expect(await h.db.task.count()).toBe(0);

    h.clock.set("2026-10-25T09:30:05Z");
    h.tg.reset();
    expect(await h.scheduler.tick()).toBe(1);
    expect(h.tg.lastText()).toBe("🔔 Bugun soat 15:00 dagi darsga Aziz kelmasligini aytgandingiz.");
  });

  it("'Aziz kelarkan, eslatmani bekor qil' — qayd yangilanadi, eslatma yuborilmaydi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [azizNote()] });
    await h.text("Ertaga soat uchdagi darsga Aziz kelmaydi. Darsdan yarim soat oldin eslat.");
    h.ai.onExtract = (c) => ({ reply: null, actions: [a("cancel_reminder", { related_item_id: c.findRef(/Aziz/), person_name: "Aziz", description: "Aziz keladigan bo‘ldi" })] });
    await h.text("Aziz kelarkan, eslatmani bekor qil");

    const note = await h.db.note.findFirstOrThrow({ include: { reminders: true } });
    expect(note.status).toBe("cancelled");
    expect(note.statusReason).toBe("Aziz keladigan bo‘ldi");
    expect(note.reminders[0].status).toBe("cancelled");
    expect(h.tg.lastText()).toContain("🔕 Eslatma bekor qilindi: Aziz darsga kelmaydi");

    h.clock.set("2026-10-25T09:31:00Z");
    expect(await h.scheduler.tick()).toBe(0);
  });

  it("bir nechta mos qayd bo'lsa — taxmin qilmay, tanlatadi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [azizNote("2026-10-25T15:00"), azizNote("2026-10-26T10:00")] });
    await h.text("Ertaga 15 da va dushanba 10 dagi darsga Aziz kelmaydi");
    expect(await h.db.reminder.count({ where: { status: "scheduled" } })).toBe(2);

    h.ai.onExtract = (c) => ({ reply: null, actions: [a("cancel_reminder", { candidate_item_ids: c.findRefs(/Aziz/), person_name: "Aziz" })] });
    await h.text("Aziz kelarkan, eslatmani bekor qil");
    expect(h.tg.lastText()).toContain("Qaysi birini nazarda tutdingiz?");
    const kb = h.tg.lastKeyboard();
    expect(kb).toHaveLength(2);
    const choice = kb.find((r) => r[0].text.includes("26-oktabr"))!;
    await h.click(choice[0].callback_data);

    const notes = await h.db.note.findMany({ include: { reminders: true }, orderBy: { eventAt: "asc" } });
    expect(notes[0].status).toBe("active");
    expect(notes[0].reminders[0].status).toBe("scheduled");
    expect(notes[1].status).toBe("cancelled");
    expect(notes[1].reminders[0].status).toBe("cancelled");
  });
});

describe("Misol E: so'rovlar", () => {
  async function seed() {
    const h = makeHarness();
    h.ai.onExtract = () => ({
      reply: null,
      actions: [
        a("create_task", { category: "work", title: "Mijozga qo‘ng‘iroq qilish", event_at: "2026-10-25T09:00", remind_at: "2026-10-25T09:00" }),
        a("create_task", { category: "study", title: "Kitob o‘qish", event_at: "2026-10-25T18:00" }),
        a("create_task", { category: "home", title: "Bozorga borish", event_at: "2026-10-24T17:00" }),
        a("create_note", { category: "study", note_kind: "absence", person_name: "Aziz", title: "Aziz darsga kelmaydi", event_at: "2026-10-25T15:00" }),
        a("create_note", { category: "study", note_kind: "absence", person_name: "Malika", title: "Malika darsga kelmaydi", event_at: "2026-11-03T15:00" }),
      ],
    });
    await h.text("seed");
    return h;
  }

  it("'Bugun nima ishlarim bor?' va 'Ertangi o'qish vazifalarim'", async () => {
    const h = await seed();
    h.ai.onExtract = () => ({ reply: null, actions: [a("list_items", { list_filter: { range: "today", item_type: "any", category: null, person_name: null, note_kind: null, query_text: null, status: "active" } })] });
    await h.text("Bugun nima ishlarim bor?");
    let reply = h.tg.lastText();
    expect(reply).toContain("📋 Bugungi ishlar");
    expect(reply).toContain("Bozorga borish — 17:00");
    expect(reply).not.toContain("Mijozga");

    h.ai.onExtract = () => ({ reply: null, actions: [a("list_items", { list_filter: { range: "tomorrow", item_type: "task", category: "study", person_name: null, note_kind: null, query_text: null, status: "active" } })] });
    await h.text("Ertangi o‘qish vazifalarimni ko‘rsat");
    reply = h.tg.lastText();
    expect(reply).toContain("Kitob o‘qish — 18:00");
    expect(reply).not.toContain("Mijozga");
    expect(reply).not.toContain("Bozorga");
  });

  it("'Oxirgi vazifani bajarildi deb belgila' va 'Mijozga qo'ng'iroqni ertaga o'nga sur'", async () => {
    const h = await seed();
    h.ai.onExtract = (c) => ({ reply: null, actions: [a("complete_task", { related_item_id: c.findRef(/task \|/) })] });
    await h.text("Oxirgi vazifani bajarildi deb belgilagin");
    expect(h.tg.lastText()).toBe("✅ Bajarildi: Bozorga borish");
    expect((await h.db.task.findFirstOrThrow({ where: { title: "Bozorga borish" } })).status).toBe("done");

    h.ai.onExtract = (c) => ({ reply: null, actions: [a("update_item", { update_op: "reschedule", related_item_id: c.findRef(/Mijozga/), event_at: "2026-10-25T10:00" })] });
    await h.text("Mijozga qo‘ng‘iroqni ertaga o‘nga sur");
    expect(h.tg.lastText()).toBe("🔁 Ko‘chirildi: Mijozga qo‘ng‘iroq qilish\n25-oktabr, 09:00 → 25-oktabr, 10:00");
    const t = await h.db.task.findFirstOrThrow({ where: { title: { startsWith: "Mijozga" } }, include: { reminders: true } });
    expect(t.eventAt?.toISOString()).toBe("2026-10-25T05:00:00.000Z");
    expect(t.reminders[0].fireAt.toISOString()).toBe("2026-10-25T05:00:00.000Z");
    expect(t.reminders[0].version).toBe(2);
  });

  it("'Bu haftada kimlar darsga kelmasligini aytgandim?' va 'Prezentatsiyam tayyormi?'", async () => {
    const h = await seed();
    h.ai.onExtract = () => ({ reply: null, actions: [a("search_notes", { list_filter: { range: "this_week", item_type: "note", category: null, person_name: null, note_kind: "absence", query_text: null, status: "any" } })] });
    await h.text("Bu haftada kimlar darsga kelmasligini aytgandim?");
    const reply = h.tg.lastText();
    expect(reply).toContain("🙋 Kelmasligi aytilganlar");
    expect(reply).toContain("• Aziz — 25-oktabr, 15:00");
    expect(reply).not.toContain("Malika");

    await h.db.presentation.create({ data: { userId: (await h.user()).id, topic: "Startaplar", status: "generating", stage: "content" } });
    h.ai.onExtract = () => ({ reply: null, actions: [a("list_items", { list_filter: { range: "all", item_type: "presentation", category: null, person_name: null, note_kind: null, query_text: null, status: "any" } })] });
    await h.text("Prezentatsiyam tayyormi?");
    expect(h.tg.lastText()).toContain("Startaplar — 10 · yaratilmoqda (mazmun yozilmoqda)");
  });

  it("/today buyrug'i va menyu tugmasi", async () => {
    const h = await seed();
    await h.command("today");
    expect(h.tg.lastText()).toContain("Bozorga borish — 17:00");
    await h.text("✅ Vazifalarim");
    expect(h.tg.lastText()).toContain("Mijozga qo‘ng‘iroq qilish");
    expect(h.tg.lastText()).toContain("Kitob o‘qish");
  });
});

describe("6. Takroriy update dublikat yaratmaydi", () => {
  it("bir xil update_id ikki marta kelsa — bitta vazifa, AI bir marta", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { title: "Hisobot yozish", category: "work" })] });
    await h.text("Hisobot yozishim kerak", 1, 777001);
    await h.text("Hisobot yozishim kerak", 1, 777001);
    expect(await h.db.task.count()).toBe(1);
    expect(h.ai.calls.filter((c) => c === "extract")).toHaveLength(1);
  });

  it("ProcessedUpdate yo'qolsa ham InboundMessage.processedAt ikkinchi yozuvni to'xtatadi", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { title: "Hisobot yozish", category: "work" })] });
    await h.text("Hisobot", 1, 777002);
    await h.db.processedUpdate.deleteMany();
    await h.text("Hisobot", 1, 777002);
    expect(await h.db.task.count()).toBe(1);
  });
});

describe("10. AI (Groq) xatosidan tiklanish", () => {
  it("matn: AI ishlamasa — 'Qayta urinish', keyin muvaffaqiyatli saqlanadi", async () => {
    const h = makeHarness();
    h.ai.failNext.extract = aiError("unavailable");
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { title: "Hisobot yozish", category: "work" })] });
    await h.text("Hisobot yozishim kerak");
    expect(await h.db.task.count()).toBe(0);
    expect(h.tg.lastText()).toContain("AI xizmati hozir javob bermayapti");
    expect(h.tg.lastKeyboard()[0][0].callback_data).toBe("rt");

    await h.click("rt");
    expect(await h.db.task.count()).toBe(1);
    expect(h.tg.lastText()).toContain("✅ Saqlandi");
    // Ikkinchi marta bosish — eskirgan
    await h.click("rt");
    expect(h.tg.answers().at(-1)).toContain("eskirgan");
    expect(await h.db.task.count()).toBe(1);
  });

  it("ovoz: transkripsiya xatosidan keyin qayta urinish", async () => {
    const h = makeHarness();
    h.ai.transcript = "Ertaga 10 da yig‘ilish";
    h.ai.failNext.transcribe = aiError("rate_limit");
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { title: "Yig‘ilish", category: "work", event_at: "2026-10-25T10:00" })] });
    await h.voice();
    expect(h.tg.lastText()).toContain("AI so‘rovlar limiti vaqtincha tugadi");
    await h.click("rt");
    expect(await h.db.task.count()).toBe(1);
    expect(h.ai.calls).toEqual(["transcribe", "transcribe", "extract"]);
  });

  it("kunlik limit — foydalanuvchiga haqiqiy kutish vaqti aytiladi (1 daqiqa emas)", async () => {
    const h = makeHarness();
    const { AiError } = await import("../src/ai/provider.ts");
    h.ai.failNext.extract = new AiError("rate_limit", "x", true, 1845);
    await h.text("Ertaga 10 da yig‘ilish");
    expect(h.tg.lastText()).toContain("kunlik limiti tugadi");
    expect(h.tg.lastText()).toContain("31 daqiqadan keyin");
  });

  it("GROQ_API_KEY yo'q — tushunarli xabar, stub natija yo'q", async () => {
    const h = makeHarness();
    h.ai.failNext.extract = aiError("not_configured");
    await h.text("Salom");
    expect(h.tg.lastText()).toContain("AI xizmati sozlanmagan");
  });
});
