import { fetchJson } from "./lib/http.mjs";

const BASE = "https://api.coingecko.com/api/v3";

const cgHeaders = () =>
  process.env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": process.env.COINGECKO_API_KEY } : {};

const cg = (path) => fetchJson(`${BASE}${path}`, { headers: cgHeaders() });

// Since 09-29 keyless CoinGecko answers /coins/markets (and /simple/price) with 403, while
// /global, /search/trending, /coins/list and /coins/{id}/ohlc still work. So only the market rows
// come from CoinPaprika (keyless), re-keyed to CoinGecko ids so trending and candles still line up.
const PAPRIKA = "https://api.coinpaprika.com/v1";
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
let paprikaRows;

async function paprikaMarkets() {
  if (paprikaRows) return paprikaRows;
  const [tickers, cgList] = await Promise.all([
    fetchJson(`${PAPRIKA}/tickers`, { timeoutMs: 60000 }),
    fetchJson(`${BASE}/coins/list`, { headers: cgHeaders(), timeoutMs: 60000 }),
  ]);
  const bySymbol = new Map();
  for (const c of cgList) {
    const k = c.symbol.toLowerCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k).push(c);
  }
  const used = new Set();
  paprikaRows = [];
  for (const t of [...tickers].sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))) {
    const q = t.quotes?.USD;
    const cands = bySymbol.get(t.symbol.toLowerCase()) ?? [];
    const slug = t.id.slice(t.id.indexOf("-") + 1);
    const match =
      cands.find((c) => norm(c.name) === norm(t.name)) ??
      cands.find((c) => c.id === slug) ??
      (cands.length === 1 ? cands[0] : null);
    if (!q || !match || used.has(match.id)) continue;
    used.add(match.id);
    paprikaRows.push({
      id: match.id,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
      image: null, // CoinPaprika logos refuse hotlinking; ensureImage fills it for the picked coins
      current_price: q.price,
      market_cap: q.market_cap,
      market_cap_rank: t.rank,
      total_volume: q.volume_24h,
      price_change_percentage_24h: q.percent_change_24h,
      price_change_percentage_7d_in_currency: q.percent_change_7d,
    });
  }
  return paprikaRows;
}

