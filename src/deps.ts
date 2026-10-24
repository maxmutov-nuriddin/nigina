import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { AiProvider } from "./ai/provider.ts";
import type { Nlu } from "./ai/nlu.ts";
import type { Messenger } from "./messenger.ts";

/** Ilova bog'liqliklari — testlarda soxta AI, soxta Telegram va qotirilgan soat beriladi. */
export interface Deps {
  cfg: Config;
  db: Db;
  ai: AiProvider;
  nlu: Nlu;
  /** Fondagi moliyaviy tahlil uchun (alohida Groq kaliti). null — tahlil izohsiz, faqat raqamlar */
  analysisNlu: Nlu | null;
  messenger: Messenger;
  /** Prezentatsiyani fon navbatiga qo'yadi */
  enqueuePresentation: (presentationId: string, round?: string | number) => Promise<void>;
  /** Telegram fayl yo'li bo'yicha yuklab oladi */
  downloadFile: (filePath: string) => Promise<Buffer>;
  clock: () => Date;
}
