/**
 * REAL Telegram bot tokenini tekshirish.
 *   npm run check:telegram                 — getMe + webhook holati
 *   npm run check:telegram -- --chat 12345 — shu chatga test xabar (oldin botga /start bosilgan bo'lishi shart)
 */
import { Api } from "grammy";
import { config } from "../src/config.ts";

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN sozlanmagan (.env). @BotFather orqali oling.");
  process.exit(1);
}
const api = new Api(config.TELEGRAM_BOT_TOKEN);
try {
  const me = await api.getMe();
  console.log(`✅ Bot: @${me.username} (id ${me.id})`);
  const wh = await api.getWebhookInfo();
  console.log(`   Webhook: ${wh.url || "(yo'q — polling rejimi)"}${wh.last_error_message ? `, oxirgi xato: ${wh.last_error_message}` : ""}, kutilayotgan update'lar: ${wh.pending_update_count}`);
  const i = process.argv.indexOf("--chat");
  if (i > 0) {
    const m = await api.sendMessage(Number(process.argv[i + 1]), "✅ Nigina bot: test xabar");
    console.log(`   Test xabar yuborildi (message_id ${m.message_id})`);
  }
} catch (err) {
  console.error("❌", err instanceof Error ? err.message.replace(/bot\d+:[\w-]+/g, "bot<redacted>") : err);
  process.exit(1);
}
