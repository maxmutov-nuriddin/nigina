import type { Lang } from "./time.ts";

type Cat = "work" | "home" | "study" | "personal" | "other";

/** Kutish vaqti so'z bilan: "35 daqiqa", "2 soat" / "35 минут", "2 ч" */
function waitText(sec: number, lang: Lang): string {
  const min = Math.ceil(sec / 60);
  if (min < 90) return lang === "ru" ? `${min} мин` : `${min} daqiqa`;
  const h = Math.round(min / 60);
  return lang === "ru" ? `${h} ч` : `${h} soat`;
}

const uz = {
  welcome: (name: string, tz: string) =>
    `Assalomu alaykum, ${name}! 👋\n\nMen — vazifalaringizni eslab qoladigan va vaqtida eslatadigan yordamchingizman.\n\n` +
    `🎙 Menga oddiy suhbatdagidek ovozli yoki matnli xabar yuboring:\n` +
    `• «Ertaga soat 9 da mijozga qo‘ng‘iroq qilishim kerak»\n` +
    `• «Ertaga soat 3 dagi darsga Aziz kelmaydi. Darsdan yarim soat oldin eslat»\n` +
    `• «Startaplarni moliyalashtirish mavzusida 10 slaydli prezentatsiya tayyorla»\n` +
    `• «Taksiga 30 ming ketdi» — xarajatlar va oy oxiri prognozi: /finance\n\n` +
    `🕒 Vaqt mintaqangiz: ${tz}. O‘zgartirish: /settings\n\n` +
    `ℹ️ Telegram botlar faqat /start bosgan foydalanuvchiga yoza oladi — shuning uchun eslatmalar ishlashi uchun botni bloklamang.`,
  help:
    `🎙 Ovozli buyruq misollari:\n\n` +
    `• «Ertaga ertalab 9 da mijozga qo‘ng‘iroq qilishim kerak»\n` +
    `• «Juma kuni iqtisodiyotdan prezentatsiya topshiraman»\n` +
    `• «Har kuni soat 8 da dori ichishni eslat»\n` +
    `• «Ertaga soat 3 dagi darsga Aziz kelmaydi, darsdan yarim soat oldin eslat»\n` +
    `• «Aziz kelarkan, eslatmani bekor qil»\n` +
    `• «Bugun nima ishlarim bor?»\n` +
    `• «Mijozga qo‘ng‘iroqni ertaga o‘nga sur»\n` +
    `• «Oxirgi vazifani bajarildi deb belgila»\n` +
    `• «Prezentatsiyam tayyormi?»\n` +
    `• «Taksiga 30 ming, bozorga 250 ming ketdi»\n` +
    `• «Oylik tushdi 6 mln»\n` +
    `• «Oy oxirida foydadamanmi yoki zarardami?»\n\n` +
    `Buyruqlar: /today /week /tasks /notes /finance /settings /cancel`,
  menu: { today: "📋 Bugungi ishlar", tasks: "✅ Vazifalarim", notes: "📝 Qaydlarim", finance: "💰 Moliya", presentations: "📎 Prezentatsiyalar", settings: "⚙️ Sozlamalar" },
  listening: "🎧 Ovozingizni tushunyapman…",
  thinking: "🤔 Tushunyapman…",
  saved: "✅ Saqlandi",
  partialFail: "⚠️ Ba’zi amallar bajarilmadi:",
  notSaved: "❌ Saqlanmadi",
  cat: { work: "💼 Ish", home: "🏠 Uy", study: "📚 O‘qish", personal: "👤 Shaxsiy", other: "📌 Boshqa" } as Record<Cat, string>,
  reminderLine: (dt: string) => `🔔 Eslatma: ${dt}`,
  eventLine: (dt: string) => `🕒 Vaqti: ${dt}`,
  dueLine: (dt: string) => `📅 Muddat: ${dt}`,
  deadlineRemindersLine: (dts: string[]) => `🔔 Muddat eslatmasi: ${dts.join(" va ")}`,
  deadlineBefore: (title: string) => `⏳ Ertaga «${title}» muddati. Tayyormisiz?`,
  deadlineToday: (title: string) => `⏳ Bugun «${title}» muddati.`,
  presTaskTitle: (topic: string) => `Prezentatsiya: ${topic}`,
  repeatLine: (r: string) => `🔁 Takror: ${r}`,
  noteLine: (t: string) => `📝 Qayd: ${t}`,
  presLine: (n: number, lang: string) => `📎 Prezentatsiya: ${n} slayd, ${langName(lang, "uz")}`,
  presQueued: "⏳ Prezentatsiya navbatga qo‘yildi",
  question: (q: string, i: number, n: number) => (n > 1 ? `❓ (${i}/${n}) ${q}` : `❓ ${q}`),
  pastTime: (dt: string) => `${dt} allaqachon o‘tib ketgan. Qachon eslatay?`,
  locationQ: (phrase: string) => `📍 «${phrase}» — men joylashuvni kuzatmayman. Qaysi vaqtda eslatay?`,
  whenRemind: "Qachon eslatay?",
  whatHour: (title: string) => (title ? `«${title}» — aniq soat nechada?` : "Aniq soat nechada?"),
  presTopicQ: "Prezentatsiya qaysi mavzuda bo‘lsin?",
  chooseItem: "Qaysi birini nazarda tutdingiz?",
  notFound: "🤷 Mos yozuv topilmadi. Aniqroq aytib bera olasizmi?",
  completed: (t: string) => `✅ Bajarildi: ${t}`,
  rescheduled: (t: string, from: string, to: string) => `🔁 Ko‘chirildi: ${t}\n${from} → ${to}`,
  edited: (t: string) => `✏️ O‘zgartirildi: ${t}`,
  itemCancelled: (t: string) => `🗑 Bekor qilindi: ${t}`,
  reminderCancelled: (t: string) => `🔕 Eslatma bekor qilindi: ${t}`,
  noteClosed: (t: string, reason: string | null) => `📝 Qayd yangilandi: ${t}${reason ? ` — ${reason}` : ""}`,
  noReminders: (t: string) => `ℹ️ «${t}» uchun faol eslatma yo‘q edi.`,
  lists: {
    today: "📋 Bugungi ishlar",
    tomorrow: "📋 Ertangi ishlar",
    this_week: "📅 Shu haftadagi ishlar",
    next_week: "📅 Keyingi hafta",
    overdue: "⏰ Muddati o‘tganlar",
    all: "✅ Faol vazifalar",
    notes: "📝 Qaydlar",
    presentations: "📎 Prezentatsiyalar",
    absences: "🙋 Kelmasligi aytilganlar",
  },
  empty: "Hozircha hech narsa yo‘q.",
  reminderFire: (title: string) => `🔔 ${title}`,
  latePrefix: (planned: string) => `⏰ Kechikkan eslatma (rejada: ${planned}) — bot vaqtincha ishlamay qolgan edi.`,
  missedSummary: (lines: string) => `⚠️ Bot ishlamay qolgan paytda quyidagi eslatmalar vaqtida yuborilmadi:\n${lines}`,
  presNotReady: (status: string) => `⚠️ Prezentatsiya hali tayyor emas (holati: ${status}).`,
  btn: {
    done: "✅ Bajarildi",
    snooze10: "⏱ 10 daqiqaga",
    snooze60: "⏱ 1 soatga",
    changeTime: "🕒 Vaqtini o‘zgartirish",
    cancel: "🗑 Bekor qilish",
    retry: "🔄 Qayta urinish",
    openPres: "📎 Faylni ochish",
    makePres: "📎 Prezentatsiya tayyorlab beraymi?",
    yes: "Ha",
    no: "Yo‘q",
    deleteData: "🗑 Ma’lumotlarimni o‘chirish",
    aiRefresh: "🔄 AI holatini yangilash",
    requests: (n: number) => `📥 Yangi so‘rovlar${n ? ` (${n})` : ""}`,
    langUz: "🇺🇿 O‘zbekcha",
    langRu: "🇷🇺 Русский",
    tz: "🕒 Vaqt mintaqasi",
    defaultTime: "⏰ Standart eslatma vaqti",
    remindersOn: "🔔 Eslatmalar: yoqilgan",
    remindersOff: "🔕 Eslatmalar: o‘chirilgan",
  },
  stale: "Bu tugma eskirgan — holat allaqachon o‘zgargan.",
  staleItem: (t: string, s: string) => `Bu tugma eskirgan: «${t}» — ${s}.`,
  statusWord: { done: "bajarilgan", cancelled: "bekor qilingan", sent: "yuborilgan", active: "faol" } as Record<string, string>,
  snoozed: (dt: string) => `⏱ Keyinga surildi: ${dt}`,
  askNewTime: (t: string) => `🕒 «${t}» uchun yangi vaqtni yozing yoki ayting (masalan: «ertaga 10:00»).`,
  newTimeQ: "Yangi vaqt qachon?",
  voiceTooLong: (max: number) => `Ovozli xabar juda uzun. Iltimos, ${Math.round(max / 60)} daqiqadan qisqa yuboring.`,
  voiceTooBig: "Ovozli xabar hajmi juda katta.",
  dailyLimit: "Bugungi foydalanish limiti tugadi. Ertaga yana urinib ko‘ring.",
  presActiveLimit: "Sizda hozir tayyorlanayotgan prezentatsiya bor. U tugagach yangisini so‘rang.",
  aiUnavailable: "😔 AI xizmati hozir javob bermayapti. Xabaringiz saqlanib qoldi — «Qayta urinish» tugmasini bosing.",
  aiNotConfigured: "⚙️ AI xizmati sozlanmagan (GROQ_API_KEY yo‘q). Administratorga murojaat qiling.",
  aiRateLimited: (waitSec: number | null) =>
    waitSec !== null && waitSec > 120
      ? `⏳ AI xizmatining kunlik limiti tugadi (Groq). Xabaringiz saqlandi — taxminan ${waitText(waitSec, "uz")}dan keyin «Qayta urinish»ni bosing.`
      : "⏳ AI so‘rovlar limiti vaqtincha tugadi (Groq: daqiqasiga token chegarasi). Xabaringiz saqlandi — taxminan 1 daqiqadan keyin «Qayta urinish»ni bosing.",
  emptyTranscript: "Ovozda nutq aniqlanmadi. Qaytadan, aniqroq gapirib ko‘ring.",
  lowConfidence: "Ovoz sifati past bo‘lishi mumkin — natijani tekshirib qo‘ying.",
  heard: (t: string) => `🗣 «${t}»`,
  pres: {
    queued: (topic: string) => `⏳ «${topic}» — prezentatsiya navbatda…`,
    generating: (topic: string, stage: string) => `🛠 «${topic}» — ${stage}…`,
    stages: { outline: "slaydlar rejasi tuzilmoqda", content: "mazmun yozilmoqda", render: "PPTX fayl yaratilmoqda", upload: "fayl yuborilmoqda" } as Record<string, string>,
    ready: (topic: string, n: number) => `✅ «${topic}» — prezentatsiya tayyor (${n} slayd).`,
    failed: (topic: string) => `❌ «${topic}» — prezentatsiyani yaratib bo‘lmadi. Qayta urinib ko‘rasizmi?`,
    statusName: { queued: "navbatda", generating: "yaratilmoqda", ready: "tayyor", failed: "xato" } as Record<string, string>,
    caption: (topic: string) => `📎 ${topic}\n\nℹ️ Raqamlar va faktlarni topshirishdan oldin tekshirib chiqing.`,
  },
  access: {
    requested: "⏳ Botdan foydalanish uchun so‘rovingiz yuborildi. Ruxsat berilgach, sizga xabar keladi.",
    granted: "✅ Sizga botdan foydalanishga ruxsat berildi. Boshlash uchun /start ni bosing.",
    title: "📥 Botga /start bosganlar",
    empty: "Hali hech kim so‘rov yubormagan.",
    pending: "⏳ ruxsat kutmoqda",
    approved: "✅ ruxsat bor",
    approveBtn: (name: string) => `✅ Ruxsat berish — ${name}`,
    approvedOk: (name: string) => `✅ ${name}: ruxsat berildi, xabar yuborildi`,
    approvedNoMsg: (name: string) => `✅ ${name}: ruxsat berildi, lekin xabar yetib bormadi (botni bloklagan bo‘lishi mumkin)`,
  },
  ai: {
    title: "🤖 AI holati",
    names: { groq: "Groq", "groq:analysis": "Groq (tahlil kaliti)", gemini: "Gemini" } as Record<string, string>,
    never: "❔ hali so‘rov bo‘lmagan",
    ok: (at: string) => `✅ ishlayapti (oxirgi so‘rov: ${at})`,
    limited: (day: boolean, at: string, waitSec: number) => `⏳ ${day ? "kunlik" : "daqiqalik"} limit tugagan — taxminan ${at} da ochiladi (${waitText(waitSec, "uz")}dan keyin)`,
    reopened: (at: string) => `✅ limit ochilgan bo‘lishi kerak (${at} dan beri)`,
    limitedUnknown: (at: string) => `⏳ ${at} da limitga urilgan, ochilish vaqti noma’lum`,
    auth: "❌ kalit noto‘g‘ri yoki bloklangan",
    failed: (at: string) => `⚠️ oxirgi so‘rov xato bilan tugagan (${at})`,
    tokens: (used: string, limit: string | null) => `   24 soatda: ${used} token${limit ? ` / ${limit} (kunlik limit)` : ""}`,
    refreshed: "🔄 Yangilandi",
  },
  settings: (lang: string, tz: string, time: string, on: boolean) =>
    `⚙️ Sozlamalar\n\n🌐 Til: ${lang === "ru" ? "Русский" : "O‘zbekcha"}\n🕒 Vaqt mintaqasi: ${tz}\n⏰ Standart eslatma vaqti: ${time}\n${on ? "🔔 Eslatmalar yoqilgan" : "🔕 Eslatmalar o‘chirilgan"}`,
  askTz: "Vaqt mintaqasini yozing (masalan: Asia/Tashkent, Europe/Moscow, Asia/Almaty).",
  badTz: "Bunday vaqt mintaqasi topilmadi. Masalan: Asia/Tashkent",
  tzSet: (tz: string) => `✅ Vaqt mintaqasi: ${tz}`,
  askDefaultTime: "Standart eslatma vaqtini HH:MM ko‘rinishida yozing (masalan: 09:00).",
  badTime: "Vaqt formati noto‘g‘ri. Masalan: 09:00",
  defaultTimeSet: (t: string) => `✅ Standart eslatma vaqti: ${t}`,
  langSet: "✅ Til: O‘zbekcha",
  confirmDelete: "Barcha vazifalar, qaydlar, eslatmalar, prezentatsiyalar va transkripsiyalaringiz butunlay o‘chiriladi. Davom etasizmi?",
  deleted: "🗑 Ma’lumotlaringiz o‘chirildi. Qayta boshlash uchun /start bosing.",
  cancelled: "Joriy jarayon bekor qilindi.",
  nothingToCancel: "Bekor qilinadigan jarayon yo‘q.",
  pendingDropped: "ℹ️ Oldingi savol yopildi, yangi xabaringizni ko‘rib chiqyapman.",
  pendingExpired: "ℹ️ Oldingi savolning vaqti o‘tdi.",
  unsupported: "Men matn va ovozli xabarlarni tushunaman. 🎙",
  error: "Kutilmagan xatolik yuz berdi. Iltimos, qayta urinib ko‘ring.",
  unclear: "Tushunmadim 🤔 Iltimos, aniqroq aytib bering. Misollar: /help",
  dbFailed: "❌ Saqlanmadi: bazaga yozishda xatolik. Iltimos, qayta urinib ko‘ring.",
  gaveUp: "Javobni tushuna olmadim, shu amal saqlanmadi. Qaytadan to‘liq aytib bering.",
  duplicate: "ℹ️ Bu xabar allaqachon qayta ishlangan.",
  absenceLine: (person: string, dt: string) => `• ${person} — ${dt}`,
  remindLabelSuggestion: (s: string) => s,
  in10: "10 daqiqadan keyin",
  tomorrowSame: "Ertaga shu vaqtda",
  fin: {
    amountQ: "Summasi qancha edi?",
    cats: {
      food: "Oziq-ovqat", cafe: "Kafe/restoran", transport: "Transport", housing: "Uy-joy/ijara", utilities: "Kommunal",
      communication: "Aloqa/internet", health: "Sog‘liq", education: "Ta’lim", clothing: "Kiyim", household: "Uy-ro‘zg‘or",
      entertainment: "Ko‘ngilochar", gifts: "Sovg‘a/marosim", business: "Biznes", debt: "Qarz/kredit", salary: "Maosh/daromad", other: "Boshqa",
    } as Record<string, string>,
    txLine: (income: boolean, money: string, cat: string, desc: string | null) => `${income ? "💰 Daromad" : "💸 Xarajat"}: ${money} — ${cat}${desc ? ` (${desc})` : ""}`,
    periods: { today: "bugun", this_week: "shu hafta", this_month: "shu oy", last_month: "o‘tgan oy" } as Record<string, string>,
    title: (label: string) => `📊 Moliya — ${label}`,
    progress: (d: number, n: number) => ` (${d}/${n} kun)`,
    income: (m: string) => `💰 Daromad: ${m}`,
    expense: (m: string) => `💸 Xarajat: ${m}`,
    balance: (m: string) => `🧮 Balans: ${m}`,
    pace: (m: string) => `📈 O‘rtacha xarajat: kuniga ~${m}`,
    forecastTitle: "🔮 Oy oxiri prognozi (joriy sur’atda):",
    fExpense: (m: string, fixed: string | null) => `  • Xarajat: ~${m}${fixed ? ` (shu jumladan kutilayotgan majburiy to‘lovlar: ${fixed})` : ""}`,
    fIncome: (m: string, avg: boolean) => `  • Daromad: ~${m}${avg ? " (oldingi oylar o‘rtachasi bo‘yicha)" : ""}`,
    fProfit: (m: string) => `  • Natija: ✅ foyda ~${m}`,
    fLoss: (m: string) => `  • Natija: ⚠️ zarar ~${m}`,
    vsPrev: (pct: string) => `↔️ O‘tgan oyning shu davriga nisbatan xarajat: ${pct}`,
    catsTitle: "Toifalar bo‘yicha xarajat:",
    incomeCatsTitle: "Daromad manbalari:",
    insightTitle: "🤖 Tahlil:",
    otherCur: (list: string) => `ℹ️ Boshqa valyutadagi yozuvlar umumiy hisobga qo‘shilmadi: ${list}`,
    noIncome: "ℹ️ Bu oy daromad kiritilmagan — natija faqat xarajatlar bo‘yicha. Daromadni ham yozing: «Oylik tushdi 6 mln».",
    empty: "Bu davr uchun moliyaviy yozuvlar yo‘q. Masalan: «Taksiga 30 ming ketdi» yoki «Oylik tushdi 6 mln».",
    brief: (month: string, exp: string, inc: string, bal: string) => `📊 ${month}: xarajat ${exp} · daromad ${inc} · balans ${bal}`,
    lossAlert: (net: string, exp: string, inc: string) =>
      `⚠️ Moliyaviy ogohlantirish: joriy sur’atda oy oxirida taxminan ${net} zarar bo‘lishi mumkin (xarajat ~${exp}, daromad ~${inc}). Batafsil: /finance`,
    deleted: (line: string) => `🗑 O‘chirildi: ${line}`,
    updated: (line: string) => `✏️ Yangilandi: ${line}`,
    btn: { today: "Bugun", week: "Hafta", month: "Shu oy", last: "O‘tgan oy" },
  },
};

