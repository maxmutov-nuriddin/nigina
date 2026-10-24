import pptxImport from "pptxgenjs";
import type { Deck, DeckSlide } from "../ai/schemas.ts";

// pptxgenjs tiplari CJS uslubida (nodenext'da default = modul); runtime'da ESM default — klassning o'zi
type PptxCtor = typeof pptxImport.default;
type PptxGenJS = InstanceType<PptxCtor>;
const PptxGenJS = ((pptxImport as unknown as { default?: PptxCtor }).default ?? pptxImport) as unknown as PptxCtor;

/** 16:9 maket: 10 x 5.625 dyuym */
const W = 10;
const THEME = {
  primary: "1F3A5F",
  accent: "2A9D8F",
  accent2: "E9C46A",
  text: "1E293B",
  muted: "64748B",
  light: "F1F5F9",
  border: "E2E8F0",
  white: "FFFFFF",
  font: "Calibri",
};

/**
 * Matnga mos shrift o'lchamini taxminiy hisoblaydi — matn quti chetidan chiqmasligi uchun.
 * Calibri o'rtacha belgi kengligi ~0.5em.
 */
export function fitFontSize(paragraphs: string[], wInch: number, hInch: number, maxPt: number, minPt: number, paraGapPt = 6): number {
  for (let pt = maxPt; pt >= minPt; pt--) {
    const charsPerLine = Math.max(8, Math.floor((wInch * 72 - 18) / (pt * 0.5)));
    const lines = paragraphs.reduce((sum, p) => sum + Math.max(1, Math.ceil(p.length / charsPerLine)), 0);
    const heightPt = lines * pt * 1.22 + paragraphs.length * paraGapPt;
    if (heightPt <= hInch * 72 * 0.9) return pt;
  }
  return minPt;
}

export async function renderDeck(deck: Deck, _meta: { language: string }): Promise<{ buffer: Buffer; slideCount: number }> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = deck.title;
  pptx.subject = deck.title;
  pptx.company = "Nigina";
  pptx.theme = { headFontFace: THEME.font, bodyFontFace: THEME.font };

  pptx.defineSlideMaster({
    title: "CONTENT",
    background: { color: THEME.white },
    objects: [
      { rect: { x: 0, y: 0, w: W, h: 0.12, fill: { color: THEME.accent } } },
      { text: { text: deck.title.slice(0, 80), options: { x: 0.5, y: 5.22, w: 7.5, h: 0.3, fontFace: THEME.font, fontSize: 10, color: THEME.muted } } },
    ],
    slideNumber: { x: 9.1, y: 5.22, w: 0.5, h: 0.3, fontFace: THEME.font, fontSize: 10, color: THEME.muted, align: "right" },
  });

  // Titul slayd
  const title = pptx.addSlide();
  title.background = { color: THEME.primary };
  title.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 5.625, fill: { color: THEME.accent } });
  title.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.15, w: 1.6, h: 0.06, fill: { color: THEME.accent2 } });
  title.addText(deck.title, {
    x: 0.8, y: 1.0, w: 8.4, h: 2.0,
    fontFace: THEME.font, bold: true, color: THEME.white, valign: "bottom",
    fontSize: fitFontSize([deck.title], 8.4, 2.0, 40, 24, 0),
  });
  if (deck.subtitle) {
    title.addText(deck.subtitle, { x: 0.8, y: 3.35, w: 8.4, h: 1.0, fontFace: THEME.font, color: "CBD5E1", valign: "top", fontSize: fitFontSize([deck.subtitle], 8.4, 1.0, 20, 14, 0) });
  }

  for (const s of deck.slides) {
    const slide = pptx.addSlide({ masterName: "CONTENT" });
    slide.addText(s.title, {
      x: 0.5, y: 0.3, w: 9, h: 0.8,
      fontFace: THEME.font, bold: true, color: THEME.primary, valign: "middle",
      fontSize: fitFontSize([s.title], 9, 0.8, 28, 18, 0),
    });
    slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.1, w: 1.2, h: 0.05, fill: { color: THEME.accent } });
    switch (s.layout) {
      case "two_column":
        renderTwoColumn(pptx, slide, s);
        break;
      case "table":
        renderTable(slide, s);
        break;
      case "process":
        renderProcess(pptx, slide, s);
        break;
      case "conclusion":
        slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.35, w: 9, h: 3.7, fill: { color: THEME.light } });
        slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.35, w: 0.1, h: 3.7, fill: { color: THEME.accent } });
        addBullets(slide, s.bullets, { x: 0.8, y: 1.5, w: 8.5, h: 3.4 }, 22);
        break;
      default:
        addBullets(slide, s.bullets, { x: 0.6, y: 1.35, w: 8.8, h: 3.75 }, 24);
    }
    if (s.notes) slide.addNotes(s.notes);
  }

  const out = (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array;
  return { buffer: Buffer.from(out), slideCount: deck.slides.length + 1 };
}

