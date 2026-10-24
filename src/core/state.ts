import type { Deps } from "../deps.ts";
import type { AiAction } from "../ai/schemas.ts";
import { Prisma } from "../db.ts";

export interface PendingQuestion {
  /** Qaysi action (pending.actions ichidagi indeks) va qaysi maydon */
  actionIndex: number;
  field: string;
  text: string;
  options: Array<{ label: string; value: string }>;
}

export type Pending =
  | { kind: "clarify"; actions: AiAction[]; question: PendingQuestion; asked: number; key?: string }
  | { kind: "settings_tz" }
  | { kind: "settings_time" };

export interface HistoryTurn {
  role: "user" | "bot";
  text: string;
  at: string;
}

export interface RecentItem {
  type: "task" | "note" | "presentation" | "transaction";
  id: string;
  at: string;
}

export interface RetryInfo {
  text?: string;
  fileId?: string;
  updateId: string;
  messageId: number;
  kind: string;
}

export interface StateView {
  pending: Pending | null;
  pendingExpired: boolean;
  history: HistoryTurn[];
  recentItems: RecentItem[];
  retry: RetryInfo | null;
  version: number;
}

export async function loadState(deps: Deps, userId: string): Promise<StateView> {
  const now = deps.clock();
  const row = await deps.db.conversationState.upsert({ where: { userId }, create: { userId }, update: {} });
  const ttl = deps.cfg.CONVERSATION_HISTORY_TTL_MINUTES * 60_000;
  let pending = (row.pending as Pending | null) ?? null;
  let pendingExpired = false;
  if (pending && row.pendingExpiresAt && row.pendingExpiresAt < now) {
    pending = null;
    pendingExpired = true;
  }
  const history = ((row.history as unknown as HistoryTurn[]) ?? []).filter((h) => now.getTime() - Date.parse(h.at) < ttl);
  const recentItems = ((row.recentItems as unknown as RecentItem[]) ?? []).filter((h) => now.getTime() - Date.parse(h.at) < ttl * 4);
  return { pending, pendingExpired, history, recentItems, retry: (row.retry as RetryInfo | null) ?? null, version: row.version };
}

export async function setPending(deps: Deps, userId: string, pending: Pending | null): Promise<number> {
  const expires = pending ? new Date(deps.clock().getTime() + deps.cfg.CONVERSATION_PENDING_TTL_MINUTES * 60_000) : null;
  const row = await deps.db.conversationState.upsert({
    where: { userId },
    create: { userId, pending: (pending ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue, pendingExpiresAt: expires },
    update: { pending: (pending ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue, pendingExpiresAt: expires, version: { increment: 1 } },
  });
  return row.version;
}

export async function setRetry(deps: Deps, userId: string, retry: RetryInfo | null): Promise<void> {
  await deps.db.conversationState.upsert({
    where: { userId },
    create: { userId, retry: (retry ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue },
    update: { retry: (retry ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue },
  });
}

/** Qisqa tarix va oxirgi yozuvlarni yangilaydi (kontekst uchun). */
export async function remember(deps: Deps, userId: string, turns: Array<Omit<HistoryTurn, "at">>, items: Array<Omit<RecentItem, "at">>): Promise<void> {
  const state = await loadState(deps, userId);
  const at = deps.clock().toISOString();
  const history = [...state.history, ...turns.map((t) => ({ ...t, text: t.text.slice(0, 400), at }))].slice(-8);
  const seen = new Set<string>();
  const recentItems = [...items.map((i) => ({ ...i, at })), ...state.recentItems]
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .slice(0, 10);
  await deps.db.conversationState.update({
    where: { userId },
    data: { history: history as unknown as Prisma.InputJsonValue, recentItems: recentItems as unknown as Prisma.InputJsonValue },
  });
}