type Dict = typeof uz;

const ru: Dict = {
  welcome: (name, tz) =>
    `Здравствуйте, ${name}! 👋\n\nЯ — помощник, который запоминает ваши задачи и вовремя напоминает о них.\n\n` +
    `🎙 Отправляйте голосовые или текстовые сообщения как в обычном разговоре:\n` +
    `• «Завтра в 9 утра позвонить клиенту»\n` +
    `• «Завтра на урок в 15:00 Азиз не придёт. Напомни за полчаса»\n` +
    `• «Подготовь презентацию на 10 слайдов о финансировании стартапов»\n\n` +
    `🕒 Часовой пояс: ${tz}. Изменить: /settings\n\n` +
    `ℹ️ Бот может писать только тем, кто нажал /start, — не блокируйте бота, иначе напоминания не придут.`,
  help:
    `🎙 Примеры голосовых команд:\n\n` +
    `• «Завтра в 9 утра позвонить клиенту»\n` +
    `• «В пятницу сдаю презентацию по экономике»\n` +
    `• «Каждый день в 8 утра напоминай выпить лекарство»\n` +
    `• «Азиз всё-таки придёт, отмени напоминание»\n` +
    `• «Что у меня сегодня?»\n` +
    `• «Перенеси звонок клиенту на завтра на 10»\n` +
    `• «Отметь последнюю задачу выполненной»\n` +
    `• «На такси 30 тысяч, на рынок 250 тысяч»\n` +
    `• «В конце месяца я в плюсе или в минусе?»\n\n` +
    `Команды: /today /week /tasks /notes /finance /settings /cancel`,
  menu: { today: "📋 Дела на сегодня", tasks: "✅ Мои задачи", notes: "📝 Заметки", finance: "💰 Финансы", presentations: "📎 Презентации", settings: "⚙️ Настройки" },
  listening: "🎧 Слушаю…",
  thinking: "🤔 Разбираюсь…",
  saved: "✅ Сохранено",
  partialFail: "⚠️ Некоторые действия не выполнены:",
  notSaved: "❌ Не сохранено",
  cat: { work: "💼 Работа", home: "🏠 Дом", study: "📚 Учёба", personal: "👤 Личное", other: "📌 Другое" },
  reminderLine: (dt) => `🔔 Напоминание: ${dt}`,
  eventLine: (dt) => `🕒 Время: ${dt}`,
  dueLine: (dt) => `📅 Срок: ${dt}`,
  deadlineRemindersLine: (dts) => `🔔 Напомню о сроке: ${dts.join(" и ")}`,
  deadlineBefore: (title) => `⏳ Завтра срок: «${title}». Всё готово?`,
  deadlineToday: (title) => `⏳ Сегодня срок: «${title}».`,
  presTaskTitle: (topic) => `Презентация: ${topic}`,
  repeatLine: (r) => `🔁 Повтор: ${r}`,
  noteLine: (t) => `📝 Заметка: ${t}`,
  presLine: (n, lang) => `📎 Презентация: ${n} слайдов, ${langName(lang, "ru")}`,
  presQueued: "⏳ Презентация поставлена в очередь",
  question: (q, i, n) => (n > 1 ? `❓ (${i}/${n}) ${q}` : `❓ ${q}`),
  pastTime: (dt) => `${dt} уже прошло. Когда напомнить?`,
  locationQ: (phrase) => `📍 «${phrase}» — я не отслеживаю геолокацию. Во сколько напомнить?`,
  whenRemind: "Когда напомнить?",
  whatHour: (title) => (title ? `«${title}» — во сколько точно?` : "Во сколько точно?"),
  presTopicQ: "На какую тему презентация?",
  chooseItem: "Что именно вы имеете в виду?",
  notFound: "🤷 Подходящая запись не найдена. Уточните, пожалуйста.",
  completed: (t) => `✅ Выполнено: ${t}`,
  rescheduled: (t, from, to) => `🔁 Перенесено: ${t}\n${from} → ${to}`,
  edited: (t) => `✏️ Изменено: ${t}`,
  itemCancelled: (t) => `🗑 Отменено: ${t}`,
  reminderCancelled: (t) => `🔕 Напоминание отменено: ${t}`,
  noteClosed: (t, reason) => `📝 Заметка обновлена: ${t}${reason ? ` — ${reason}` : ""}`,
  noReminders: (t) => `ℹ️ У «${t}» не было активных напоминаний.`,
  lists: {
    today: "📋 Дела на сегодня",
    tomorrow: "📋 Дела на завтра",
    this_week: "📅 Дела на неделю",
    next_week: "📅 Следующая неделя",
    overdue: "⏰ Просроченные",
    all: "✅ Активные задачи",
    notes: "📝 Заметки",
    presentations: "📎 Презентации",
    absences: "🙋 Кто предупредил об отсутствии",
  },
  empty: "Пока ничего нет.",
  reminderFire: (title) => `🔔 ${title}`,
  latePrefix: (planned) => `⏰ Напоминание с опозданием (по плану: ${planned}) — бот временно не работал.`,
  missedSummary: (lines) => `⚠️ Пока бот не работал, эти напоминания не были отправлены вовремя:\n${lines}`,
  presNotReady: (status) => `⚠️ Презентация ещё не готова (статус: ${status}).`,
  btn: {
    done: "✅ Выполнено",
    snooze10: "⏱ На 10 минут",
    snooze60: "⏱ На 1 час",
    changeTime: "🕒 Изменить время",
    cancel: "🗑 Отменить",
    retry: "🔄 Повторить",
    openPres: "📎 Открыть файл",
    makePres: "📎 Подготовить презентацию?",
    yes: "Да",
    no: "Нет",
    deleteData: "🗑 Удалить мои данные",
    aiRefresh: "🔄 Обновить состояние AI",
    requests: (n) => `📥 Новые запросы${n ? ` (${n})` : ""}`,
    langUz: "🇺🇿 O‘zbekcha",
    langRu: "🇷🇺 Русский",
    tz: "🕒 Часовой пояс",
    defaultTime: "⏰ Время напоминаний по умолчанию",
    remindersOn: "🔔 Напоминания: включены",
    remindersOff: "🔕 Напоминания: выключены",
  },
  stale: "Эта кнопка устарела — состояние уже изменилось.",
  staleItem: (t, s) => `Кнопка устарела: «${t}» — ${s}.`,
  statusWord: { done: "выполнено", cancelled: "отменено", sent: "отправлено", active: "активно" },
  snoozed: (dt) => `⏱ Отложено до: ${dt}`,
  askNewTime: (t) => `🕒 Напишите или скажите новое время для «${t}» (например: «завтра 10:00»).`,
  newTimeQ: "Какое новое время?",
  voiceTooLong: (max) => `Голосовое слишком длинное. Отправьте короче ${Math.round(max / 60)} мин.`,
  voiceTooBig: "Голосовое сообщение слишком большое.",
  dailyLimit: "Дневной лимит исчерпан. Попробуйте завтра.",
  presActiveLimit: "У вас уже готовится презентация. Дождитесь её завершения.",
  aiUnavailable: "😔 AI-сервис сейчас не отвечает. Сообщение сохранено — нажмите «Повторить».",
  aiNotConfigured: "⚙️ AI-сервис не настроен (нет GROQ_API_KEY). Обратитесь к администратору.",
  aiRateLimited: (waitSec) =>
    waitSec !== null && waitSec > 120
      ? `⏳ Исчерпан дневной лимит AI (Groq). Сообщение сохранено — нажмите «Повторить» примерно через ${waitText(waitSec, "ru")}.`
      : "⏳ Временно исчерпан лимит запросов к AI (Groq: лимит токенов в минуту). Сообщение сохранено — нажмите «Повторить» примерно через минуту.",
  emptyTranscript: "Речь не распознана. Попробуйте ещё раз, чётче.",
  lowConfidence: "Качество звука может быть низким — проверьте результат.",
  heard: (t) => `🗣 «${t}»`,
  pres: {
    queued: (topic) => `⏳ «${topic}» — презентация в очереди…`,
    generating: (topic, stage) => `🛠 «${topic}» — ${stage}…`,
    stages: { outline: "составляю план слайдов", content: "пишу содержание", render: "создаю файл PPTX", upload: "отправляю файл" },
    ready: (topic, n) => `✅ «${topic}» — презентация готова (${n} слайдов).`,
    failed: (topic) => `❌ «${topic}» — не удалось создать презентацию. Повторить?`,
    statusName: { queued: "в очереди", generating: "создаётся", ready: "готова", failed: "ошибка" },
    caption: (topic) => `📎 ${topic}\n\nℹ️ Проверьте цифры и факты перед сдачей.`,
  },
  access: {
    requested: "⏳ Запрос на доступ к боту отправлен. Когда доступ откроют, вам придёт сообщение.",
    granted: "✅ Вам открыт доступ к боту. Нажмите /start, чтобы начать.",
    title: "📥 Нажали /start в боте",
    empty: "Пока никто не отправлял запрос.",
    pending: "⏳ ждёт доступа",
    approved: "✅ доступ есть",
    approveBtn: (name) => `✅ Дать доступ — ${name}`,
    approvedOk: (name) => `✅ ${name}: доступ открыт, сообщение отправлено`,
    approvedNoMsg: (name) => `✅ ${name}: доступ открыт, но сообщение не доставлено (возможно, бот заблокирован)`,
  },
  ai: {
    title: "🤖 Состояние AI",
    names: { groq: "Groq", "groq:analysis": "Groq (ключ аналитики)", gemini: "Gemini" },
    never: "❔ запросов ещё не было",
    ok: (at) => `✅ работает (последний запрос: ${at})`,
    limited: (day, at, waitSec) => `⏳ ${day ? "дневной" : "минутный"} лимит исчерпан — откроется примерно в ${at} (через ${waitText(waitSec, "ru")})`,
    reopened: (at) => `✅ лимит должен быть снова доступен (с ${at})`,
    limitedUnknown: (at) => `⏳ в ${at} упёрся в лимит, время открытия неизвестно`,
    auth: "❌ ключ неверный или заблокирован",
    failed: (at) => `⚠️ последний запрос завершился ошибкой (${at})`,
    tokens: (used, limit) => `   за 24 ч: ${used} токенов${limit ? ` / ${limit} (дневной лимит)` : ""}`,
    refreshed: "🔄 Обновлено",
  },
  settings: (lang, tz, time, on) =>
    `⚙️ Настройки\n\n🌐 Язык: ${lang === "ru" ? "Русский" : "O‘zbekcha"}\n🕒 Часовой пояс: ${tz}\n⏰ Время напоминаний по умолчанию: ${time}\n${on ? "🔔 Напоминания включены" : "🔕 Напоминания выключены"}`,
  askTz: "Напишите часовой пояс (например: Asia/Tashkent, Europe/Moscow).",
  badTz: "Такой часовой пояс не найден. Пример: Asia/Tashkent",
  tzSet: (tz) => `✅ Часовой пояс: ${tz}`,
  askDefaultTime: "Напишите время в формате ЧЧ:ММ (например: 09:00).",
  badTime: "Неверный формат. Пример: 09:00",
  defaultTimeSet: (t) => `✅ Время по умолчанию: ${t}`,
  langSet: "✅ Язык: Русский",
  confirmDelete: "Все задачи, заметки, напоминания, презентации и расшифровки будут удалены безвозвратно. Продолжить?",
  deleted: "🗑 Ваши данные удалены. Чтобы начать заново, нажмите /start.",
  cancelled: "Текущий процесс отменён.",
  nothingToCancel: "Нечего отменять.",
  pendingDropped: "ℹ️ Предыдущий вопрос закрыт, обрабатываю новое сообщение.",
  pendingExpired: "ℹ️ Время ответа на предыдущий вопрос истекло.",
  unsupported: "Я понимаю текстовые и голосовые сообщения. 🎙",
  error: "Произошла непредвиденная ошибка. Попробуйте ещё раз.",
  unclear: "Не понял 🤔 Скажите, пожалуйста, точнее. Примеры: /help",
  dbFailed: "❌ Не сохранено: ошибка записи в базу. Попробуйте ещё раз.",
  gaveUp: "Не удалось понять ответ, это действие не сохранено. Повторите полностью.",
  duplicate: "ℹ️ Это сообщение уже обработано.",
  absenceLine: (person, dt) => `• ${person} — ${dt}`,
  remindLabelSuggestion: (s) => s,
  in10: "Через 10 минут",
  tomorrowSame: "Завтра в это же время",
  fin: {
    amountQ: "Какая была сумма?",
    cats: {
      food: "Продукты", cafe: "Кафе/рестораны", transport: "Транспорт", housing: "Жильё/аренда", utilities: "Коммунальные",
      communication: "Связь/интернет", health: "Здоровье", education: "Образование", clothing: "Одежда", household: "Хозтовары",
      entertainment: "Развлечения", gifts: "Подарки/торжества", business: "Бизнес", debt: "Долги/кредит", salary: "Зарплата/доход", other: "Другое",
    },
    txLine: (income, money, cat, desc) => `${income ? "💰 Доход" : "💸 Расход"}: ${money} — ${cat}${desc ? ` (${desc})` : ""}`,
    periods: { today: "сегодня", this_week: "эта неделя", this_month: "этот месяц", last_month: "прошлый месяц" },
    title: (label) => `📊 Финансы — ${label}`,
    progress: (d, n) => ` (${d}/${n} дн.)`,
    income: (m) => `💰 Доход: ${m}`,
    expense: (m) => `💸 Расход: ${m}`,
    balance: (m) => `🧮 Баланс: ${m}`,
    pace: (m) => `📈 Средний расход: ~${m} в день`,
    forecastTitle: "🔮 Прогноз на конец месяца (при текущем темпе):",
    fExpense: (m, fixed) => `  • Расход: ~${m}${fixed ? ` (включая ожидаемые обязательные платежи: ${fixed})` : ""}`,
    fIncome: (m, avg) => `  • Доход: ~${m}${avg ? " (по среднему за прошлые месяцы)" : ""}`,
    fProfit: (m) => `  • Итог: ✅ прибыль ~${m}`,
    fLoss: (m) => `  • Итог: ⚠️ убыток ~${m}`,
    vsPrev: (pct) => `↔️ Расход относительно того же периода прошлого месяца: ${pct}`,
    catsTitle: "Расходы по категориям:",
    incomeCatsTitle: "Источники дохода:",
    insightTitle: "🤖 Анализ:",
    otherCur: (list) => `ℹ️ Записи в других валютах не включены в итог: ${list}`,
    noIncome: "ℹ️ Доход в этом месяце не записан — итог только по расходам. Запишите доход: «Пришла зарплата 6 млн».",
    empty: "За этот период нет финансовых записей. Например: «На такси ушло 30 тысяч».",
    brief: (month, exp, inc, bal) => `📊 ${month}: расход ${exp} · доход ${inc} · баланс ${bal}`,
    lossAlert: (net, exp, inc) => `⚠️ Финансовое предупреждение: при текущем темпе к концу месяца возможен убыток ~${net} (расход ~${exp}, доход ~${inc}). Подробнее: /finance`,
    deleted: (line) => `🗑 Удалено: ${line}`,
    updated: (line) => `✏️ Обновлено: ${line}`,
    btn: { today: "Сегодня", week: "Неделя", month: "Этот месяц", last: "Прошлый месяц" },
  },
};

const dicts: Record<Lang, Dict> = { uz, ru };

export function t(lang: Lang | string | null | undefined): Dict {
  return dicts[(lang as Lang) ?? "uz"] ?? uz;
}

export function langName(code: string, ui: Lang): string {
  const names: Record<string, [string, string]> = { uz: ["o‘zbekcha", "узбекский"], ru: ["ruscha", "русский"], en: ["inglizcha", "английский"] };
  const n = names[code] ?? [code, code];
  return ui === "ru" ? n[1] : n[0];
}

export type { Dict };
