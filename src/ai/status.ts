import type { Deps } from "../deps.ts";
import type { Prisma, User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { fmt } from "../core/format.ts";
import { toLocal } from "../lib/time.ts";

/** Sozlangan provayderlar (jurnal nomi bo'yicha) */
function configuredProviders(cfg: Deps["cfg"]): string[] {
  const out: string[] = [];
  if (cfg.GEMINI_API_KEY) out.push("gemini");
  if (cfg.GROQ_API_KEY) out.push("groq");
  if (cfg.GROQ_ANALYSIS_API_KEY && cfg.GROQ_ANALYSIS_API_KEY !== cfg.GROQ_API_KEY) out.push("groq:analysis");
  return out;
}

/** Eski yozuvlarda provayder yo'q — model nomidan aniqlanadi */
function whereProvider(p: string): Prisma.AiUsageLogWhereInput {
  if (p === "groq") return { OR: [{ provider: "groq" }, { provider: null, NOT: { model: { startsWith: "gemini" } } }] };
  if (p === "gemini") return { OR: [{ provider: "gemini" }, { provider: null, model: { startsWith: "gemini" } }] };
  return { provider: p };
}

/**
 * /settings uchun AI holati: har bir provayderning oxirgi natijasi, limit bo'lsa — qachon ochilishi, 24 soatlik token sarfi.
 * Groq kunlik qolgan tokenni oldindan aytmaydi, shuning uchun holat haqiqiy so'rovlar natijasidan olinadi.
 */
export async function aiStatusText(deps: Deps, user: User): Promise<string> {
  const L = t(user.language).ai;
  const now = deps.clock();
  const at = (d: Date) => (toLocal(d, user.timezone).hasSame(toLocal(now, user.timezone), "day") ? toLocal(d, user.timezone).toFormat("HH:mm") : fmt(user, d));
  const num = (n: number) => n.toLocaleString("ru-RU").replace(/ /g, " ");
  const lines = [L.title];
  for (const p of configuredProviders(deps.cfg)) {
    const where = whereProvider(p);
    const [last, lastOk, lastLimit, sum] = await Promise.all([
      deps.db.aiUsageLog.findFirst({ where, orderBy: { createdAt: "desc" } }),
      deps.db.aiUsageLog.findFirst({ where: { AND: [where, { ok: true }] }, orderBy: { createdAt: "desc" } }),
      deps.db.aiUsageLog.findFirst({ where: { AND: [where, { errorCode: "rate_limit" }] }, orderBy: { createdAt: "desc" } }),
      deps.db.aiUsageLog.aggregate({ where: { AND: [where, { createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } }] }, _sum: { promptTokens: true, completionTokens: true } }),
    ]);
    let state: string;
    if (!last) state = L.never;
    else if (lastLimit && (!lastOk || lastLimit.createdAt > lastOk.createdAt)) {
      // Muvaffaqiyatli so'rovdan keyin limitga urilgan — hozir ham yopiq bo'lishi mumkin
      if (lastLimit.retryUntil && lastLimit.retryUntil > now) {
        state = L.limited(lastLimit.limitScope === "day", at(lastLimit.retryUntil), Math.ceil((lastLimit.retryUntil.getTime() - now.getTime()) / 1000));
      } else if (lastLimit.retryUntil) state = L.reopened(at(lastLimit.retryUntil));
      else state = L.limitedUnknown(at(lastLimit.createdAt));
    } else if (last.errorCode === "auth") state = L.auth;
    else if (last.ok || (lastOk && last.errorCode === "bad_output")) state = L.ok(at((lastOk ?? last).createdAt));
    else state = L.failed(at(last.createdAt));
    lines.push(`${L.names[p] ?? p}: ${state}`);
    const used = (sum._sum.promptTokens ?? 0) + (sum._sum.completionTokens ?? 0);
    if (used > 0) {
      const limit = p.startsWith("groq") && deps.cfg.GROQ_DAILY_TOKEN_LIMIT > 0 ? num(deps.cfg.GROQ_DAILY_TOKEN_LIMIT) : null;
      lines.push(L.tokens(num(used), limit));
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
