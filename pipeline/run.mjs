import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { fetchMarketContext, selectSegments } from "./market.mjs";
import { computeMetrics, sentimentOf } from "./indicators.mjs";
import { headlinesFor } from "./news.mjs";
import { generateScript } from "./script.mjs";
import { synthesizeVoiceover } from "./tts.mjs";
import { addToPlaylist, discoverTrendingHashtags, setThumbnail, uploadVideo, youtubeClient } from "./youtube.mjs";
import { notify } from "./notify.mjs";

const ROOT = process.cwd();
const HISTORY_FILE = path.join(ROOT, "state", "history.json");
const COIN_COUNT = 1; // one coin's story per video
const REPEAT_WINDOW = 6; // a coin isn't the subject again within the last 6 videos (~2 days)

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const slotArg = args.find((a) => a.startsWith("--slot="))?.split("=")[1];

function slotForNow() {
  const hour = new Date().getUTCHours();
  if (hour < 17) return "open";
  if (hour < 20) return "mover";
  return "trending";
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function sh(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

async function downloadLogo(url, dest) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return path.basename(dest);
  } catch {
    return null;
  }
}

const round2 = (n) => Number(n.toFixed(2));

async function main() {
  const slot = slotArg || slotForNow();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const history = loadHistory();
  const recentCoinIds = history.slice(-REPEAT_WINDOW).flatMap((h) => h.coinIds ?? (h.coinId ? [h.coinId] : []));

  console.log(`\n=== slot: ${slot} | ${stamp} | dryRun=${dryRun} ===`);

  console.log("1/8 market data");
  const context = await fetchMarketContext();
  const picked = await selectSegments(slot, context, recentCoinIds, COIN_COUNT);
  if (picked.length < COIN_COUNT) {
    throw new Error(`Only found ${picked.length}/${COIN_COUNT} tradeable coins with enough history`);
  }

  console.log("2/8 indicators");
  const segmentsBase = picked.map(({ coin, candles }) => {
    const metrics = computeMetrics(coin, candles);
    return { coin, candles, metrics, sentiment: sentimentOf(metrics) };
  });
  for (const s of segmentsBase) {
    console.log(
      `  ${s.coin.symbol.toUpperCase().padEnd(6)} $${s.metrics.priceText} ${s.metrics.change24hPct}% RSI ${s.metrics.rsi14} ${s.metrics.trend}`,
    );
  }

  console.log("3/8 news + script");
  const headlines = await headlinesFor(segmentsBase[0].coin);
  for (const h of headlines) console.log(`  ${h.source} (${h.age_hours}h): ${h.title}`);
  const { script, usage } = await generateScript({
    slot,
    segments: segmentsBase,
    global: context.global,
    avoidTitles: history.slice(-10).map((h) => h.title),
    headlines,
  });
  console.log(`  "${script.title}"`);
  console.log(`  hook: ${script.spokenHook}`);
  if (script.headline) console.log(`  uses headline: ${script.headline.title}`);
  console.log(`  tokens in/out: ${usage.input_tokens}/${usage.output_tokens}`);

  console.log("4/8 voiceover");
  // Spoken hook first (the first two seconds decide whether a viewer stays), then the story, then the CTA.
  const allLines = [script.spokenHook, ...script.segmentLines.flat(), script.cta];
  const audioPublicPath = path.join(ROOT, "public", "voice.mp3");
  const { timeline, totalSec } = await synthesizeVoiceover(allLines, {
    workDir: path.join(ROOT, "out", "tts"),
    outFile: audioPublicPath,
    musicFile: path.join(ROOT, "public", "music.mp3"),
  });
  console.log(`  ${timeline.length} lines, ${totalSec}s`);

  console.log("5/8 logos + segment timing");
  // Segment boundaries share the same value with their neighbor (computed once,
  // assigned to both endSec and the next startSec) so panels cut with no gap.
  // Line 0 is the spoken hook (played over the hook card, with the first panel behind it);
  // each segment then ends where the next segment's first line (or the closing CTA) begins.
  const boundaries = [0];
  let lineIdx = 1;
  for (let i = 0; i < segmentsBase.length; i++) {
    lineIdx += script.segmentLines[i].length;
    const candidate = round2(timeline[lineIdx].start - 0.3);
    boundaries.push(Math.max(boundaries[i] + 1, candidate));
  }
  const hookSec = round2(Math.max(2.2, timeline[0].start + timeline[0].duration + 0.15));

  const segments = [];
  for (let i = 0; i < segmentsBase.length; i++) {
    const { coin, candles, metrics, sentiment } = segmentsBase[i];
    const logoFile = await downloadLogo(coin.image, path.join(ROOT, "public", `coin-${i}.png`));
    segments.push({
      coin: { id: coin.id, name: coin.name, symbol: coin.symbol.toUpperCase(), image: coin.image },
      metrics,
      candles,
      sentiment,
      logoFile,
      startSec: boundaries[i],
      endSec: boundaries[i + 1],
    });
  }

  // Randomized per video (not on a fixed cadence) so the channel doesn't
  // publish one visually identical template every time - a fixed rotation
  // would itself be a detectable pattern.
  const style = Math.random() < 0.5 ? "panel" : "spotlight";
  console.log(`  visual style: ${style}`);

  const props = {
    slot,
    style,
    hook: script.hook,
    hookSec,
    takeaway: script.takeaway,
    ctaText: script.cta,
    segments,
    captions: timeline,
    durationSec: totalSec,
    audioFile: "voice.mp3",
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.join(ROOT, "out"), { recursive: true });
  const propsFile = path.join(ROOT, "out", "props.json");
  fs.writeFileSync(propsFile, JSON.stringify(props, null, 2));

  console.log("6/9 render");
  const videoFile = path.join(ROOT, "out", `${stamp}-${slot}.mp4`);
  // Duration comes from calculateMetadata reading props.durationSec, so no --frames here.
  await sh("npx", ["remotion", "render", "src/index.ts", "CryptoShort", videoFile, `--props=${propsFile}`]);
  const sizeMb = (fs.statSync(videoFile).size / 1e6).toFixed(1);
  console.log(`  ${videoFile} (${sizeMb} MB)`);

  console.log("7/9 thumbnail");
  // Frame 50 (1.67s into the 2.6s hook): past every chip's entrance spring
  // (last one settles ~frame 34) and before the hook's own fade-out starts
  // (frame 68), so it's a fully-settled, legible still of the hook card.
  const thumbFile = path.join(ROOT, "out", `${stamp}-${slot}-thumb.png`);
  await sh("npx", [
    "remotion", "still", "src/index.ts", "CryptoShort", thumbFile,
    `--props=${propsFile}`, "--frame=50",
  ]);
  console.log(`  ${thumbFile}`);

  let videoId = null;
  let hashtags = [];
  let thumbnailSet = false;

  if (dryRun) {
    console.log("8/9 upload skipped (--dry-run)");
  } else {
    console.log("8/9 hashtags + upload + thumbnail");
    const yt = youtubeClient();
    hashtags = await discoverTrendingHashtags(yt, segments.map((s) => s.coin));
    console.log(`  ${hashtags.join(" ")}`);
    videoId = await uploadVideo(yt, {
      file: videoFile,
      title: script.title,
      description: script.description,
      tags: script.tags,
      hashtags,
    });
    console.log(`  https://youtu.be/${videoId}`);
    thumbnailSet = await setThumbnail(yt, videoId, thumbFile);
    console.log(`  thumbnail set: ${thumbnailSet}`);
    console.log(`  playlist: ${(await addToPlaylist(yt, slot, videoId)) ?? "not added"}`);
  }

  // A dry run must not look like a produced slot: the workflow's slot picker reads archive/.
  if (dryRun) {
    console.log("9/9 archive skipped (--dry-run)");
    console.log(`\n--- dry run script ---\n${allLines.join("\n")}\n\n${script.title}\n\n${script.description}\n`);
    return;
  }
  console.log("9/9 archive");
  fs.mkdirSync(path.join(ROOT, "archive"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "archive", `${stamp}-${slot}.json`),
    JSON.stringify(
      { slot, style, coins: segments.map((s) => s.coin), metrics: segments.map((s) => s.metrics), script, hashtags, videoId, thumbnailSet, usage },
      null,
      2,
    ),
  );

  history.push({
    at: new Date().toISOString(),
    slot,
    coinIds: segments.map((s) => s.coin.id),
    title: script.title,
    videoId,
    durationSec: totalSec,
  });
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-40), null, 2));

  await notify(
    `✅ ${slot} · ${segments.map((s) => s.coin.symbol).join(" / ")}\n` +
      `${script.title}\n${videoId ? `https://youtu.be/${videoId}` : "(dry run, not uploaded)"}`,
  );

  console.log("\ndone\n");
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${err.message}`);
  await notify(`❌ Crypto shorts run failed\n${err.message}`.slice(0, 900));
  process.exit(1);
});