type Slide = ReturnType<PptxGenJS["addSlide"]>;
type Box = { x: number; y: number; w: number; h: number };

function addBullets(slide: Slide, bullets: string[], box: Box, maxPt: number, color = THEME.text): void {
  if (!bullets.length) return;
  const size = fitFontSize(bullets, box.w - 0.4, box.h, maxPt, 12, 8);
  slide.addText(
    bullets.map((b) => ({ text: b, options: { bullet: { indent: size * 0.9 }, paraSpaceAfter: 8, breakLine: true } })),
    { ...box, fontFace: THEME.font, fontSize: size, color, valign: "top", lineSpacingMultiple: 1.05 },
  );
}

function renderTwoColumn(pptx: PptxGenJS, slide: Slide, s: DeckSlide): void {
  const cols: Array<[string | null, string[], number]> = [
    [s.left_title, s.left_bullets, 0.5],
    [s.right_title, s.right_bullets, 5.15],
  ];
  const all = [...s.left_bullets, ...s.right_bullets];
  const size = fitFontSize(all.length ? all.slice(0, Math.max(s.left_bullets.length, s.right_bullets.length)) : [""], 3.75, 2.9, 20, 12, 8);
  for (const [heading, bullets, x] of cols) {
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 1.35, w: 4.35, h: 3.75, fill: { color: THEME.light }, line: { color: THEME.border }, rectRadius: 0.08 });
    if (heading) slide.addText(heading, { x: x + 0.2, y: 1.45, w: 3.95, h: 0.55, fontFace: THEME.font, bold: true, fontSize: 18, color: THEME.accent, valign: "middle" });
    slide.addText(
      bullets.map((b) => ({ text: b, options: { bullet: { indent: size * 0.9 }, paraSpaceAfter: 6, breakLine: true } })),
      { x: x + 0.3, y: 2.05, w: 3.85, h: 2.95, fontFace: THEME.font, fontSize: size, color: THEME.text, valign: "top" },
    );
  }
}

function renderTable(slide: Slide, s: DeckSlide): void {
  const cols = s.table_headers.length;
  const colW = 9 / cols;
  const charsPerLine = (pt: number) => Math.floor((colW * 72 - 10) / (pt * 0.5));
  let size = 16;
  while (size > 10) {
    const rowLines = s.table_rows.map((r) => Math.max(...r.map((c) => Math.ceil(Math.max(1, c.length) / charsPerLine(size)))));
    const heightIn = ((rowLines.reduce((a, b) => a + b, 0) + 1.3) * size * 1.35 + (s.table_rows.length + 1) * 8) / 72;
    if (heightIn <= 3.6) break;
    size--;
  }
  const header = s.table_headers.map((h) => ({ text: h, options: { bold: true, color: THEME.white, fill: { color: THEME.primary } } }));
  const rows = s.table_rows.map((r, i) => r.map((c) => ({ text: c, options: { color: THEME.text, fill: { color: i % 2 ? "F8FAFC" : THEME.white } } })));
  slide.addTable([header, ...rows], {
    x: 0.5, y: 1.4, w: 9, colW: Array(cols).fill(colW),
    fontFace: THEME.font, fontSize: size, valign: "middle",
    border: { type: "solid", pt: 0.75, color: THEME.border },
    margin: 0.06, autoPage: false,
  });
}

function renderProcess(pptx: PptxGenJS, slide: Slide, s: DeckSlide): void {
  const n = s.steps.length;
  const gap = 0.4;
  const boxW = (9 - gap * (n - 1)) / n;
  const y = 1.65;
  const h = 1.5;
  const size = fitFontSize([s.steps.reduce((a, b) => (a.length > b.length ? a : b), "")], boxW - 0.2, h - 0.45, 16, 11, 0);
  s.steps.forEach((step, i) => {
    const x = 0.5 + i * (boxW + gap);
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: boxW, h, fill: { color: i % 2 ? THEME.accent : THEME.primary }, rectRadius: 0.1 });
    slide.addText(String(i + 1), { x: x + 0.12, y: y + 0.08, w: 0.4, h: 0.35, fontFace: THEME.font, bold: true, fontSize: 14, color: THEME.accent2 });
    slide.addText(step, { x: x + 0.1, y: y + 0.4, w: boxW - 0.2, h: h - 0.5, fontFace: THEME.font, fontSize: size, color: THEME.white, align: "center", valign: "middle" });
    if (i < n - 1) {
      slide.addShape(pptx.ShapeType.rightArrow, { x: x + boxW + 0.07, y: y + h / 2 - 0.13, w: gap - 0.14, h: 0.26, fill: { color: THEME.muted } });
    }
  });
  if (s.bullets.length) addBullets(slide, s.bullets, { x: 0.6, y: 3.45, w: 8.8, h: 1.6 }, 18);
}
