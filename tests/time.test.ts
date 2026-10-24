import { describe, expect, it } from "vitest";
import { calendarContext, dayRange, formatDateTime, nextOccurrence, parseLocal, toLocalIso } from "../src/lib/time.ts";
import { ExtractionSchema, toStrictJsonSchema } from "../src/ai/schemas.ts";
import { applyAnswer, checkTimeHints } from "../src/core/plan.ts";
import { t } from "../src/lib/i18n.ts";
import { emptyAction } from "../src/ai/schemas.ts";
import { fillTemplate } from "../src/core/format.ts";
import { clip, hasUnverifiedStat, normalizeText } from "../src/presentations/sanitize.ts";
import { fitFontSize } from "../src/presentations/render.ts";

const TZ = "Asia/Tashkent";
// 2026-10-24 13:00 Toshkent (shanba)
const NOW = new Date("2026-10-24T08:00:00Z");

describe("Asia/Tashkent vaqt hisoblari", () => {
  it("mahalliy vaqtni UTC'ga aylantiradi (UTC+5)", () => {
    expect(parseLocal("2026-10-25T09:00", TZ)!.date.toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(parseLocal("2026-10-30", TZ)).toEqual({ date: new Date("2026-10-29T19:00:00Z"), allDay: true });
    expect(parseLocal("2026-10-25T09:00+03:00", TZ)).toBeNull();
    expect(parseLocal("ertaga", TZ)).toBeNull();
    expect(parseLocal("2026-02-30T10:00", TZ)).toBeNull();
  });

  it("UTC'dan mahalliy ko'rinishga va o'zbekcha formatga", () => {
    const d = new Date("2026-10-29T15:00:00Z");
    expect(toLocalIso(d, TZ)).toBe("2026-10-29T20:00");
    expect(formatDateTime(d, TZ, "uz")).toBe("29-oktabr, 20:00");
    expect(formatDateTime(d, TZ, "ru")).toBe("29 октября, 20:00");
    expect(formatDateTime(new Date("2026-10-29T19:00:00Z"), TZ, "uz", { allDay: true, weekday: true })).toBe("30-oktabr (juma)");
  });

  it("kalendar konteksti hafta kunlarini to'g'ri beradi (AI uchun)", () => {
    const cal = calendarContext(NOW, TZ);
    expect(cal).toContain("shanba / суббота (weekday 6) = 2026-10-24 (bugun/сегодня)");
    expect(cal).toContain("yakshanba / воскресенье (weekday 7) = 2026-10-25 (ertaga/завтра)");
    expect(cal).toContain("payshanba / четверг (weekday 4) = 2026-10-29");
    expect(cal).toContain("juma / пятница (weekday 5) = 2026-10-30");
  });

  it("kun oralig'i foydalanuvchi timezone'i bo'yicha", () => {
    const today = dayRange("today", NOW, TZ);
    expect(today.start!.toISOString()).toBe("2026-10-23T19:00:00.000Z");
    expect(today.end!.toISOString()).toBe("2026-10-24T18:59:59.999Z");
    // Toshkentda yarim tun o'tgan, UTC'da hali kechagi kun
    const lateNight = new Date("2026-10-24T19:30:00Z"); // 00:30 25-okt Toshkent
    expect(dayRange("today", lateNight, TZ).start!.toISOString()).toBe("2026-10-24T19:00:00.000Z");
    const week = dayRange("this_week", NOW, TZ);
    expect(toLocalIso(week.start!, TZ)).toBe("2026-10-19T00:00"); // dushanba
  });

  it("takroriy eslatmalar: kunlik va haftalik", () => {
    const daily = nextOccurrence({ freq: "daily", interval: 1, byWeekday: [], time: "08:00" }, NOW, TZ);
    expect(daily.toISOString()).toBe("2026-10-25T03:00:00.000Z");
    const weekly = nextOccurrence({ freq: "weekly", interval: 1, byWeekday: [1, 3], time: "09:30" }, NOW, TZ);
    expect(toLocalIso(weekly, TZ)).toBe("2026-10-26T09:30"); // dushanba
    const afterMon = nextOccurrence({ freq: "weekly", interval: 1, byWeekday: [1, 3], time: "09:30" }, weekly, TZ);
    expect(toLocalIso(afterMon, TZ)).toBe("2026-10-28T09:30"); // chorshanba
    // Bugungi vaqt hali kelmagan bo'lsa — bugun
    expect(toLocalIso(nextOccurrence({ freq: "daily", interval: 1, byWeekday: [], time: "18:00" }, NOW, TZ), TZ)).toBe("2026-10-24T18:00");
  });

  it("eslatma shabloni: bugun, vaqt va hafta kuni", () => {
    const user = { timezone: TZ, language: "uz" } as never;
    const event = new Date("2026-10-25T10:00:00Z");
    const fired = new Date("2026-10-25T09:30:00Z");
    expect(fillTemplate("{event_day} soat {event_time} dagi darsga Aziz kelmasligini aytgandingiz.", user, { now: fired, event })).toBe(
      "Bugun soat 15:00 dagi darsga Aziz kelmasligini aytgandingiz.",
    );
    expect(fillTemplate("{due_weekday} kungi prezentatsiyangiz tayyor.", user, { now: fired, due: new Date("2026-10-29T19:00:00Z") })).toBe("Juma kungi prezentatsiyangiz tayyor.");
  });
});

describe("AI sxemasi va javoblarni qo'llash", () => {
  it("strict JSON schema: barcha obyektlar yopiq va barcha maydonlar required", () => {
    const s = toStrictJsonSchema(ExtractionSchema) as { properties: { actions: { items: { required: string[]; additionalProperties: boolean; properties: object } } } };
    const item = s.properties.actions.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
    for (const f of ["intent", "category", "title", "description", "person_name", "due_at", "event_at", "remind_at", "timezone", "recurrence", "related_item_id", "presentation_topic", "presentation_language", "slide_count", "missing_fields"]) {
      expect(item.required).toContain(f);
    }
  });

  it("tugma javobi kerakli maydonni to'ldiradi va noaniqlikni tozalaydi", () => {
    const act = emptyAction("create_reminder", { missing_fields: ["remind_at_ampm"], clarification_question: "?", location_trigger: "uyga qaytayotganda" });
    const next = applyAnswer(act, "remind_at_ampm", "2026-10-29T20:00");
    expect(next.remind_at).toBe("2026-10-29T20:00");
    expect(next.missing_fields).toEqual([]);
    expect(next.location_trigger).toBeNull();
  });
});

describe("Prezentatsiya matnini tekshirish", () => {
  it("manbasiz statistikani aniqlaydi, foydalanuvchi bergan raqamni qoldiradi", () => {
    expect(hasUnverifiedStat("Bozor 45% o'sdi", "")).toBe(true);
    expect(hasUnverifiedStat("Investitsiya 2 mlrd dollar", "")).toBe(true);
    expect(hasUnverifiedStat("Bozor 45% o'sdi", "material: bozor 45% o'sgan")).toBe(false);
    expect(hasUnverifiedStat("3 bosqich mavjud", "")).toBe(false);
  });
  it("o'zbek apostroflari va qisqartirish", () => {
    expect(normalizeText("o'qish va g'oya, ma'lumot", "uz")).toBe("o‘qish va g‘oya, ma’lumot");
    expect(clip("bir ikki uch to'rt besh olti", 15)).toBe("bir ikki uch…");
  });
  it("uzun matn uchun shrift kichrayadi", () => {
    const short = fitFontSize(["Qisqa"], 8.8, 3.75, 24, 12);
    const long = fitFontSize(Array(6).fill("Juda uzun punkt matni ".repeat(5)), 8.8, 3.75, 24, 12);
    expect(short).toBe(24);
    expect(long).toBeLessThan(20);
  });
});

describe("Sana himoyasi (time_hints)", () => {
  it("'darsga soat uchda' (kun qismisiz) — 03:00 emas, 15:00; eslatma ham suriladi", () => {
    const act = emptyAction("create_note", { title: "Aziz", event_at: "2026-10-25T03:00", remind_at: "2026-10-25T02:30", time_hints: [{ field: "event_at", weekday: null, spoken_hour: 3, day_part_said: false }] });
    const r = checkTimeHints(act, TZ, NOW, t("uz"));
    expect(r.action.event_at).toBe("2026-10-25T15:00");
    expect(r.action.remind_at).toBe("2026-10-25T14:30");
    expect(r.issue).toBeNull();
  });
  it("'soat sakkiz' kun qismisiz — AI 08:00 tanlasa ham so'raladi; 'kechqurun' aytilgan bo'lsa so'ralmaydi", () => {
    const L = t("uz");
    const amb = emptyAction("create_reminder", { title: "O‘qib chiqish", remind_at: "2026-10-29T08:00", time_hints: [{ field: "remind_at", weekday: 4, spoken_hour: 8, day_part_said: false }] });
    const r = checkTimeHints(amb, TZ, NOW, L);
    expect(r.issue?.options.map((o) => o.label)).toEqual(["08:00", "20:00"]);
    const clear = { ...amb, time_hints: [{ field: "remind_at" as const, weekday: 4, spoken_hour: 8, day_part_said: true }] };
    expect(checkTimeHints(clear, TZ, NOW, L).issue).toBeNull();
    const ten = emptyAction("update_item", { event_at: "2026-10-25T10:00", time_hints: [{ field: "event_at", weekday: null, spoken_hour: 10, day_part_said: false }] });
    expect(checkTimeHints(ten, TZ, NOW, L).issue).toBeNull();
  });
  const L = t("uz");
  it("AI hafta kunini noto'g'ri hisoblasa — eng yaqin to'g'ri kunga tuzatiladi", () => {
    const act = emptyAction("create_note", { title: "Malika darsga kelmaydi", event_at: "2026-10-26T16:00", time_hints: [{ field: "event_at", weekday: 5, spoken_hour: 4, day_part_said: false }] });
    const r = checkTimeHints(act, TZ, NOW, L);
    expect(r.action.event_at).toBe("2026-10-30T16:00");
    expect(r.issue).toBeNull();
  });
  it("soat aytilgan raqamga mos kelmasa — so'raydi", () => {
    const act = emptyAction("create_note", { title: "Dars", event_at: "2026-10-30T14:00", time_hints: [{ field: "event_at", weekday: 5, spoken_hour: 4, day_part_said: false }] });
    const r = checkTimeHints(act, TZ, NOW, L);
    expect(r.issue?.text).toBe("«Dars» — aniq soat nechada?");
    expect(r.issue?.options.map((o) => o.value)).toEqual(["2026-10-30T04:00", "2026-10-30T16:00"]);
  });
  it("to'g'ri sana o'zgarmaydi; o'tgan juma emas, kelasi juma", () => {
    const ok = emptyAction("create_task", { remind_at: "2026-10-30T20:00", time_hints: [{ field: "remind_at", weekday: 5, spoken_hour: 8, day_part_said: true }] });
    expect(checkTimeHints(ok, TZ, NOW, L).action.remind_at).toBe("2026-10-30T20:00");
    const past = emptyAction("create_task", { remind_at: "2026-10-23T20:00", time_hints: [{ field: "remind_at", weekday: 5, spoken_hour: 8, day_part_said: true }] });
    expect(checkTimeHints(past, TZ, NOW, L).action.remind_at).toBe("2026-10-30T20:00");
  });
});
