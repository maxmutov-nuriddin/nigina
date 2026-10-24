import { DateTime } from "luxon";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Db, User } from "../db.ts";
import { t } from "../lib/i18n.ts";
import { monthName } from "../lib/time.ts";

export type FinancePeriod = "today" | "this_week" | "this_month" | "last_month";

/** Majburiy (odatda oyiga bir marta to'lanadigan) toifalar — sur'at bo'yicha ekstrapolyatsiya qilinmaydi */
const FIXED = new Set(["housing", "utilities", "debt", "communication", "education"]);
const DAY = 86400_000;

export interface CategoryTotal {
  category: string;
  total: number;
  share: number;
}

export interface FinanceStats {
  period: FinancePeriod;
  currency: string;
  start: string;
  end: string;
  txCount: number;
  income: number;
  expense: number;
  net: number;
  expenseByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  otherCurrencies: Array<{ currency: string; count: number }>;
  month?: {
    label: string;
    daysElapsed: number;
    daysInMonth: number;
    avgDailyExpense: number;
    /** Oy oxiri prognozi (joriy sur'atda) */
    forecast: {
      expense: number;
      expectedFixed: number;
      income: number;
      incomeFromAverage: boolean;
      net: number;
    };
    prev: { expenseSamePoint: number; expenseTotal: number; income: number } | null;
    /** O'tgan oyning shu nuqtasiga nisbatan xarajat o'zgarishi (0.12 = +12%) */
    paceVsPrev: number | null;
  };
}

interface Tx {
  kind: "expense" | "income";
  amount: { toNumber(): number } | number;
  currency: string;
  category: string;
  occurredAt: Date;
}

const num = (v: Tx["amount"]) => (typeof v === "number" ? v : v.toNumber());
const round = (v: number) => Math.round(v * 100) / 100;

export function periodRange(period: FinancePeriod, now: Date, tz: string): { start: DateTime; end: DateTime } {
  const local = DateTime.fromJSDate(now, { zone: tz });
  switch (period) {
    case "today":
      return { start: local.startOf("day"), end: local.endOf("day") };
    case "this_week":
      return { start: local.startOf("week"), end: local.endOf("week") };
    case "last_month": {
      const m = local.minus({ months: 1 });
      return { start: m.startOf("month"), end: m.endOf("month") };
    }
    default:
      return { start: local.startOf("month"), end: local.endOf("month") };
  }
}

function sums(txs: Tx[]) {
  let income = 0;
  let expense = 0;
  const exp = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const tx of txs) {
    const v = num(tx.amount);
    if (tx.kind === "income") {
      income += v;
      inc.set(tx.category, (inc.get(tx.category) ?? 0) + v);
    } else {
      expense += v;
      exp.set(tx.category, (exp.get(tx.category) ?? 0) + v);
    }
  }
  const list = (m: Map<string, number>, total: number) =>
    [...m.entries()].map(([category, v]) => ({ category, total: round(v), share: total ? round(v / total) : 0 })).sort((a, b) => b.total - a.total);
  return { income, expense, exp, expenseByCategory: list(exp, expense), incomeByCategory: list(inc, income) };
}

