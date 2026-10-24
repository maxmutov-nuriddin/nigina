-- CreateEnum
CREATE TYPE "TransactionKind" AS ENUM ('expense', 'income');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "TransactionKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "category" TEXT NOT NULL DEFAULT 'other',
    "description" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "inboundMessageId" TEXT,
    "actionIndex" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceSnapshot" (
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "insight" TEXT,
    "insightAt" TIMESTAMPTZ(3),
    "lastTxAt" TIMESTAMPTZ(3),
    "computedAt" TIMESTAMPTZ(3) NOT NULL,
    "alertState" TEXT,
    "alertMonth" TEXT,

    CONSTRAINT "FinanceSnapshot_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "Transaction_userId_occurredAt_idx" ON "Transaction"("userId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_inboundMessageId_actionIndex_key" ON "Transaction"("inboundMessageId", "actionIndex");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceSnapshot" ADD CONSTRAINT "FinanceSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
