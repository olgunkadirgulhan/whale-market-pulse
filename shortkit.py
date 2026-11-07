"""shortkit — basit dikey Shorts motoru (2026-11-07; Odd Emoji'deki emoji.py'den sadeleştirildi).
Ortak: emoji (Noto Color Emoji, SIL OFL), Luckiest Guy yazısı (Apache 2.0), kodla ses, ffmpeg render, kayıt CSV,
Gemini JSON çağrısı, YouTube yükleme. Aynı dosya whale-market-pulse (Would You Rather) ve maya-builds-cozy (Evolution of)
repolarında kullanılır.
"""
import csv, json, os, re, shutil, subprocess, time, wave
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FD = HERE / 'fonts' / 'kit'
W, H, FPS, SR = 1080, 1920, 30, 44100
INK, WHITE = (34, 24, 60), (255, 255, 255)


@lru_cache(None)
def emoji_img(ch, size):
    f = ImageFont.truetype(str(FD / 'NotoColorEmoji.ttf'), 109)
    im = Image.new('RGBA', (200, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((100, 80), ch, font=f, embedded_color=True, anchor='mm')
    bb = im.getbbox()
    if not bb: raise ValueError(f'emoji çizilemedi: {ch!r}')
    im = im.crop(bb); s = size / max(im.size)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


def emoji_ok(ch):
    try: return bool(emoji_img(ch, 60).getbbox())
    except Exception: return False


@lru_cache(None)
def font(sz): return ImageFont.truetype(str(FD / 'LuckiestGuy-Regular.ttf'), sz)


def text(d, xy, s, sz, fill=WHITE, stroke=INK, anchor='mm', max_w=None):
    while max_w and sz > 30 and d.textlength(s, font=font(sz)) > max_w: sz -= 4
    d.text(xy, s, font=font(sz), fill=fill, anchor=anchor, stroke_width=max(3, sz // 12), stroke_fill=stroke)


def wrap(d, s, sz, max_w):
    words, lines, cur = s.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=font(sz)) <= max_w: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines


def text_block(d, cx, cy, s, sz, max_w, fill=WHITE, max_lines=3):
    while True:
        lines = wrap(d, s, sz, max_w)
        if len(lines) <= max_lines or sz <= 34: break
        sz -= 4
    lh = sz * 1.12
    for i, ln in enumerate(lines):
        text(d, (cx, cy + (i - (len(lines) - 1) / 2) * lh), ln, sz, fill=fill)


@lru_cache(8)
def gradient(c1, c2, stripes=True):
    a = np.linspace(0, 1, H)[:, None, None]
    g = (np.array(c1) * (1 - a) + np.array(c2) * a) * np.ones((1, W, 1))
    im = Image.fromarray(g.astype(np.uint8)).convert('RGBA')
    if stripes:
        d = ImageDraw.Draw(im)
        for k in range(-H, W, 90): d.line([(k, 0), (k + H, H)], fill=(255, 255, 255, 16), width=26)
    return im


def ease(u): return 1 - (1 - max(0.0, min(1.0, u))) ** 3


def tone(f, dur, amp=0.3, decay=6.0):
    t = np.arange(int(SR * dur)) / SR
    return amp * np.sin(2 * np.pi * f * t) * np.exp(-decay * t)


def write_audio(path, total, seed, events):
    """events: [(t, kind)] kind ∈ new, tick, ding, end. Hafif pentatonik arpej + efektler."""
    n = int(SR * total); mix = np.zeros(n); rnd = np.random.default_rng(seed)
    def place(x, t0):
        i0 = int(t0 * SR); mix[i0:i0 + len(x)] += x[:max(0, n - i0)]
    notes = [523.25, 587.33, 659.25, 783.99, 880.0]
    for k in range(int(total / 0.25)): place(tone(notes[rnd.integers(len(notes))] / 2, 0.24, 0.05, 9), k * 0.25)
    for t, kind in events:
        if kind == 'new': place(tone(220, 0.25, 0.25, 14) + tone(330, 0.25, 0.15, 14), t)
        elif kind == 'tick': place(tone(1800, 0.04, 0.2, 60), t)
        elif kind == 'ding': place(tone(880, 0.6, 0.33, 5) + tone(1320, 0.6, 0.22, 5), t)
        elif kind == 'end': place(tone(660, 0.5, 0.3, 4) + tone(990, 0.5, 0.2, 4), t)
    mix = np.clip(mix / max(1.0, np.abs(mix).max() / 0.8), -1, 1)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype(np.int16).tobytes())


def ffmpeg():
    exe = shutil.which('ffmpeg')
    if exe: return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def render(frame_fn, total, events, seed, mp4):
    mp4 = Path(mp4); mp4.parent.mkdir(parents=True, exist_ok=True)
    wav = mp4.with_suffix('.wav'); write_audio(wav, total, seed, events)
    cmd = [ffmpeg(), '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
           '-i', str(wav), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
           '-shortest', '-movflags', '+faststart', str(mp4)]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE); first = None
    for i in range(int(total * FPS)):
        T = i / FPS; f = frame_fn(T)
        if T > total - 0.4:   # kesintisiz döngü
            first = first or frame_fn(0.0)
            f = Image.blend(f, first, min(1.0, (T - (total - 0.4)) / 0.4))
        pr.stdin.write(f.convert('RGB').tobytes())
    pr.stdin.close(); pr.wait(); wav.unlink(missing_ok=True)
    if pr.returncode: raise RuntimeError('ffmpeg hata')
    return mp4


# ---------------------------------------------------------------- kayıt
def tkey(t):
    t = re.sub(r'#\w+', ' ', t.lower())
    return ' '.join(re.sub(r'[^\w ]', ' ', t).split()) + '|' + ''.join(ch for ch in t if ord(ch) > 0x2100)


def rows(log):
    return list(csv.DictReader(open(log, encoding='utf-8'))) if Path(log).exists() else []


def record(log, tid, vid, title, publish_at):
    new = not Path(log).exists()
    with open(log, 'a', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['topic_id', 'date_utc', 'video_id', 'title', 'publish_at'])
        if new: w.writeheader()
        w.writerow(dict(topic_id=tid, date_utc=datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M'), video_id=vid, title=title,
                        publish_at=publish_at))


def today_count(log):
    d = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    return sum(r['date_utc'].startswith(d) for r in rows(log))


def publish_at(slots, n):
    hh, mm = map(int, slots[min(n, len(slots) - 1)].split(':'))
    now = datetime.now(timezone.utc); t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if t < now + timedelta(minutes=30): t = now + timedelta(minutes=40)
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


# ---------------------------------------------------------------- Gemini
def gemini_json(prompt, temp=0.9):
    import requests
    key = os.environ['GEMINI_API_KEY']; last = None
    for model in ('gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest'):
        for attempt in range(3):
            try:
                r = requests.post(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
                                  params={'key': key}, timeout=180,
                                  json={'contents': [{'parts': [{'text': prompt}]}],
                                        'generationConfig': {'temperature': temp, 'responseMimeType': 'application/json'}})
                if r.status_code == 429: time.sleep(20 * (attempt + 1)); continue
                r.raise_for_status()
                return json.loads(r.json()['candidates'][0]['content']['parts'][0]['text'])
            except Exception as e:  # noqa: BLE001
                last = e; time.sleep(5)
    raise SystemExit(f'Gemini başarısız: {last}')


# ---------------------------------------------------------------- YouTube
def yt_client():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    g = lambda *ks: next((os.environ[k] for k in ks if os.environ.get(k)), None)
    creds = Credentials(None, refresh_token=g('YT_REFRESH_TOKEN', 'YOUTUBE_REFRESH_TOKEN'),
                        client_id=g('YT_CLIENT_ID', 'YOUTUBE_CLIENT_ID'), client_secret=g('YT_CLIENT_SECRET', 'YOUTUBE_CLIENT_SECRET'),
                        token_uri='https://oauth2.googleapis.com/token')
    return build('youtube', 'v3', credentials=creds, cache_discovery=False)


def upload(mp4, title, desc, tags, pa, category='24'):
    from googleapiclient.http import MediaFileUpload
    yt = yt_client()
    ch = yt.channels().list(part='id,snippet', mine=True).execute()['items'][0]
    want = os.environ.get('YT_CHANNEL_ID')
    if want and ch['id'] != want: raise SystemExit(f"yanlış kanal: {ch['snippet']['title']}")
    print('kanal:', ch['snippet']['title'], flush=True)
    body = {'snippet': {'title': title[:100], 'description': desc[:4900], 'tags': tags, 'categoryId': category,
                        'defaultLanguage': 'en', 'defaultAudioLanguage': 'en'},
            'status': {'privacyStatus': 'private', 'publishAt': pa, 'selfDeclaredMadeForKids': False}}
    return yt.videos().insert(part='snippet,status', body=body, media_body=MediaFileUpload(str(mp4), resumable=True)).execute()['id']