/** Sof hisob-kitob (testlanadigan): tranzaksiyalar ro'yxatidan statistika va prognoz. */
export function computeFromTransactions(
  period: FinancePeriod,
  currency: string,
  now: Date,
  tz: string,
  current: Tx[],
  history: Tx[] = [],
  lang: "uz" | "ru" = "uz",
): FinanceStats {
  const { start, end } = periodRange(period, now, tz);
  const main = current.filter((x) => x.currency === currency);
  const others = new Map<string, number>();
  for (const x of current) if (x.currency !== currency) others.set(x.currency, (others.get(x.currency) ?? 0) + 1);
  const s = sums(main);

  const stats: FinanceStats = {
    period,
    currency,
    start: start.toISO()!,
    end: end.toISO()!,
    txCount: main.length,
    income: round(s.income),
    expense: round(s.expense),
    net: round(s.income - s.expense),
    expenseByCategory: s.expenseByCategory,
    incomeByCategory: s.incomeByCategory,
    otherCurrencies: [...others.entries()].map(([c, count]) => ({ currency: c, count })),
  };
  if (period !== "this_month") return stats;

  const nowL = DateTime.fromJSDate(now, { zone: tz });
  const daysInMonth = start.daysInMonth!;
  const elapsedMs = Math.max(nowL.toMillis() - start.toMillis(), 0);
  const daysElapsed = Math.min(Math.max(elapsedMs / DAY, 1), daysInMonth);
  const remaining = Math.max(daysInMonth - daysElapsed, 0);

  // Oldingi oylar
  const hist = history.filter((x) => x.currency === currency);
  const prevStart = start.minus({ months: 1 });
  const prevEnd = start.minus({ milliseconds: 1 });
  const prevTx = hist.filter((x) => x.occurredAt >= prevStart.toJSDate() && x.occurredAt <= prevEnd.toJSDate());
  const prevSums = sums(prevTx);
  const samePoint = prevStart.plus({ milliseconds: elapsedMs }).toJSDate();
  const prevSamePoint = sums(prevTx.filter((x) => x.occurredAt < samePoint)).expense;

  // Majburiy to'lovlar: shu oy hali to'lanmagan, lekin o'tgan oyda bo'lganlari kutiladi
  let fixedSoFar = 0;
  let expectedFixed = 0;
  for (const [cat, v] of s.exp) if (FIXED.has(cat)) fixedSoFar += v;
  for (const [cat, v] of prevSums.exp) if (FIXED.has(cat)) expectedFixed += Math.max(0, v - (s.exp.get(cat) ?? 0));
  const variable = s.expense - fixedSoFar;
  const forecastExpense = s.expense + (variable / daysElapsed) * remaining + expectedFixed;

  // Daromad: oldingi (3 tagacha) oylar o'rtachasi bilan solishtiramiz — daromad odatda bir martada tushadi
  const prevIncomes: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const ms = start.minus({ months: i });
    const me = ms.endOf("month");
    const inc = sums(hist.filter((x) => x.occurredAt >= ms.toJSDate() && x.occurredAt <= me.toJSDate())).income;
    if (inc > 0) prevIncomes.push(inc);
  }
  const avgPrevIncome = prevIncomes.length ? prevIncomes.reduce((a, b) => a + b, 0) / prevIncomes.length : 0;
  const incomeFromAverage = avgPrevIncome > s.income;
  const forecastIncome = Math.max(s.income, avgPrevIncome);

  stats.month = {
    label: `${monthName(start.month, lang)} ${start.year}`,
    daysElapsed: Math.floor(daysElapsed),
    daysInMonth,
    avgDailyExpense: round(variable / daysElapsed),
    forecast: {
      expense: round(forecastExpense),
      expectedFixed: round(expectedFixed),
      income: round(forecastIncome),
      incomeFromAverage,
      net: round(forecastIncome - forecastExpense),
    },
    prev: prevTx.length ? { expenseSamePoint: round(prevSamePoint), expenseTotal: round(prevSums.expense), income: round(prevSums.income) } : null,
    paceVsPrev: prevSamePoint > 0 ? round(s.expense / prevSamePoint - 1) : null,
  };
  return stats;
}

export async function computeStats(db: Db, user: User, period: FinancePeriod, now: Date): Promise<FinanceStats> {
  const { start, end } = periodRange(period, now, user.timezone);
  const current = await db.transaction.findMany({ where: { userId: user.id, occurredAt: { gte: start.toJSDate(), lte: end.toJSDate() } } });
  const history =
    period === "this_month"
      ? await db.transaction.findMany({ where: { userId: user.id, occurredAt: { gte: start.minus({ months: 3 }).toJSDate(), lt: start.toJSDate() } } })
      : [];
  return computeFromTransactions(period, user.currency, now, user.timezone, current, history, user.language);
}

// ---------------- Formatlash ----------------

const ZERO_DECIMAL = new Set(["UZS", "RUB", "KZT"]);
const CUR_NAMES: Record<string, [string, string]> = { UZS: ["so‘m", "сум"], USD: ["$", "$"], RUB: ["rubl", "₽"], EUR: ["€", "€"], KZT: ["tenge", "₸"] };

