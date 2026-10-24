import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Config } from "../config.ts";
import type { Deps } from "../deps.ts";
import { logger, safeError } from "../logger.ts";
import { generatePresentation } from "./generate.ts";

export const PRESENTATION_QUEUE = "presentations";
const ATTEMPTS = 3;

export function createRedis(cfg: Config): Redis {
  return new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
}

export function createPresentationQueue(connection: Redis, prefix = "nigina") {
  const queue = new Queue(PRESENTATION_QUEUE, { connection, prefix });
  const enqueue = async (presentationId: string, round: string | number = 0) => {
    // jobId barqaror: bir xil prezentatsiya (bir raundda) navbatga ikki marta tushmaydi.
    // Qo'lda "Qayta urinish" yangi raund bilan yangi job yaratadi.
    await queue.add(
      "generate",
      { presentationId },
      {
        jobId: `pres-${presentationId}-${round}`,
        attempts: ATTEMPTS,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  };
  return { queue, enqueue };
}

export function startPresentationWorker(deps: Deps, connection: Redis, prefix = "nigina"): Worker {
  const worker = new Worker(
    PRESENTATION_QUEUE,
    async (job: Job<{ presentationId: string }>) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await generatePresentation(deps, job.data.presentationId, { finalAttempt });
    },
    { connection, prefix, concurrency: deps.cfg.PRESENTATION_CONCURRENCY, lockDuration: 5 * 60_000 },
  );
  worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: safeError(err) }, "presentation job failed"));
  worker.on("error", (err) => logger.error({ err: safeError(err) }, "presentation worker error"));
  return worker;
}
