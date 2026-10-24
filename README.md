# Nigina — ovoz bilan boshqariladigan vazifa yordamchisi (Telegram bot)

Foydalanuvchi botga oddiy suhbatdagidek ovozli yoki matnli xabar yuboradi. Bot xabarni tushunadi, bitta xabardagi bir nechta vazifani ajratadi, kategoriyalaydi (ish, uy, o‘qish, shaxsiy, boshqa), sana/vaqt/odamlarni ajratib oladi, bazaga saqlaydi, belgilangan vaqtda eslatadi, so‘ralsa haqiqiy PPTX prezentatsiya yaratadi, xarajat/daromadlarni hisoblab oy oxiriga foyda yoki zarar prognozini beradi.

## Moliya

- «Taksiga 35 ming, bozorga 250 ming ketdi», «Oylik tushdi 6 yarim mln» — har bir summa alohida tranzaksiya (toifa, valyuta, sana). «Ertaga kreditga 2 mln to‘lashim kerak» — tranzaksiya emas, vazifa/eslatma.
- `/finance`, «💰 Moliya» tugmasi yoki «Oy oxirida foydadamanmi?» — hisobot: daromad, xarajat, balans, kunlik o‘rtacha xarajat, toifalar, o‘tgan oyning shu davriga nisbatan o‘zgarish.
- **Oy oxiri prognozi (kod hisoblaydi, AI emas):** o‘zgaruvchan xarajatlar joriy sur’at bo‘yicha oy oxirigacha davom ettiriladi; majburiy to‘lovlar (ijara, kommunal, kredit, aloqa, ta’lim) sur’atga qo‘shilmaydi, o‘tgan oyda bo‘lib bu oy hali to‘lanmaganlari «kutilayotgan» sifatida qo‘shiladi; daromad — shu oy tushgani yoki oldingi 3 oy o‘rtachasidan kattasi. Natija: foyda yoki zarar.
- **Fondagi doimiy tahlil:** worker har 10 daqiqada yangi yozuvi bor foydalanuvchilar uchun snapshot'ni yangilaydi; AI izohi (2–4 ta xulosa) alohida `GROQ_ANALYSIS_API_KEY` bilan yoziladi — faqat hisoblangan raqamlar asosida, raqam uydirmaydi. Yangi yozuv bo‘lmasa qayta hisoblanmaydi. Joriy sur’atda zarar kutilsa — oyiga bir marta ogohlantirish.
- Xarajatni tuzatish/o‘chirish: «Taksi 35 ming edi», «Bozor xarajatini o‘chir».

## Kirish cheklovi

`ALLOWED_CHAT_IDS=8207311790` — bot faqat shu chatga javob beradi. Boshqalarning xabarlari e’tiborsiz qoldiriladi va bazaga yozilmaydi; cheklovdan oldin yaratilgan begona yozuvlarga eslatma yuborilmaydi.

## Arxitektura

Bitta Node.js ilova. `APP_ROLE` orqali bitta jarayonda yoki bot/worker sifatida alohida ishga tushiriladi. Microservice'lar yo‘q.

```
Telegram ──► bot/ (grammY, runner + per-chat sequentialize)
               │  dedupe (ProcessedUpdate) → user → handler
               ▼
            core/pipeline ── ai/nlu (Groq, strict JSON schema + Zod)
               │   ├─ core/context  — foydalanuvchi yozuvlari AI'ga ref (T1, N2, P3) sifatida
               │   ├─ core/plan     — backend tekshiruvi: vaqtlar (UTC), noaniqlik, egalik
               │   ├─ core/executor — bitta tranzaksiyada yozish (idempotent)
               │   └─ core/state    — aniqlashtirish holati bazada (restartga chidamli)
               ▼
PostgreSQL (Prisma 7) ◄── reminders/scheduler (DB polling, atomar claim)
Redis + BullMQ ◄────────── presentations/ (navbat → Groq → PptxGenJS → Telegram)
```

