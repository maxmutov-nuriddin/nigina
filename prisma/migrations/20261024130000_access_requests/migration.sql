-- Botdan foydalanish so'rovlari (asosiy foydalanuvchi ruxsat beradi)
CREATE TYPE "AccessStatus" AS ENUM ('pending', 'approved');

CREATE TABLE "AccessRequest" (
    "telegramUserId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "firstName" TEXT,
    "username" TEXT,
    "language" "Language" NOT NULL DEFAULT 'uz',
    "status" "AccessStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(3),
    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("telegramUserId")
);

CREATE INDEX "AccessRequest_status_createdAt_idx" ON "AccessRequest"("status", "createdAt");

-- Hozir botdan foydalanayotganlar ruxsatini yo'qotmaydi
INSERT INTO "AccessRequest" ("telegramUserId", "chatId", "firstName", "username", "language", "status", "createdAt", "approvedAt")
SELECT "telegramUserId", "chatId", "firstName", "username", "language", 'approved', "createdAt", CURRENT_TIMESTAMP FROM "User"
ON CONFLICT DO NOTHING;
