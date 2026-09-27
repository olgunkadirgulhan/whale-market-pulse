import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LEAD_IN = 0.2;
const GAP = 0.3;
const TAIL = 1.0;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-1500)}`)),
    );
  });
}

async function probeDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Number.parseFloat(out);
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${file}`);
  return seconds;
}

// Scripts are written the way captions should read ("RSI 46", "$97M", "the 4H low"); the voice
// gets a speakable version of the same line while the caption keeps the digits.
const SCALE = { K: "thousand", M: "million", B: "billion", T: "trillion" };
export function forSpeech(text) {
  return text
    .replace(/\bRSI\b/g, "R S I")
    .replace(/\bSMA\b/g, "S M A")
    .replace(/\b(\d+)\s?[hH]\b(?=\s+(high|low|chart|candle|range|close|move|volume))/g, "$1-hour")
    .replace(/\b(\d+)\s?[hH]\b/g, "$1 hours")
    .replace(/\$(\d[\d,]*(?:\.\d+)?)\s?([KMBT])\b/g, (_, n, s) => `$${n} ${SCALE[s]}`)
    .replace(/~\s?/g, "about ");
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const FALLBACK_VOICES = ["en-US-AndrewNeural", "en-US-GuyNeural"];

// edge-tts is a free Microsoft endpoint that now and then answers with no audio
// (NoAudioReceived) for a while; on 2026-09-26 that failed four hourly runs in a row.
// Retry the same voice, then similar voices, then a plain-text version of the line.
async function speakLine(text, file, voice, rate) {
  const plain = (s) => s.replace(/[^\p{L}\p{N}\s.,?!'-]/gu, " ").replace(/\s+/g, " ").trim();
  const attempts = [
    [voice, forSpeech(text), 0],
    [voice, forSpeech(text), 8000],
    [voice, forSpeech(text), 20000],
    ...FALLBACK_VOICES.filter((v) => v !== voice).map((v) => [v, forSpeech(text), 5000]),
    [voice, plain(forSpeech(text)), 20000],
  ];
  let last;
  for (const [v, say, wait] of attempts) {
    if (wait) await sleep(wait);
    try {
      // "--text=" form: a line starting with "-" (e.g. "-3% today") would otherwise be parsed as an option
      await run("edge-tts", ["--voice", v, `--rate=${rate}`, `--text=${say}`, "--write-media", file]);
      if (v !== voice || say !== forSpeech(text)) console.log(`  tts fallback used: ${v}${say !== forSpeech(text) ? " (plain text)" : ""}`);
      return;
    } catch (err) {
      last = err;
      console.warn(`  tts retry (${v}): ${String(err.message).split("\n").filter(Boolean).pop()?.slice(0, 120)}`);
    }
  }
  throw last;
}

export async function synthesizeVoiceover(lines, { workDir, outFile, musicFile = null }) {
  const voice = process.env.TTS_VOICE || "en-US-AndrewMultilingualNeural";
  const rate = process.env.TTS_RATE || "+6%";
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const parts = [];
  for (const [i, text] of lines.entries()) {
    const file = path.join(workDir, `line_${i}.mp3`);
    await speakLine(text, file, voice, rate);
    parts.push({ file, duration: await probeDuration(file) });
  }

  let cursor = LEAD_IN;
  const timeline = parts.map((p, i) => {
    const start = cursor;
    cursor += p.duration + (i < parts.length - 1 ? GAP : 0);
    return { text: lines[i], start: round(start), duration: round(p.duration) };
  });
  const totalSec = round(cursor + TAIL);

  // Place every line at its exact offset on one track rather than concatenating,
  // so the caption timings above are the real audio timings.
  const inputs = parts.flatMap((p) => ["-i", p.file]);
  const delays = parts
    .map((_, i) => `[${i}:a]adelay=${Math.round(timeline[i].start * 1000)}:all=1[v${i}]`)
    .join(";");
  const voiceMix = `${parts.map((_, i) => `[v${i}]`).join("")}amix=inputs=${parts.length}:normalize=0[voice]`;

  const filters = [delays, voiceMix];
  let finalLabel = "voice";

  if (musicFile && fs.existsSync(musicFile)) {
    inputs.push("-stream_loop", "-1", "-i", musicFile);
    filters.push(`[${parts.length}:a]volume=0.07,afade=t=out:st=${totalSec - 1.5}:d=1.5[bed]`);
    filters.push(`[voice][bed]amix=inputs=2:duration=first:normalize=0[mixed]`);
    finalLabel = "mixed";
  }

  filters.push(`[${finalLabel}]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[out]`);

  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-t", String(totalSec),
    "-c:a", "libmp3lame", "-q:a", "2", "-ac", "2",
    outFile,
  ]);

  return { timeline, totalSec };
}

const round = (n) => Number(n.toFixed(3));