| Papka | Vazifasi |
|---|---|
| `src/ai/` | `AiProvider` interfeysi, `GroqProvider`, NLU promptlari, Zod sxemalar |
| `src/core/` | Kontekst, reja (validatsiya), bajarish, so‘rovlar, suhbat holati |
| `src/reminders/` | Eslatmalarni yaratish/bekor qilish, ishonchli scheduler |
| `src/presentations/` | BullMQ navbat, generatsiya, tekshirish (sanitize), PPTX render |
| `src/bot/` | Telegram handlerlar, ovoz, callback tugmalar, sozlamalar |
| `prisma/` | Sxema va migratsiyalar |
| `tests/` | Vitest (alohida test bazasi) |
| `scripts/` | Real Groq/Telegram tekshiruvi, namunaviy PPTX |

### Groq integratsiyasi (rasmiy hujjat bo‘yicha tekshirilgan, 2026-10-24)

- STT: `POST https://api.groq.com/openai/v1/audio/transcriptions`, modellar `whisper-large-v3` / `whisper-large-v3-turbo`; formatlar: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm; fayl limiti 25 MB (free). `response_format=verbose_json` (til, davomiylik, `avg_logprob`), `prompt` (≤224 token) o‘zbekcha imloga yo‘naltirish uchun.
- Chat: `response_format: { type: "json_schema", json_schema: { strict: true } }` — strict rejimni `openai/gpt-oss-120b`, `openai/gpt-oss-20b` (production) qo‘llaydi. Strict talablari: barcha maydon `required`, `additionalProperties: false`, ixtiyoriy maydon `null` orqali. Sxema Zod'dan avtomatik yasaladi (`toStrictJsonSchema`), javob Zod bilan qayta tekshiriladi, mos kelmasa 1 marta "tuzatish" so‘rovi.
- Telegram ovozi `.oga` (OGG/Opus) — Groq OGG'ni qabul qiladi, shuning uchun konvertatsiyasiz `.ogg` nomi bilan yuboriladi. Boshqa formatlar `ffmpeg` bilan 16 kHz mono FLAC'ga aylantiriladi.
- Model nomlari faqat env'dan: `GROQ_TRANSCRIPTION_MODEL`, `GROQ_CHAT_MODEL`, `GROQ_PRESENTATION_MODEL`.

### Gemini (ixtiyoriy, zaxira bilan)

`.env`ga `GEMINI_API_KEY` qo‘yilsa, matnni tushunish, prezentatsiya va moliyaviy tahlil Google Gemini’da (`GEMINI_CHAT_MODEL`, standart `gemini-3.8-flash`) ishlaydi; Gemini limitga tushsa, ishlamasa yoki kaliti noto‘g‘ri bo‘lsa — so‘rov avtomatik Groq’ga o‘tadi. Kalit bo‘lmasa hammasi avvalgidek Groq’da. Ovoz: Groq Whisper asosiy, Gemini zaxira. Ikkala kalit bo‘lsa tartibni `AI_PRIMARY=gemini|groq` belgilaydi. Integratsiya Gemini’ning rasmiy OpenAI-mos endpoint’i orqali (`/v1beta/openai/chat/completions`, `response_format: json_schema`), javob Zod bilan qayta tekshiriladi. Tekshirish: `npm run check:gemini`.

## Ishga tushirish

### Talablar
- Telegram bot tokeni (@BotFather) va Groq API kaliti
- Docker Compose **yoki** Node.js ≥ 22, PostgreSQL ≥ 14, Redis ≥ 6, ffmpeg (ixtiyoriy)

### Docker Compose
```bash
cp .env.example .env        # TELEGRAM_BOT_TOKEN va GROQ_API_KEY ni to'ldiring
docker compose up -d --build
docker compose logs -f bot
```
`migrate` servisi migratsiyalarni qo‘llaydi, keyin `bot` (bot + scheduler + worker) ishga tushadi. Prezentatsiya fayllari `storage` volume'da.

