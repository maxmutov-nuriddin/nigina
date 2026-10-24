import type { Deck, DeckSlide } from "../ai/schemas.ts";

const LIMITS = {
  bullets: 6,
  bulletLen: 110,
  colBullets: 5,
  colBulletLen: 80,
  tableCols: 4,
  tableRows: 6,
  cellLen: 60,
  steps: 5,
  stepLen: 50,
  title: 80,
};

/** O'zbek lotin yozuvidagi o' g' va tutuq belgisini shriftlarda bor belgilarga keltiradi. */
export function normalizeText(s: string, language: string): string {
  let out = (s ?? "").replace(/\s+/g, " ").trim();
  if (language === "uz") {
    out = out.replace(/([OoGg])['`ʻʼ’‘]/g, "$1‘").replace(/(\p{L})['`ʼ’](?=\p{L})/gu, "$1’");
  }
  return out;
}

export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

// Statistik da'vo ko'rinishidagi raqamlar: foiz, valyuta, mln/mlrd
const STAT_RE = /(\d[\d\s.,]*\s*(%|foiz|процент|percent|mln|mlrd|million|milliard|млн|млрд|трлн|trillion|billion|\$|usd|dollar|долл|so[‘’'`]?m|сум|евро|euro|€))|([$€]\s?\d)/i;

/**
 * Manbasi yo'q statistikani olib tashlaydi: veb-qidiruv yo'q, shuning uchun foydalanuvchi materialida
 * bo'lmagan foiz/valyuta/mln raqamlari fakt sifatida slaydga tushmasligi kerak.
 */
export function hasUnverifiedStat(text: string, source: string): boolean {
  const m = STAT_RE.exec(text);
  if (!m) return false;
  const numbers = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return numbers.some((n) => !source.includes(n));
}

export interface SanitizeResult {
  deck: Deck;
  removedClaims: number;
}

export function sanitizeDeck(deck: Deck, opts: { language: string; contentSlides: number; source: string }): SanitizeResult {
  const n = (s: string | null | undefined) => normalizeText(s ?? "", opts.language);
  let removed = 0;
  const keep = (s: string) => {
    if (hasUnverifiedStat(s, opts.source)) {
      removed++;
      return false;
    }
    return s.length > 0;
  };
  const list = (arr: string[], max: number, len: number) => arr.map(n).filter(keep).slice(0, max).map((s) => clip(s, len));

  const slides: DeckSlide[] = [];
  for (const raw of deck.slides.slice(0, opts.contentSlides)) {
    const s: DeckSlide = {
      layout: raw.layout,
      title: clip(n(raw.title), LIMITS.title),
      bullets: list(raw.bullets, LIMITS.bullets, LIMITS.bulletLen),
      left_title: raw.left_title ? clip(n(raw.left_title), 40) : null,
      left_bullets: list(raw.left_bullets, LIMITS.colBullets, LIMITS.colBulletLen),
      right_title: raw.right_title ? clip(n(raw.right_title), 40) : null,
      right_bullets: list(raw.right_bullets, LIMITS.colBullets, LIMITS.colBulletLen),
      table_headers: raw.table_headers.map(n).slice(0, LIMITS.tableCols).map((h) => clip(h, 30)),
      table_rows: [],
      steps: list(raw.steps, LIMITS.steps, LIMITS.stepLen),
      notes: raw.notes ? n(raw.notes).slice(0, 1000) : null,
    };
    if (s.layout === "table") {
      const cols = s.table_headers.length;
      s.table_rows = raw.table_rows.slice(0, LIMITS.tableRows).map((row) => {
        const cells = row.slice(0, cols).map((c) => {
          const v = n(c);
          if (hasUnverifiedStat(v, opts.source)) {
            removed++;
            return "—";
          }
          return clip(v, LIMITS.cellLen);
        });
        while (cells.length < cols) cells.push("");
        return cells;
      });
      if (cols < 2 || s.table_rows.length < 1) {
        s.layout = "bullets";
        s.bullets = s.bullets.length ? s.bullets : raw.table_rows.map((r) => clip(r.map(n).join(" — "), LIMITS.bulletLen)).filter(keep).slice(0, LIMITS.bullets);
      }
    }
    if (s.layout === "process" && s.steps.length < 2) {
      s.layout = "bullets";
      s.bullets = [...s.steps, ...s.bullets].slice(0, LIMITS.bullets);
    }
    if (s.layout === "two_column" && (!s.left_bullets.length || !s.right_bullets.length)) {
      s.layout = "bullets";
      s.bullets = [...s.left_bullets, ...s.right_bullets, ...s.bullets].slice(0, LIMITS.bullets);
    }
    if (s.layout === "process") s.bullets = s.bullets.slice(0, 2);
    const empty = !s.bullets.length && !s.steps.length && !s.table_rows.length && !s.left_bullets.length;
    if (!s.title || empty) continue;
    slides.push(s);
  }
  return { deck: { title: clip(n(deck.title), 120), subtitle: deck.subtitle ? clip(n(deck.subtitle), 140) : null, slides }, removedClaims: removed };
}
