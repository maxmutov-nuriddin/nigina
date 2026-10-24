import { rm } from "node:fs/promises";
import path from "node:path";
import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import type { View } from "../core/queries.ts";
import { aiStatusText } from "../ai/status.ts";

export async function settingsView(deps: Deps, user: User): Promise<View> {
  const L = t(user.language);
  const ai = await aiStatusText(deps, user);
  return {
    text: L.settings(user.language, user.timezone, user.defaultReminderTime, user.remindersEnabled) + (ai ? `\n\n${ai}` : ""),
    keyboard: {
      inline_keyboard: [
        [
          { text: L.btn.langUz, callback_data: "st:lang:uz" },
          { text: L.btn.langRu, callback_data: "st:lang:ru" },
        ],
        [{ text: L.btn.tz, callback_data: "st:tz" }],
        [{ text: L.btn.defaultTime, callback_data: "st:time" }],
        [{ text: user.remindersEnabled ? L.btn.remindersOn : L.btn.remindersOff, callback_data: "st:rem" }],
        [{ text: L.btn.aiRefresh, callback_data: "st:ai" }],
        [{ text: L.btn.deleteData, callback_data: "st:del" }],
      ],
    },
  };
}

/** Foydalanuvchining barcha ma'lumotlari va fayllarini o'chiradi (cascade). */
export async function deleteUserData(deps: Deps, user: User): Promise<void> {
  await deps.db.$transaction([
    deps.db.processedUpdate.deleteMany({ where: { userId: user.id } }),
    deps.db.aiUsageLog.deleteMany({ where: { userId: user.id } }),
    deps.db.user.delete({ where: { id: user.id } }),
  ]);
  await rm(path.resolve(deps.cfg.STORAGE_DIR, "presentations", user.id), { recursive: true, force: true });
}