### Lokal
```bash
npm ci
cp .env.example .env         # DATABASE_URL, REDIS_URL, tokenlar
npx prisma migrate deploy
npm run build && npm start   # yoki: npm run dev
```

### Webhook rejimi
`BOT_MODE=webhook`, `WEBHOOK_URL=https://domen/telegram/webhook`, `WEBHOOK_SECRET=<tasodifiy>`. Ilova `WEBHOOK_PORT`da tinglaydi, `X-Telegram-Bot-Api-Secret-Token` sarlavhasini tekshiradi (grammY `secretToken`), `/health` endpoint bor.

### Uptime monitoring (health)
Ilova har ikki rejimda `WEBHOOK_PORT` (8080) da HTTP ochadi:
- `GET /health` — jarayon tirik (`200 ok`);
- `GET /health/ready` — baza, Redis, eslatmalar scheduler'i (oxirgi sikl ≤ 3 interval + 30 s) va Telegram polling tekshiriladi; biror narsa ishlamasa **503**. Javob: `{"status":"ok","uptimeSec":…,"checks":{"database":{"ok":true,"ms":136},…}}` — sir yo'q.

Uptime monitorga (UptimeRobot, Better Stack…) `https://<domen yoki IP>:8080/health/ready` qo'yiladi, kutilgan kod 200. Docker Compose'da shu endpoint `healthcheck` sifatida ham ishlatiladi.

