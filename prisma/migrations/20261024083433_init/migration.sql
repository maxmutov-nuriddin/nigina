-- CreateEnum
CREATE TYPE "Language" AS ENUM ('uz', 'ru');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('work', 'home', 'study', 'personal', 'other');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('active', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('general', 'absence');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('active', 'cancelled');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('scheduled', 'sending', 'sent', 'cancelled', 'failed', 'missed');

-- CreateEnum
CREATE TYPE "ReminderAnchor" AS ENUM ('absolute', 'event');

-- CreateEnum
CREATE TYPE "PresentationStatus" AS ENUM ('queued', 'generating', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'uncertain');

-- CreateEnum
CREATE TYPE "UpdateStatus" AS ENUM ('processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "firstName" TEXT,
    "username" TEXT,
    "language" "Language" NOT NULL DEFAULT 'uz',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "defaultReminderTime" TEXT NOT NULL DEFAULT '09:00',
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "blockedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "updateId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "transcript" TEXT,
    "durationSec" INTEGER,
    "processedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "Category" NOT NULL DEFAULT 'other',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "personName" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'active',
    "dueAt" TIMESTAMPTZ(3),
    "dueAllDay" BOOLEAN NOT NULL DEFAULT false,
    "eventAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "inboundMessageId" TEXT,
    "sourceMessageId" INTEGER,
    "actionIndex" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "Category" NOT NULL DEFAULT 'other',
    "kind" "NoteKind" NOT NULL DEFAULT 'general',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "personName" TEXT,
    "eventAt" TIMESTAMPTZ(3),
    "status" "NoteStatus" NOT NULL DEFAULT 'active',
    "statusReason" TEXT,
    "inboundMessageId" TEXT,
    "sourceMessageId" INTEGER,
    "actionIndex" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "noteId" TEXT,
    "presentationId" TEXT,
    "text" TEXT NOT NULL,
    "fireAt" TIMESTAMPTZ(3) NOT NULL,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'scheduled',
    "anchor" "ReminderAnchor" NOT NULL DEFAULT 'absolute',
    "offsetMinutes" INTEGER,
    "recurrence" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "lastSentAt" TIMESTAMPTZ(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Presentation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "topic" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'uz',
    "slideCount" INTEGER NOT NULL DEFAULT 10,
    "requirements" TEXT,
    "status" "PresentationStatus" NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "outline" JSONB,
    "filePath" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "telegramFileId" TEXT,
    "statusChatId" BIGINT,
    "statusMessageId" INTEGER,
    "inboundMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Presentation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pending" JSONB,
    "pendingExpiresAt" TIMESTAMPTZ(3),
    "history" JSONB NOT NULL DEFAULT '[]',
    "recentItems" JSONB NOT NULL DEFAULT '[]',
    "retry" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedUpdate" (
    "updateId" BIGINT NOT NULL,
    "userId" TEXT,
    "status" "UpdateStatus" NOT NULL DEFAULT 'processing',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProcessedUpdate_pkey" PRIMARY KEY ("updateId")
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "reminderVersion" INTEGER NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "lateBySec" INTEGER NOT NULL DEFAULT 0,
    "telegramMessageId" INTEGER,
    "error" TEXT,
    "workerId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("userId","day","kind")
);

-- CreateTable
CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "audioSeconds" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_updateId_key" ON "InboundMessage"("updateId");

-- CreateIndex
CREATE INDEX "InboundMessage_userId_createdAt_idx" ON "InboundMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_userId_dueAt_idx" ON "Task"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "Task_userId_eventAt_idx" ON "Task"("userId", "eventAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_inboundMessageId_actionIndex_key" ON "Task"("inboundMessageId", "actionIndex");

-- CreateIndex
CREATE INDEX "Note_userId_status_idx" ON "Note"("userId", "status");

-- CreateIndex
CREATE INDEX "Note_userId_personName_idx" ON "Note"("userId", "personName");

-- CreateIndex
CREATE UNIQUE INDEX "Note_inboundMessageId_actionIndex_key" ON "Note"("inboundMessageId", "actionIndex");

-- CreateIndex
CREATE INDEX "Reminder_status_nextAttemptAt_idx" ON "Reminder"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Reminder_userId_status_idx" ON "Reminder"("userId", "status");

-- CreateIndex
CREATE INDEX "Presentation_userId_status_idx" ON "Presentation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationState_userId_key" ON "ConversationState"("userId");

-- CreateIndex
CREATE INDEX "ProcessedUpdate_startedAt_idx" ON "ProcessedUpdate"("startedAt");

-- CreateIndex
CREATE INDEX "DeliveryAttempt_reminderId_idx" ON "DeliveryAttempt"("reminderId");

-- CreateIndex
CREATE INDEX "AiUsageLog_createdAt_idx" ON "AiUsageLog"("createdAt");

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_presentationId_fkey" FOREIGN KEY ("presentationId") REFERENCES "Presentation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationState" ADD CONSTRAINT "ConversationState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
