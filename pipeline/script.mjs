import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { generateStructured } from "./lib/llm.mjs";

// One video = one coin's story (25-35 s). Short, single-subject Shorts hold viewers far better than
// a three-coin data readout, and a story built from that day's data and headlines is what keeps the
// channel clear of YouTube's "inauthentic / mass-produced content" rule.

// Advice, hype and promotion never reach the voiceover or the title. A script that trips one of
// these fails validation and the LLM is asked again with the reason (see lib/llm.mjs).
const BANNED = [
  [/\b(buy|sell)\b(?!ers|-off|ing pressure| pressure| wall| side| orders?)/i, "buy/sell wording"],
  [/\bshould (you )?(buy|sell|hold|get in|get out)\b|\bhold or fold\b|\bprice target\b|\bwill (hit|reach|go to|explode)\b/i, "advice or prediction"],
  [/\b(moon|mooning|explode|exploding|parabolic|100x|1000x|easy money|financial freedom|get rich|guarantee[ds]?|don'?t miss|too late|last chance|to the moon)\b|🚀|🌕|💎|🤑/i, "hype word"],
  [/\b(referral|promo code|sign ?up|use my link|affiliate)\b/i, "promotion"],
];
const clean = (s) => BANNED.every(([re]) => !re.test(s));
const why = (s) => BANNED.filter(([re]) => re.test(s)).map(([, m]) => m).join(", ");
const safeText = (max) =>
  z.string().max(max).refine(clean, { error: (i) => `contains ${why(String(i.input))}; rewrite it neutrally` });

const ScriptSchema = z.object({
  spoken_hook: safeText(110),
  hook: z.string().max(60),
  lines: z.array(safeText(160)).min(3).max(4),
  takeaway: z.string().max(70),
  cta: safeText(140),
  title: safeText(100),
  summary: safeText(320),
  headline_used: z.number().int().min(-1).max(2),
  tags: z.array(z.string()).min(5).max(16),
});

const SLOT_BRIEF = {
  open: "LARGE-CAP STORY: the top-10 coin that moved most in the last 24 hours. The audience knows this coin; tell them what actually happened today.",
  mover: "BIGGEST MOVE: the liquid coin with one of the largest 24h moves. Lead with the size of the move.",
  trending: "WHY IT'S TRENDING: a coin people are searching for right now. Lead with what makes it notable today.",
};

const SYSTEM = `You write a 25-35 second vertical YouTube Short for "Whale Market Pulse", an English crypto channel about where the big money moved today. The whole video is about ONE coin.

HARD RULES
- Use ONLY numbers from the supplied JSON. Never invent or extrapolate; in spoken text you may round as described below. Skip null fields.
- Describe what happened. Never advise and never predict: no "buy", "sell", "target", "will reach", no portfolio talk.
- Call levels what they are: "the four-hour high", "the 24-hour low". Not "key support" or "key resistance".
- Banned: moon, explode, parabolic, guaranteed, 100x, easy money, financial freedom, don't miss, too late, hold or fold.
- Headlines: "headlines" lists recent news that names this coin. You may use AT MOST one, attributed to its source ("CoinDesk reports..."), paraphrased faithfully. Never say the headline caused the price move - write "comes as" or "alongside", never "because" or "due to". If none is relevant, use none and set headline_used to -1; otherwise set it to that headline's index.
- turnover_24h_pct is 24h volume as a percent of market cap: how much of the coin changed hands. It is the channel's signature stat ("the big money"); use it when it is notable (above ~15%) or clearly unusual.
- No markdown, emoji, hashtags or stage directions in spoken text.

SPOKEN TEXT (also shown word for word as captions, so write numbers as digits: "$94", "almost 19%", "RSI 46", "the 4-hour high")
- Say numbers the way a person would: round naturally in speech and signal it ("almost 19%" for 18.63%, "about $94" for $94.41, "$97 million" for $97.27M). Exact figures are already on screen.
- spoken_hook: the first thing the viewer hears. 6 to 14 words, one sentence. It must open a curiosity gap - a contrast, a question or a surprising detail - that the next lines resolve. Do NOT just state the price move. Good: "Quant ripped almost 19% today, but look where it's sitting now." / "Everyone is searching this coin today, and the chart shows why." / "Bitcoin barely moved, yet a fifth of Solana changed hands." No greeting, no channel name, no "in this video".
- lines: 3 sentences, 10 to 18 words each, that pay off the hook in order: (1) the move itself with price and 24h change, (2) the one chart detail that matters (where it sits versus its 24h range or 4-hour high/low, RSI zone, trend), (3) the context: the headline if used, else the turnover / volume angle.
- Plain words. No "massive", "huge", "insane", "skyrocket", "crazy".
- cta: one sentence that asks the viewer a genuine opinion question about this move (not advice, e.g. "Real breakout or a bull trap? Tell me below.") and then asks them to follow for the next move. Max 140 characters.

ON-SCREEN / METADATA
- hook: opening card text, max 45 characters, no digits and no number words, no final period. The coin's % change is shown right under it. Good: "Quant Just Woke Up", "Nobody Saw This Coming".
- takeaway: closing card headline, max 55 characters: the insight in one line, not a repeat of the price move (e.g. "Big day, but it's already off the highs").
- title: max 70 characters plus " #Shorts". Earns the click with the story, not a data list: the coin's name or symbol, the move, and a curiosity angle. At most one emoji, never 🚀 🌕 💎 🤑 (they read as hype). Every number from the input. Never reuse the structure of a title in "recent_titles". Never use "Market Brief", "Price Analysis", "Prices, Ranges and RSI", "Trading Activity", "Movers of the Day". Write the title in the "title_style" given in the input (it rotates so the channel never looks templated); the classic "X jumps Y% to $Z" pattern is only allowed when title_style says so.
- summary: 1-2 plain sentences for the top of the description saying what happened to this coin today, with exact figures as digits ("+18.63% to $94.41").
- tags: 8 to 14 lowercase search phrases, 2 to 25 characters, no "#". Include the coin's name and symbol.`;

// Title angles rotate per video: the July 2026 YouTube rules treat channels whose titles all share one
// pattern ("X jumps Y% to $Z") as templated / mass-produced content.
const TITLE_STYLES = [
  "question: ask what is behind the move (e.g. 'What just happened to <coin>?')",
  "contrast: the coin vs the rest of the market (e.g. '<coin> green while everything bleeds')",
  "number-first: lead with the single most surprising number from the input",
  "plain-English: explain the move like to a friend, no ticker jargon",
  "story: the coin's day as a mini story with a turn ('<coin> fell, then this happened')",
  "classic: name, move and price (the 'X jumps Y% to $Z' pattern)",
];

function pickTitleStyle(recentTitles = []) {
  const classicRecent = recentTitles.slice(-3).some((t) => /\b(jumps|climbs|gains|drops|falls|slides)\b.*\d+(\.\d+)?%/i.test(t));
  const pool = classicRecent ? TITLE_STYLES.filter((s) => !s.startsWith("classic")) : TITLE_STYLES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function generateScript({ slot, segments, global, avoidTitles, headlines = [] }) {
  const { coin, metrics, sentiment } = segments[0];
  const turnover = metrics.marketCapUsd ? Number(((metrics.volume24hUsd / metrics.marketCapUsd) * 100).toFixed(1)) : null;
  const payload = {
    format: SLOT_BRIEF[slot],
    market: global,
    coin: {
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      rank: metrics.marketCapRank,
      computed_sentiment: sentiment,
      metrics: {
        price_usd: metrics.priceText,
        change_24h_pct: metrics.change24hPct,
        high_24h: metrics.high24hText,
        low_24h: metrics.low24hText,
        last_4h_high: metrics.resistanceText,
        last_4h_low: metrics.supportText,
        pct_below_4h_high: metrics.distToResistancePct,
        pct_above_4h_low: metrics.distToSupportPct,
        position_in_24h_range_pct: metrics.rangePositionPct,
        rsi_14: metrics.rsi14,
        rsi_zone: metrics.rsiZone,
        trading_above_sma20: metrics.aboveSma20,
        volatility_pct: metrics.volatility24hPct,
        volume_24h_usd: metrics.volume24hText,
        market_cap_usd: metrics.marketCapText,
        turnover_24h_pct: turnover,
        trend: metrics.trend,
      },
    },
    headlines: headlines.map((h, i) => ({ index: i, source: h.source, title: h.title, age_hours: h.age_hours })),
    recent_titles: avoidTitles,
    title_style: pickTitleStyle(avoidTitles),
  };

  // Free LLMs first (Gemini -> Groq); the original Claude call below is only a last resort.
  const { out, usage, provider } = await generateStructured({
    system: SYSTEM,
    user: JSON.stringify(payload),
    schema: ScriptSchema,
    name: "video_script",
    claude: () => viaClaude(payload),
  });
  console.log(`  script by ${provider}`);
  return { script: normalize(out, coin, headlines), usage };
}

async function viaClaude(payload) {
  const client = new Anthropic();
  const model = process.env.CLAUDE_MODEL || "claude-opus-5";

  // No prompt caching: at 3 calls/day the 5-minute cache never hits, and a cache
  // write costs 1.25x. Caching here would raise the bill, not lower it.
  //
  // output_format (the schema) and output_config (effort etc.) are separate
  // top-level request fields in this SDK version - not one nested under the
  // other. beta.messages.parse() only attempts to parse the response when it
  // finds a `.parse` method on `params.output_format`; nesting the schema
  // under output_config silently skips parsing (parsed_output stays null even
  // though the model answered normally).
  const request = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    output_format: betaZodOutputFormat(ScriptSchema, "video_script"),
  };

  // effort is rejected by Haiku 4.5; it is the cost lever on the Opus/Sonnet family.
  if (!model.includes("haiku")) request.output_config = { effort: "low" };

  const response = await client.beta.messages.parse(request);

  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  const out = response.parsed_output;
  if (!out) {
    const rawText = response.content.find((b) => b.type === "text")?.text ?? "(no text block)";
    throw new Error(
      `Model returned no parseable script (stop_reason=${response.stop_reason}): ${rawText.slice(0, 500)}`,
    );
  }

  return { out, usage: response.usage };
}

const DISCLAIMER =
  "This Short is market commentary built from public price data. It is not financial advice. Do your own research.";

function normalize(out, coin, headlines) {
  const lines = out.lines.map((l) => l.trim()).filter(Boolean).slice(0, 3);
  if (lines.length < 3) throw new Error(`Script has ${lines.length} usable lines, need 3`);

  const symbol = coin.symbol.toUpperCase();
  let title = out.title.trim().replace(/\s*#shorts\s*$/i, "");
  if (!title.toUpperCase().includes(symbol) && !title.toLowerCase().includes(coin.name.toLowerCase())) {
    title = `${coin.name} (${symbol}): ${title}`;
  }
  title = `${title.slice(0, 90).trim()} #Shorts`;

  // Sources and the disclaimer are written by code, never by the model, so a link or a legal line
  // can't be invented or dropped.
  const used = headlines[out.headline_used] ?? null;
  const sources = ["Market data: CoinGecko"];
  if (used) sources.push(`News: "${used.title}" (${used.source}) ${used.link}`);
  const description = [
    out.summary.trim(),
    "",
    sources.join("\n"),
    "",
    DISCLAIMER,
    "",
    "Whale Market Pulse: where the big money moved in crypto today. New Shorts every day, weekly recap on Sundays and Wednesdays.",
  ].join("\n");

  return {
    spokenHook: out.spoken_hook.trim(),
    hook: out.hook.trim().slice(0, 60),
    segmentLines: [lines],
    takeaway: out.takeaway.trim().slice(0, 70),
    cta: out.cta.trim().slice(0, 140),
    title,
    description,
    headline: used,
    tags: sanitizeTags(out.tags, [coin]),
  };
}

function sanitizeTags(raw, coins) {
  const seen = new Set();
  const tags = [];
  let chars = 0;
  const baseline = coins.flatMap((c) => [c.name.toLowerCase(), c.symbol.toLowerCase()]);
  for (const candidate of [...raw, ...baseline, "crypto news", "whale market pulse"]) {
    const tag = String(candidate).replace(/#/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (tag.length < 2 || tag.length > 25) continue;
    if (seen.has(tag)) continue;
    // YouTube caps the tags field at 500 characters total, comma included.
    if (chars + tag.length + 1 > 450) break;
    seen.add(tag);
    tags.push(tag);
    chars += tag.length + 1;
  }
  return tags;
}
