import { existsSync, readFileSync } from "node:fs";
import JSZip from "jszip";
import { InputFile } from "grammy";
import { beforeEach, describe, expect, it } from "vitest";
import { a, aiError, makeHarness, resetDb } from "./helpers.ts";
import { generatePresentation, sweepQueued } from "../src/presentations/generate.ts";

beforeEach(resetDb);

async function requestPresentation(h: ReturnType<typeof makeHarness>, topic = "Startaplarni moliyalashtirish") {
  h.ai.onExtract = () => ({ reply: null, actions: [a("create_presentation", { category: "study", presentation_topic: topic, presentation_language: "uz", slide_count: 5 })] });
  await h.text(`${topic} mavzusida 5 slaydli prezentatsiya tayyorla`);
  return h.db.presentation.findFirstOrThrow({ where: { topic } });
}

describe("9. PPTX yaratish va Telegram'ga yuborish", () => {
  it("queued → generating → ready; haqiqiy PPTX fayl, file_id saqlanadi, statuslar ko'rsatiladi", async () => {
    const h = makeHarness();
    const pres = await requestPresentation(h);
    expect(pres.status).toBe("queued");
    expect(h.enqueued).toEqual([pres.id]);
    expect(h.tg.lastText()).toContain("⏳ Prezentatsiya navbatga qo‘yildi");

    h.tg.reset();
    await generatePresentation(h.deps, pres.id, { finalAttempt: true });
    const done = await h.db.presentation.findUniqueOrThrow({ where: { id: pres.id } });
    expect(done.status).toBe("ready");
    expect(done.slideCount).toBe(5); // titul + 4
    expect(done.telegramFileId).toMatch(/^doc-/);
    expect(done.fileName).toBe("Startaplarni_moliyalashtirish.pptx");

    // Holat xabarlari: reja → mazmun → render → yuborish → tayyor
    const statusTexts = h.tg.texts();
    expect(statusTexts.some((t) => t.includes("slaydlar rejasi tuzilmoqda"))).toBe(true);
    expect(statusTexts.some((t) => t.includes("PPTX fayl yaratilmoqda"))).toBe(true);
    expect(statusTexts.at(-1)).toBe("✅ «Startaplarni moliyalashtirish» — prezentatsiya tayyor (5 slayd).");

    // Telegram'ga haqiqiy fayl (InputFile) yuborildi
    const doc = h.tg.sent("sendDocument")[0];
    expect(doc.payload.document).toBeInstanceOf(InputFile);

    // Fayl — ochiladigan PPTX (zip), 5 slayd, 16:9, manbasiz "37%" yo'q
    expect(existsSync(done.filePath!)).toBe(true);
    const zip = await JSZip.loadAsync(readFileSync(done.filePath!));
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides).toHaveLength(5);
    expect(await zip.file("ppt/presentation.xml")!.async("string")).toContain('cx="9144000" cy="5143500"');
    const all = (await Promise.all(slides.map((s) => zip.file(s)!.async("string")))).join("");
    expect(all).not.toContain("37%");
    expect(all).toContain("Startap tushunchasi");
    expect(all).toContain("<a:tbl>"); // jadval
  });

  it("xato: oraliq urinishda qayta tashlanadi; oxirgisida 'failed' + qayta urinish tugmasi; 'tayyor' deyilmaydi", async () => {
    const h = makeHarness();
    const pres = await requestPresentation(h);
    h.ai.failNext.presentation_content = aiError("unavailable");
    await expect(generatePresentation(h.deps, pres.id, { finalAttempt: false })).rejects.toThrow();
    expect((await h.db.presentation.findUniqueOrThrow({ where: { id: pres.id } })).status).toBe("generating");

    h.ai.failNext.presentation_content = aiError("unavailable");
    h.tg.reset();
    await generatePresentation(h.deps, pres.id, { finalAttempt: true });
    const failed = await h.db.presentation.findUniqueOrThrow({ where: { id: pres.id } });
    expect(failed.status).toBe("failed");
    expect(h.tg.sent("sendDocument")).toHaveLength(0);
    expect(h.tg.texts().some((t) => t.includes("tayyor"))).toBe(false);
    expect(h.tg.lastText()).toContain("prezentatsiyani yaratib bo‘lmadi");
    expect(h.tg.lastKeyboard()[0][0].callback_data).toBe(`pr:${pres.id}`);

    // Qayta urinish
    await h.click(`pr:${pres.id}`);
    expect((await h.db.presentation.findUniqueOrThrow({ where: { id: pres.id } })).status).toBe("queued");
    expect(h.enqueued).toHaveLength(2);
    await generatePresentation(h.deps, pres.id, { finalAttempt: true });
    expect((await h.db.presentation.findUniqueOrThrow({ where: { id: pres.id } })).status).toBe("ready");
    // Tayyor prezentatsiyada "qayta urinish" tugmasi eskirgan
    await h.click(`pr:${pres.id}`);
    expect(h.tg.answers().at(-1)).toContain("eskirgan");
  });

  it("mavzu yo'q bo'lsa so'raydi; uy vazifasi haqidagi xabar avtomatik prezentatsiya buyrug'i emas", async () => {
    const h = makeHarness();
    h.ai.onExtract = () => ({ reply: null, actions: [a("create_task", { category: "study", title: "Iqtisodiyotdan prezentatsiya topshirish", due_at: "2026-10-30", mentions_presentation: true })] });
    await h.text("Juma kuni iqtisodiyotdan prezentatsiya topshiraman");
    expect(await h.db.presentation.count()).toBe(0);
    const kb = h.tg.lastKeyboard();
    expect(kb[0][0].text).toBe("📎 Prezentatsiya tayyorlab beraymi?");

    // Foydalanuvchi o'zi so'rasa — mavzu so'raladi
    await h.click(kb[0][0].callback_data);
    expect(h.tg.lastText()).toBe("❓ Prezentatsiya qaysi mavzuda bo‘lsin?");
    h.ai.onResolve = (pending) => ({ relates: true, actions: [{ ...pending[0], presentation_topic: "Inflyatsiya va uning sabablari", missing_fields: [] }] });
    await h.text("Inflyatsiya va uning sabablari");
    const pres = await h.db.presentation.findFirstOrThrow({ include: { task: true } });
    expect(pres.topic).toBe("Inflyatsiya va uning sabablari");
    expect(pres.task?.title).toBe("Iqtisodiyotdan prezentatsiya topshirish");
  });

  it("limitlar: bir vaqtda faol prezentatsiya cheklovi va sweeper qayta navbatga qo'yadi", async () => {
    const h = makeHarness();
    const p1 = await requestPresentation(h, "Birinchi mavzu");
    await requestPresentation(h, "Ikkinchi mavzu").catch(() => null);
    expect(await h.db.presentation.count()).toBe(1);
    expect(h.tg.lastText()).toContain("Sizda hozir tayyorlanayotgan prezentatsiya bor");

    h.enqueued.length = 0;
    // updatedAt'ni Prisma haqiqiy soat bilan yozadi — sweeper soatini shunga nisbatan suramiz
    h.clock.set(new Date(Date.now() + 5 * 60_000).toISOString());
    expect(await sweepQueued(h.deps)).toBe(1);
    expect(h.enqueued).toEqual([p1.id]);
  });
});
