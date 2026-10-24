// AIx27siz namunaviy PPTX yaratadi (dizayn/renderni tekshirish uchun): npm run sample:pptx -- out.pptx
import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { renderDeck } from "../src/presentations/render.ts";
import { sanitizeDeck } from "../src/presentations/sanitize.ts";
const base = { bullets: [], left_title: null, left_bullets: [], right_title: null, right_bullets: [], table_headers: [], table_rows: [], steps: [], notes: null };
const raw = { title: "Startaplarni moliyalashtirish", subtitle: "Innovatsion iqtisodiyot fanidan taqdimot", slides: [
  { ...base, layout: "bullets", title: "Kirish", bullets: ["Startap — tez o'sishga yo'naltirilgan yangi biznes", "Moliyalashtirish bosqichlari va manbalari", "Bozor 2023-yilda 45% o'sdi"] },
  { ...base, layout: "process", title: "Moliyalashtirish bosqichlari", steps: ["Pre-seed", "Seed", "A raund", "B raund", "IPO"], bullets: ["Har bosqichda investor turi o'zgaradi"] },
  { ...base, layout: "table", title: "Manbalar taqqoslash", table_headers: ["Manba", "Afzallik", "Kamchilik"], table_rows: [["Biznes-farishtalar", "Tajriba va aloqalar", "Kichik summalar"], ["Venchur fondlar", "Katta mablag'", "Ulush talab qilinadi"], ["Krautfanding", "Bozorni sinash", "Marketing xarajati"]] },
  { ...base, layout: "two_column", title: "Grant va kredit", left_title: "Grantlar", left_bullets: ["Qaytarilmaydi", "Raqobat yuqori"], right_title: "Kreditlar", right_bullets: ["Garov talab qilinadi", "Foiz to'lovlari"] },
  { ...base, layout: "conclusion", title: "Xulosa", bullets: ["To'g'ri manba bosqichga bog'liq", "Diversifikatsiya xavfni kamaytiradi", "Moliyaviy rejalashtirish muhim"], notes: "Rahmat!" },
]};
const { deck, removedClaims } = sanitizeDeck(raw as any, { language: "uz", contentSlides: 9, source: "Startaplarni moliyalashtirish" });
const { buffer, slideCount } = await renderDeck(deck, { language: "uz" });
writeFileSync(process.argv[2] ?? "sample.pptx", buffer);
const zip = await JSZip.loadAsync(buffer);
const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
console.log({ bytes: buffer.length, slideCount, slides: slides.length, removedClaims });
const s1 = await zip.file("ppt/slides/slide2.xml")!.async("string");
console.log(s1.includes("o‘sish") ? "uz apostrophe ok" : "apostrophe?", s1.includes("45%") ? "STAT LEAKED" : "stat removed");
const pres = await zip.file("ppt/presentation.xml")!.async("string");
console.log(pres.match(/sldSz[^/]*/)?.[0]);
