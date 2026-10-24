import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";

/** Groq STT qabul qiladigan formatlar (rasmiy hujjat bo'yicha). */
const SUPPORTED = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
/** Telegram voice — OGG/Opus konteyner, faqat kengaytmasi .oga */
const OGG_ALIASES = new Set(["oga", "opus", "ogx"]);

export class AudioFormatError extends Error {}

export async function prepareAudio(buffer: Buffer, ext: string, cfg: Config): Promise<{ buffer: Buffer; filename: string; converted: boolean }> {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (OGG_ALIASES.has(e)) return { buffer, filename: "audio.ogg", converted: false };
  if (SUPPORTED.has(e)) return { buffer, filename: `audio.${e}`, converted: false };
  return { buffer: await convertWithFfmpeg(buffer, e || "bin", cfg), filename: "audio.flac", converted: true };
}

/** Mos kelmagan formatni 16 kHz mono FLAC'ga aylantiradi. Vaqtinchalik fayllar har doim o'chiriladi. */
export async function convertWithFfmpeg(buffer: Buffer, ext: string, cfg: Config): Promise<Buffer> {
  const dir = path.resolve(cfg.TMP_DIR);
  await mkdir(dir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const input = path.join(dir, `${id}.${ext.replace(/[^a-z0-9]/gi, "") || "bin"}`);
  const output = path.join(dir, `${id}.flac`);
  try {
    await writeFile(input, buffer);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "flac", output], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += String(d)));
      p.on("error", (err) => reject(new AudioFormatError(`ffmpeg ishga tushmadi: ${err.message}`)));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new AudioFormatError(`ffmpeg xatosi (${code}): ${stderr.slice(0, 200)}`))));
    });
    return await readFile(output);
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}