### Masshtablash
`APP_ROLE=bot` (bitta nusxa — polling'da Telegram faqat bittasiga ruxsat beradi) va `APP_ROLE=worker` (bir nechta nusxa bo‘lishi mumkin: eslatmalar `FOR UPDATE SKIP LOCKED` bilan, prezentatsiyalar BullMQ bilan taqsimlanadi).

## Kerakli kalitlar va sozlamalar

| O‘zgaruvchi | Majburiy | Izoh |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ha | @BotFather |
| `GROQ_API_KEY` | ha | Yo‘q bo‘lsa bot ishlaydi, lekin AI so‘rovlarida "AI xizmati sozlanmagan" deydi (soxta natija yo‘q) |
| `DATABASE_URL`, `REDIS_URL` | ha | Compose'da avtomatik |
| `GROQ_TRANSCRIPTION_MODEL` | yo‘q | `whisper-large-v3` |
| `GROQ_CHAT_MODEL` | yo‘q | `openai/gpt-oss-120b` |
| `BOT_MODE`, `WEBHOOK_*` | yo‘q | `polling` standart |

To‘liq ro‘yxat va izohlar: `.env.example`.

## Bot imkoniyatlari

Buyruqlar: `/start` (tanishtirish, timezone, /start nima uchun kerakligi), `/help`, `/today`, `/week`, `/tasks`, `/notes`, `/settings`, `/cancel`. Asosiy menyu: Bugungi ishlar · Vazifalarim · Qaydlarim · Prezentatsiyalar · Sozlamalar.

Vazifa/eslatma tugmalari: Bajarildi · 10 daqiqaga · 1 soatga · Vaqtini o‘zgartirish · Bekor qilish.

AI niyatlari: `create_task`, `create_note`, `create_reminder`, `create_presentation`, `update_item`, `complete_task`, `cancel_reminder`, `list_items`, `search_notes`, `clarify`. Bitta xabarda bir nechta amal; `due_at`, `event_at`, `remind_at` alohida saqlanadi.

**Muddat eslatmalari (avtomatik):** muddatli vazifa («29-gacha», «juma kuniga») eslatmasiz saqlansa, bot o‘zi ikki marta eslatadi — muddatdan bir kun oldin va muddat kuni (`/settings`dagi standart vaqtda; soati aniq muddatda — kun eslatmasi ko‘pi bilan 2 soat oldin). Bu eslatmalar muddatga bog‘langan (`anchor = due`): muddat ko‘chirilsa qayta hisoblanadi, vazifa bajarilsa bekor qilinadi. Foydalanuvchi o‘zi eslatma so‘ragan bo‘lsa, avtomatik eslatma qo‘shilmaydi. Muddat bilan so‘ralgan prezentatsiya («29-gacha prezentatsiya tayyorla») muddatli vazifaga bog‘lanadi.

Aniqlashtirish faqat natijaga ta’sir qilganda: "soat sakkiz" (ertalab/kechqurun), joylashuvga bog‘liq eslatma ("uyga qaytayotganda" — geolokatsiya kuzatilmaydi, vaqt so‘raladi), o‘tib ketgan vaqt, prezentatsiya mavzusi, bir nechta mos yozuv (inline tugmalar bilan tanlash). Kutilayotgan savol bazada saqlanadi (TTL 60 daq), restartdan keyin ham davom etadi.

## Ishonchlilik dizayni

**Eslatmalar** faqat PostgreSQL'da (setTimeout yo‘q):
- Scheduler har 5 s da `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` bilan atomar claim qiladi; `lockedUntil` (120 s) — worker yiqilsa eslatma qayta olinadi, oldingi yakunlanmagan urinish `uncertain` deb belgilanadi.
- Har o‘zgarishda (ko‘chirish, bekor qilish, surish) `version` oshadi; yakunlash `version` va `lockedBy` mos kelgandagina bajariladi — eski vaqt yoki bekor qilingan eslatma yuborilmaydi. Alohida "job" yo‘q, shuning uchun eskirgan job muammosi ham yo‘q.
- Har urinish `DeliveryAttempt`da (sent/failed/uncertain). Telegram 429 — `retry_after`, 5xx/tarmoq — eksponensial backoff (30 s → 15 daq), 403 (bloklangan) — to‘xtatiladi, foydalanuvchi belgilanadi, `/start`da tiklanadi. Maksimal urinish: `REMINDER_MAX_ATTEMPTS`.
- **Kechikkan-yetkazish siyosati:** ≤5 daq — oddiy; ≤12 soat — "⏰ Kechikkan eslatma (rejada: …)" belgisi bilan; >12 soat — alohida yuborilmaydi, `missed` holati va bitta umumiy xabar. Takroriy eslatmalar downtime'dan keyin o‘tkazib yuborilgan takrorlarni spam qilmaydi, keyingi kelajak vaqtiga o‘tadi.
- **Kafolat:** "kamida bir marta". Telegram javobi kelmasa (tarmoq uzilishi) xabar yetib borgan bo‘lishi mumkin — qayta yuboriladi, kamdan-kam dublikat bo‘lishi mumkin. "Aynan bir marta" kafolatlanmaydi.

**Idempotentlik:** `ProcessedUpdate` (update_id) — takroriy Telegram update o‘tkazib yuboriladi; qo‘shimcha ravishda yozuvlar `InboundMessage.processedAt IS NULL` sharti bilan bitta tranzaksiyada yaratiladi va `(inboundMessageId, actionIndex)` unique — dublikat vazifa yaratilmaydi.

**Prezentatsiya:** `queued → generating → ready / failed`. BullMQ: 3 urinish, eksponensial backoff. "Tayyor" faqat fayl Telegram'ga yuborilib, `file_id` saqlangandan keyin. Oxirgi urinish xato bo‘lsa — `failed` va "Qayta urinish" tugmasi. Navbatga qo‘yilmay qolganlarni sweeper (har daqiqa) qayta qo‘yadi.

**PPTX:** 16:9, izchil rang/tipografika, maketlar (punktlar, ikki ustun, jadval, jarayon diagrammasi, xulosa), shrift o‘lchami matn hajmiga qarab hisoblanadi, matn cheklanadi. Veb-qidiruv yo‘q — foydalanuvchi bermagan foiz/valyuta/mln kabi statistik raqamlar avtomatik olib tashlanadi, soxta manba yozilmaydi. PDF eksport qo‘shilmagan (ishonchli konvertor talab qilinadi; PPTX unga bog‘liq emas).

## Xavfsizlik va xarajat

- Sirlar faqat env'da; loglarda tokenlar va foydalanuvchi matni yo‘q (pino redact + `safeError`).
- Har query va callback `userId` bilan filtrlanadi. AI'ga haqiqiy ID o‘rniga faqat shu foydalanuvchining ref'lari beriladi; AI qaytargan har qanday ref/ID backend'da egalik bo‘yicha qayta tekshiriladi.
- Prompt injection: foydalanuvchi matni "untrusted data" sifatida ajratilgan; AI faqat sxemaga mos JSON qaytaradi, fayl yo‘llari va ruxsatlarni backend belgilaydi.
- Limitlar: ovoz davomiyligi/hajmi, kunlik ovoz/AI/prezentatsiya, bir vaqtda faol prezentatsiya, worker parallelligi.
- Vaqtinchalik audio fayllar faqat ffmpeg kerak bo‘lganda yaratiladi va darhol o‘chiriladi. Transkripsiyalar `TRANSCRIPT_RETENTION_DAYS` dan keyin tozalanadi.
- `/settings → Ma’lumotlarimni o‘chirish` — barcha yozuvlar (cascade) va prezentatsiya fayllari o‘chiriladi.
- AI sarfi `AiUsageLog`da: model, tokenlar, audio soniyalar, kechikish, xato kodi — mazmunsiz.

## Testlar

```bash
npm test            # 96 test, alohida baza: nigina_test (TEST_DATABASE_URL bilan o'zgartirish mumkin)
npm run typecheck
```

Testlar **soxta AI (FakeAi)** va **soxta Telegram API** (grammY transformer) bilan ishlaydi; PostgreSQL va Redis — haqiqiy. Mock natijalari real Groq sifati tekshirilganini anglatmaydi.

| # | Oqim | Fayl |
|---|---|---|
| 1 | Ovoz → transkripsiya → vazifa → baza | `flows.test.ts` |
| 2 | Bitta xabardan bir nechta vazifa (Misol A) | `flows.test.ts` |
| 3 | Yetishmayotgan vaqt / AM-PM / o‘tgan vaqt | `flows.test.ts` |
| 4 | Asia/Tashkent sana hisoblari | `time.test.ts` |
| 5 | Restartdan keyin yetkazish, lock, ikki worker, downtime | `reminders.test.ts` |
| 6 | Takroriy update — dublikat yo‘q | `flows.test.ts` |
| 7 | Vaqt o‘zgarsa eski eslatma yuborilmaydi | `reminders.test.ts` |
| 8 | "Aziz kelmaydi" → "Aziz kelarkan" (+ noaniqlik) | `flows.test.ts` |
| 9 | PPTX yaratish va yuborish, xato va qayta urinish | `presentations.test.ts`, `queue.test.ts` |
| 10 | Groq va Telegram xatolaridan tiklanish | `flows.test.ts`, `reminders.test.ts` |
| 11 | Foydalanuvchilar izolyatsiyasi, ma’lumot o‘chirish | `security.test.ts` |
| 12 | Eskirgan inline tugmalar | `security.test.ts`, `reminders.test.ts` |

## Real integratsiyani tekshirish

```bash
npm run check:telegram                         # getMe, webhook holati
npm run check:telegram -- --chat <CHAT_ID>     # test xabar (oldin /start bosilgan bo'lishi kerak)
npm run check:gemini                           # Gemini kaliti, modellar va real NLU (muddatli prezentatsiya misoli)
npm run check:groq                             # modellar mavjudligi + A–E misollarida real NLU javoblari
npm run check:groq -- --audio ~/voice.ogg      # haqiqiy o'zbekcha audio transkripsiyasi
npm run check:groq -- --pptx out.pptx          # Groq orqali haqiqiy prezentatsiya
npm run sample:pptx -- sample.pptx             # AI'siz namunaviy PPTX (dizayn tekshiruvi)
DATABASE_URL=postgresql://USER@localhost:5432/nigina_test npm run e2e:real   # real Groq bilan butun bot oqimi (test bazasida)
```

O‘zbekcha transkripsiya sifatini tekshirish uchun bir nechta real ovoz yozing (o‘zbekcha, ruscha, aralash, shovqinli), Telegram'dan `.ogg` sifatida saqlab `--audio` bilan ishga tushiring. Natija yomon bo‘lsa: `GROQ_TRANSCRIPTION_LANGUAGE=uz` ni sinang yoki `whisper-large-v3` (turbo emas) dan foydalaning.

## Groq limitlari (muhim)

Hozirgi ikkala kalit Groq **free tier**'da: `openai/gpt-oss-120b` uchun daqiqasiga **8 000 token**, kuniga 1 000 so‘rov. Bitta xabarni tushunish ~5–10 ming token oladi (prompt ~4k + mulohaza va javob), ya’ni asosiy kalit amalda **daqiqasiga ~1 ta murakkab xabar** ko‘taradi. Limitga tushilsa ilova Groq `retry-after` vaqtini (≤60 s, `GROQ_RATE_LIMIT_MAX_WAIT_MS`; 429 va 413 «Request too large» holatlarida) kutib qayta urinadi (Groq SDK TPM xatosida o‘zi urinmaydi), baribir o‘tmasa foydalanuvchiga «limit, 1 daqiqadan keyin Qayta urinish» xabari va tugma chiqadi (xabar yo‘qolmaydi).
**Limit holatini ko‘rish:** `/settings` → «🤖 AI holati»: har bir provayder (Groq, Gemini) uchun «✅ ishlayapti», «⏳ kunlik limit tugagan — taxminan 16:05 da ochiladi» yoki «✅ limit ochilgan bo‘lishi kerak», shuningdek 24 soatlik token sarfi (`GROQ_DAILY_TOKEN_LIMIT`, standart 200 000). Groq kunlik qolgan tokenni oldindan bermaydi, shuning uchun holat haqiqiy so‘rovlar natijasidan (`AiUsageLog`) olinadi; «🔄 AI holatini yangilash» tugmasi qayta hisoblaydi.
Yechimlar: Groq Dev tier'ga o‘tish; yoki `GROQ_FALLBACK_TO_ANALYSIS_KEY=true` (limitda tahlil kaliti ishlatiladi); yoki `GROQ_REASONING_EFFORT=low` (tejamkor, lekin murakkab xabarlarda aniqlik pasayadi — real testda «soat sakkiz»ni so‘ramay 08:00 deb oldi).

## Sana/vaqt himoyasi (LLM xatolariga qarshi)

Real testlarda model ba’zan hafta kunini yoki soatni noto‘g‘ri hisobladi. Shuning uchun AI foydalanuvchi **aytgan** hafta kuni va soat raqamini (`time_hints`) alohida qaytaradi, backend esa tekshiradi:
- sana aytilgan hafta kuniga to‘g‘ri kelmasa yoki o‘tib ketgan bo‘lsa — eng yaqin kelasi shu kunga tuziladi;
- soat aytilgan raqamga mos kelmasa — so‘raladi;
- 6, 7, 8 soat kun qismisiz («soat sakkizda») — har doim ertalab/kechqurun so‘raladi;
- 1–5 soat kun qismisiz («darsga soat uchda») — 13:00–17:00 deb olinadi.

## Cheklovlar

- Geolokatsiya kuzatilmaydi — "uyga qaytayotganda" kabi iboralarda vaqt so‘raladi.
- Ovozli javob (TTS) yo‘q.
- Faqat shaxsiy chatlar (guruhlar e’tiborsiz qoldiriladi).
- PDF eksport yo‘q.
- Takrorlanish: kunlik va haftalik (oylik yo‘q).