export function money(v: number, currency: string, lang: "uz" | "ru" = "uz", signed = false): string {
  // So'm, rubl, tenge — tiyinsiz ko'rsatiladi
  const abs = ZERO_DECIMAL.has(currency) ? Math.round(Math.abs(v)) : Math.abs(v);
  const fixed = Number.isInteger(Math.round(abs * 100) / 100) ? Math.round(abs).toString() : abs.toFixed(2);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
  const name = CUR_NAMES[currency]?.[lang === "ru" ? 1 : 0] ?? currency;
  return `${sign}${grouped}${frac ? `,${frac}` : ""} ${name}`;
}

export function categoryLabel(cat: string, lang: "uz" | "ru"): string {
  return t(lang).fin.cats[cat] ?? cat;
}

export function financeKeyboard(lang: "uz" | "ru"): InlineKeyboardMarkup {
  const B = t(lang).fin.btn;
  return {
    inline_keyboard: [
      [
        { text: B.today, callback_data: "fr:today" },
        { text: B.week, callback_data: "fr:this_week" },
      ],
      [
        { text: B.month, callback_data: "fr:this_month" },
        { text: B.last, callback_data: "fr:last_month" },
      ],
    ],
  };
}

export function formatReport(user: User, s: FinanceStats, insight: string | null): string {
  const lang = user.language;
  const F = t(lang).fin;
  const m = (v: number, signed = false) => money(v, s.currency, lang, signed);
  if (s.txCount === 0 && !s.otherCurrencies.length) return `${F.title(s.month?.label ?? F.periods[s.period])}\n\n${F.empty}`;

  const lines = [F.title(s.month?.label ?? F.periods[s.period]) + (s.month ? F.progress(s.month.daysElapsed, s.month.daysInMonth) : ""), ""];
  lines.push(F.income(m(s.income)), F.expense(m(s.expense)), F.balance(m(s.net, true)));

  if (s.month) {
    const mo = s.month;
    lines.push("", F.pace(m(mo.avgDailyExpense)), "", F.forecastTitle);
    lines.push(F.fExpense(m(mo.forecast.expense), mo.forecast.expectedFixed > 0 ? m(mo.forecast.expectedFixed) : null));
    lines.push(F.fIncome(m(mo.forecast.income), mo.forecast.incomeFromAverage));
    lines.push(mo.forecast.net >= 0 ? F.fProfit(m(mo.forecast.net)) : F.fLoss(m(Math.abs(mo.forecast.net))));
    if (mo.paceVsPrev !== null) {
      const pct = Math.round(mo.paceVsPrev * 100);
      lines.push("", F.vsPrev(`${pct > 0 ? "+" : ""}${pct}%`));
    }
    if (s.income === 0 && !mo.forecast.incomeFromAverage) lines.push("", F.noIncome);
  }

  if (s.expenseByCategory.length) {
    lines.push("", F.catsTitle);
    for (const c of s.expenseByCategory.slice(0, 8)) lines.push(`• ${categoryLabel(c.category, lang)} — ${m(c.total)} (${Math.round(c.share * 100)}%)`);
  }
  if (s.incomeByCategory.length > 1) {
    lines.push("", F.incomeCatsTitle);
    for (const c of s.incomeByCategory.slice(0, 5)) lines.push(`• ${categoryLabel(c.category, lang)} — ${m(c.total)}`);
  }
  if (s.otherCurrencies.length) lines.push("", F.otherCur(s.otherCurrencies.map((o) => `${o.currency} (${o.count})`).join(", ")));
  if (insight) lines.push("", F.insightTitle, insight);
  return lines.join("\n");
}

export function formatBrief(user: User, s: FinanceStats): string {
  const F = t(user.language).fin;
  const m = (v: number, signed = false) => money(v, s.currency, user.language, signed);
  return F.brief(s.month?.label ?? F.periods[s.period], m(s.expense), m(s.income), m(s.net, true));
}
