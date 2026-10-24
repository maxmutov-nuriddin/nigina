import type { Deps } from "../deps.ts";
import { logger, safeError } from "../logger.ts";
import { generatePresentation } from "./generate.ts";

const ATTEMPTS = 3;
/** BullMQ removeOnComplete/removeOnFail: 1000 kabi — tugagan job ID'lari eslab qolinadi (dublikat qayta bajarilmaydi) */
const KEEP_KEYS = 1000;

/**
 * Redis'siz (REDIS_URL bo'sh) rejim uchun jarayon ichidagi prezentatsiya navbati — faqat APP_ROLE=all (bitta jarayon).
 * BullMQ bilan bir xil kafolatlar: bir xil job ikki marta tushmaydi, 3 urinish eksponensial backoff bilan,
 * parallellik cheklangan. Holat bazada (queued/generating/ready/failed): restartda yo'qolgan ishlar
 * recover() + sweeper orqali qayta navbatga qo'yiladi.
 */
export class LocalPresentationQueue {
  private deps: Deps | null = null;
  private waiting: Array<{ key: string; id: string; attempt: number }> = [];
  private keys = new Set<string>();
  private active = 0;
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    private concurrency: number,
    private backoffMs = 10_000,
    private process: typeof generatePresentation = generatePresentation,
  ) {}

  /** jobId barqaror: bir xil prezentatsiya (bir raundda) navbatga ikki marta tushmaydi */
  enqueue = async (presentationId: string, round: string | number = 0): Promise<void> => {
    const key = `pres-${presentationId}-${round}`;
    if (this.closed || this.keys.has(key)) return;
    this.keys.add(key);
    this.waiting.push({ key, id: presentationId, attempt: 1 });
    this.pump();
  };

  /** Worker'ni ishga tushiradi. Oldingi jarayonda yarim qolgan (generating) ishlar navbatga qaytariladi. */
  async start(deps: Deps): Promise<void> {
    this.deps = deps;
    const reset = await deps.db.presentation.updateMany({ where: { status: "generating" }, data: { status: "queued", stage: null } });
    if (reset.count) logger.info({ count: reset.count }, "yarim qolgan prezentatsiyalar navbatga qaytarildi");
    this.pump();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    while (this.active > 0) await new Promise((r) => setTimeout(r, 50));
  }

  private pump(): void {
    while (this.deps && !this.closed && this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      void this.run(this.deps, job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private forgetOld(): void {
    // Set qo'shilish tartibini saqlaydi — eng eskilari o'chiriladi
    for (const k of this.keys) {
      if (this.keys.size <= KEEP_KEYS) break;
      this.keys.delete(k);
    }
  }

  private async run(deps: Deps, job: { key: string; id: string; attempt: number }): Promise<void> {
    try {
      await this.process(deps, job.id, { finalAttempt: job.attempt >= ATTEMPTS });
      this.forgetOld();
    } catch (err) {
      logger.warn({ jobId: job.key, attempts: job.attempt, err: safeError(err) }, "presentation job failed");
      if (job.attempt >= ATTEMPTS || this.closed) {
        this.forgetOld();
        return;
      }
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.waiting.push({ ...job, attempt: job.attempt + 1 });
        this.pump();
      }, this.backoffMs * 2 ** (job.attempt - 1));
      this.timers.add(t);
    }
  }
}
