import fs from "node:fs";
import { google } from "googleapis";

export function youtubeClient() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    throw new Error("Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN");
  }
  const auth = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth });
}

const toHashtag = (s) =>
  "#" + s.replace(/[^a-zA-Z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 24);

// Hashtags come from a fixed, on-topic list plus the coins in the video. We do NOT copy tags from
// other creators' videos: those can carry channel names or unrelated tags (misleading metadata / spam policy).
const SAFE_TAGS = ["crypto", "cryptonews", "altcoins", "bitcoin", "cryptomarket", "Shorts"];

export async function discoverTrendingHashtags(_yt, coins) {
  return dedupeHashtags([...coins.flatMap((c) => [c.name, c.symbol]), ...SAFE_TAGS]);
}

// YouTube ignores every hashtag in a description once there are more than 15,
// and only surfaces the first three above the title. Stay well under.
function dedupeHashtags(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const tag = item.startsWith("#") ? item : toHashtag(item);
    const key = tag.toLowerCase();
    if (tag.length < 4 || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}

// YouTube rejects the whole upload (invalidTitle / invalidDescription) if any of these contain < or >
const clean = (s) => String(s).replace(/->/g, "→").replace(/[<>]/g, "");

export async function uploadVideo(yt, { file, title, description, tags, hashtags }) {
  const safeTitle = clean(title).slice(0, 100);
  const body = clean(`${description}\n\n${hashtags.join(" ")}`).slice(0, 4900);
  tags = tags?.map(clean);

  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: safeTitle,
        description: body,
        tags,
        categoryId: process.env.YOUTUBE_CATEGORY_ID || "28",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: {
        privacyStatus: process.env.YOUTUBE_PRIVACY || "unlisted",
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: fs.createReadStream(file) },
  });

  if (!res.data.id) throw new Error("YouTube accepted the upload but returned no video id");
  return res.data.id;
}

// One playlist per format, so a viewer who liked one story gets the next one of the same kind
// (session time is what YouTube rewards). Ids are cached in state/ once created.
const PLAYLISTS_FILE = "state/playlists.json";
export const PLAYLISTS = {
  open: ["Big Cap Moves", "The biggest move among the top-10 cryptocurrencies each day, explained in 30 seconds."],
  mover: ["Biggest Crypto Movers Today", "The day's biggest crypto move: what happened and what the chart shows."],
  trending: ["Why It's Trending", "The coin everyone is searching for today, and the data behind the attention."],
  weekly: ["Weekly Market Pulse", "Twice-weekly crypto recap: what moved, what didn't, and where the money went."],
};

export async function ensurePlaylist(yt, key) {
  const cache = fs.existsSync(PLAYLISTS_FILE) ? JSON.parse(fs.readFileSync(PLAYLISTS_FILE, "utf8")) : {};
  if (cache[key]) return cache[key];
  const [title, description] = PLAYLISTS[key];
  const mine = await yt.playlists.list({ part: ["snippet"], mine: true, maxResults: 50 });
  let id = (mine.data.items ?? []).find((p) => p.snippet?.title === title)?.id;
  if (!id) {
    const res = await yt.playlists.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description: `${description} Not financial advice.`, defaultLanguage: "en" },
        status: { privacyStatus: "public" },
      },
    });
    id = res.data.id;
  }
  cache[key] = id;
  fs.mkdirSync("state", { recursive: true });
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(cache, null, 2));
  return id;
}

// A playlist failure never fails the run: the video is already public.
export async function addToPlaylist(yt, key, videoId) {
  try {
    const playlistId = await ensurePlaylist(yt, key);
    await yt.playlistItems.insert({
      part: ["snippet"],
      requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
    });
    return playlistId;
  } catch (err) {
    console.warn(`  playlist add failed: ${err.message}`);
    return null;
  }
}

// Custom thumbnails require the channel to be phone-verified - YouTube rejects
// the call otherwise. That's a channel-level setting we can't fix here, so a
// failure here is a warning, not a fatal error: the video itself already uploaded.
export async function setThumbnail(yt, videoId, imagePath) {
  try {
    await yt.thumbnails.set({
      videoId,
      media: { mimeType: "image/png", body: fs.createReadStream(imagePath) },
    });
    return true;
  } catch (err) {
    console.warn(
      `  thumbnail upload failed (channel likely needs phone verification at youtube.com/verify): ${err.message}`,
    );
    return false;
  }
}
