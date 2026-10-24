-- AI provayder holati (limit qachon ochilishi) — /settings'da ko'rsatish uchun
ALTER TABLE "AiUsageLog" ADD COLUMN "provider" TEXT;
ALTER TABLE "AiUsageLog" ADD COLUMN "retryUntil" TIMESTAMPTZ(3);
ALTER TABLE "AiUsageLog" ADD COLUMN "limitScope" TEXT;
CREATE INDEX "AiUsageLog_provider_createdAt_idx" ON "AiUsageLog"("provider", "createdAt");