// Only coins that end up in a video need a logo, so it is looked up per coin (keyless /coins/{id}).
async function ensureImage(coin) {
  if (coin.image) return;
  try {
    const j = await cg(
      `/coins/${coin.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
    );
    coin.image = j.image?.large ?? j.image?.small ?? null;
  } catch {
    // no logo is fine: downloadLogo skips it
  }
}

// CoinGecko first; on 403/429 fall back to CoinPaprika rows (top `limit`, or the given ids).
async function marketRows(query, { ids, limit } = {}) {
  try {
    return await cg(`/coins/markets?${query}`);
  } catch (err) {
    if (!/HTTP (403|429)/.test(err.message)) throw err;
    console.warn(`  CoinGecko markets unavailable (${err.message.split(" from ")[0]}), using CoinPaprika`);
    const rows = await paprikaMarkets();
    return ids ? rows.filter((r) => ids.includes(r.id)) : rows.slice(0, limit);
  }
}

// Pegged or derivative assets: they mirror another coin, so "analysing" them is noise.
const EXCLUDED = new Set([
  "usdt", "usdc", "dai", "fdusd", "usde", "tusd", "busd", "usds", "pyusd", "usd1", "rlusd", "usdd",
  "steth", "wsteth", "weth", "wbtc", "cbbtc", "wbeth", "weeth", "reth", "rseth", "ezeth", "lbtc",
  "susde", "bsc-usd", "solvbtc", "meth", "sfrxeth", "jitosol", "msol", "bnsol", "wbnb", "clbtc",
]);

export async function fetchMarketContext() {
  const [global, markets, trending] = await Promise.all([
    cg("/global"),
    marketRows("vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h", { limit: 100 }),
    cg("/search/trending"),
  ]);

  const g = global.data;
  return {
    global: {
      totalMarketCapUsd: g.total_market_cap.usd,
      marketCapChange24hPct: round(g.market_cap_change_percentage_24h_usd, 2),
      btcDominancePct: round(g.market_cap_percentage.btc, 1),
      ethDominancePct: round(g.market_cap_percentage.eth, 1),
    },
    markets,
    trendingIds: (trending.coins ?? []).map((c) => c.item.id),
  };
}

// Bitcoin and Ether belong to the morning large-cap story, so the other two slots avoid them -
// otherwise two of the three daily videos could be the same asset.
const CORE = new Set(["bitcoin", "ethereum"]);

const marketsByIds = (ids) =>
  marketRows(`vs_currency=usd&ids=${ids.join(",")}&price_change_percentage=24h`, { ids });

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

const byAbsMove = (list) =>
  [...list].sort(
    (a, b) => Math.abs(b.price_change_percentage_24h ?? 0) - Math.abs(a.price_change_percentage_24h ?? 0),
  );
const byVolume = (list) => [...list].sort((a, b) => b.total_volume - a.total_volume);

// Picks `count` distinct candidate coins, best first. A video tells one coin's story, but several
// candidates come back so selectSegments can skip any whose chart history is too thin.
// Micro-caps with a volume spike are where pump-and-dumps live. Featuring one reads as shilling it,
// so no coin under this market cap becomes a video's subject.
const MIN_MCAP = 100_000_000;

export async function pickSubjects(slot, { markets, trendingIds }, excludeIds = [], count = 3) {
  const liquid = markets.filter(
    (c) => !EXCLUDED.has(c.symbol.toLowerCase()) && c.total_volume > 50_000_000 && c.market_cap >= MIN_MCAP,
  );
  const fresh = (list) => list.filter((c) => !excludeIds.includes(c.id));

  let picks = [];

  if (slot === "open") {
    // The one large-cap story of the morning: whichever top-10 coin moved most, Bitcoin included.
    const majors = byAbsMove(liquid.filter((c) => (c.market_cap_rank ?? 999) <= 10));
    picks = dedupeById([...fresh(majors), ...majors]);
  } else if (slot === "mover") {
    const movers = byAbsMove(liquid.filter((c) => !CORE.has(c.id)));
    picks = dedupeById(fresh(movers));
  } else {
    // Trending coins are often outside the top 100 by market cap - that is the
    // whole point of the slot - so their market rows are fetched by id rather
    // than looked up in the top-100 list.
    const ids = trendingIds.filter((id) => !CORE.has(id)).slice(0, 15);
    const rows = ids.length ? await marketsByIds(ids) : [];
    const pool = rows
      .filter((c) => !EXCLUDED.has(c.symbol.toLowerCase()) && c.total_volume > 10_000_000 && c.market_cap >= MIN_MCAP)
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    picks = dedupeById(fresh(pool));
  }

  // Top up from overall volume leaders if a slot came up short (thin trending
  // list, heavy exclusion history) - always return `count` usable candidates.
  if (picks.length < count) {
    const backfill = byVolume(liquid.filter((c) => slot === "open" || !CORE.has(c.id)));
    picks = dedupeById([...picks, ...fresh(backfill), ...backfill]);
  }

  return picks.slice(0, count);
}

export async function fetchCandles(coinId) {
  const raw = await cg(`/coins/${coinId}/ohlc?vs_currency=usd&days=1`);
  return raw
    .filter((r) => r.every((n) => Number.isFinite(n)))
    .map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
}

// CoinGecko returns 4-hour candles for a 7-day OHLC window (vs. 30-min for 1-day).
export async function fetchWeeklyCandles(coinId) {
  const raw = await cg(`/coins/${coinId}/ohlc?vs_currency=usd&days=7`);
  return raw
    .filter((r) => r.every((n) => Number.isFinite(n)))
    .map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
}

export async function fetchWeeklyMarketContext() {
  const [global, markets] = await Promise.all([
    cg("/global"),
    marketRows("vs_currency=usd&order=market_cap_desc&per_page=150&page=1&price_change_percentage=24h,7d", { limit: 150 }),
  ]);
  const g = global.data;
  return {
    global: {
      totalMarketCapUsd: g.total_market_cap.usd,
      marketCapChange24hPct: round(g.market_cap_change_percentage_24h_usd, 2),
      btcDominancePct: round(g.market_cap_percentage.btc, 1),
      ethDominancePct: round(g.market_cap_percentage.eth, 1),
    },
    markets,
  };
}

// Picks `count` coins for the weekly recap: BTC + ETH always anchor it (a
// market recap that never mentions Bitcoin reads as incomplete), the rest are
// the biggest 7-day movers. A higher volume floor than the daily pickers
// keeps thin, easily-manipulated micro-caps out of a "market pulse" video.
export async function pickWeeklyMovers(markets, excludeIds = [], count = 8) {
  const liquid = markets.filter(
    (c) => !EXCLUDED.has(c.symbol.toLowerCase()) && c.total_volume > 50_000_000,
  );
  const fresh = (list) => list.filter((c) => !excludeIds.includes(c.id));

  const btc = markets.find((c) => c.id === "bitcoin");
  const eth = markets.find((c) => c.id === "ethereum");
  const byAbs7d = [...liquid]
    .filter((c) => !CORE.has(c.id))
    .sort(
      (a, b) =>
        Math.abs(b.price_change_percentage_7d_in_currency ?? 0) -
        Math.abs(a.price_change_percentage_7d_in_currency ?? 0),
    );

  const picks = dedupeById([btc, eth, ...fresh(byAbs7d), ...byAbs7d]);
  return picks.slice(0, count);
}

// Same "fetch candidates + candles together, skip anything too thin" pattern
// as selectSegments, but for the weekly 7-day window.
export async function selectWeeklySegments(context, excludeIds = [], count = 8) {
  const candidates = await pickWeeklyMovers(context.markets, excludeIds, count + 4);
  const result = [];
  for (const coin of candidates) {
    if (result.length === count) break;
    const candles = await fetchWeeklyCandles(coin.id);
    if (candles.length >= 10) {
      result.push({ coin, candles });
    } else {
      console.log(`  ${coin.id} has only ${candles.length} weekly candles, skipping`);
    }
  }
  for (const r of result) await ensureImage(r.coin);
  return result.slice(0, count);
}

// Fetches candidates and their candles together, skipping any coin whose
// history is too thin to chart, until `count` usable coins are assembled.
export async function selectSegments(slot, context, excludeIds = [], count = 3) {
  const candidates = await pickSubjects(slot, context, excludeIds, count + 3);
  const result = [];
  for (const coin of candidates) {
    if (result.length === count) break;
    const candles = await fetchCandles(coin.id);
    if (candles.length >= 16) {
      result.push({ coin, candles });
    } else {
      console.log(`  ${coin.id} has only ${candles.length} candles, skipping`);
    }
  }
  if (result.length < count) {
    for (const id of ["bitcoin", "ethereum", "solana", "ripple"]) {
      if (result.length === count) break;
      if (result.some((r) => r.coin.id === id)) continue;
      const coin = context.markets.find((c) => c.id === id);
      if (!coin) continue;
      const candles = await fetchCandles(id);
      if (candles.length >= 16) result.push({ coin, candles });
    }
  }
  for (const r of result) await ensureImage(r.coin);
  return result.slice(0, count);
}

const round = (n, d) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
