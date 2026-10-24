import { rm } from "node:fs/promises";
import path from "node:path";
import type { Deps } from "../deps.ts";
import type { User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import type { View } from "../core/queries.ts";
import { aiStatusText } from "../ai/status.ts";
import { isOwner } from "../lib/access.ts";
import { formatDateTime } from "../lib/time.ts";

export async function settingsView(deps: Deps, user: User): Promise<View> {
  const L = t(user.language);
  const ai = await aiStatusText(deps, user);
  // Asosiy foydalanuvchi — botga kirish so'rovlari
  const owner = isOwner(deps.cfg, user.telegramUserId);
  const pending = owner ? await deps.db.accessRequest.count({ where: { status: "pending" } }) : 0;
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
        ...(owner ? [[{ text: L.btn.requests(pending), callback_data: "ad:list" }]] : []),
        [{ text: L.btn.aiRefresh, callback_data: "st:ai" }],
        [{ text: L.btn.deleteData, callback_data: "st:del" }],
      ],
    },
  };
}

/** Asosiy foydalanuvchi uchun: /start bosgan hamma — avval ruxsat kutayotganlar (tugma bilan), keyin ruxsati borlar. */
export async function accessView(deps: Deps, user: User): Promise<View> {
  const L = t(user.language);
  const [pending, approved] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 30 }),
    deps.db.accessRequest.findMany({ where: { status: "approved" }, orderBy: { approvedAt: "desc" }, take: 30 }),
  ]);
  const name = (r: { firstName: string | null; username: string | null; telegramUserId: bigint }) => r.firstName || (r.username ? `@${r.username}` : String(r.telegramUserId));
  const line = (r: (typeof pending)[number], status: string) =>
    `• ${name(r)}${r.username ? ` (@${r.username})` : ""} — ${status} · ${formatDateTime(r.createdAt, user.timezone, user.language)}`;
  const lines = [L.access.title, ""];
  if (!pending.length && !approved.length) lines.push(L.access.empty);
  pending.forEach((r) => lines.push(line(r, L.access.pending)));
  approved.forEach((r) => lines.push(line(r, L.access.approved)));
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: pending.slice(0, 20).map((r) => [{ text: L.access.approveBtn(name(r)).slice(0, 60), callback_data: `ad:ok:${r.telegramUserId}` }]) },
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
