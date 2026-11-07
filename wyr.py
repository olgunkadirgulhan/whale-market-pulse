"""Would You Rather Shorts (2026-11-07; Whale Market Pulse kanalının yeni konsepti).
Trend taraması: "would you rather" son 30 gün Shorts medyanı 863K, 38 kanal 100K+ → yorum çeken soru formatı.
Her video 5 soru (A kırmızı / B mavi, emoji + kısa metin, 4 sn sayaç), sonunda "cevaplarını yaz: ABBAB".
Uydurma oran/istatistik YOK (dürüst). Sorular Gemini'den gelir, güvenlik geçişinden geçer → state/wyr_bank.json.
Seri numarası (#N) abone getirsin diye başlıkta.
    python wyr.py --dry-run          # render
    python wyr.py --auto             # günlük sayı dolana kadar 1 Short üret + yükle
"""
import json, os, random, re, sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import ImageDraw
import shortkit as K

HERE = Path(__file__).resolve().parent
BANK = HERE / 'state' / 'wyr_bank.json'
LOG = HERE / 'state' / 'wyr_published.csv'
OUT = HERE / 'out' / 'wyr'
DRY = '--dry-run' in sys.argv
N_Q, QT, REV = 5, 4.2, 0.0
INTRO, OUTRO = 1.4, 3.0
RED, BLUE = (235, 70, 80), (60, 120, 235)
BANNED = re.compile(r'\b(kill|die|dead|death|suicide|gun|drug|alcohol|beer|sex|naked|kiss|bomb|war|blood|hate|religio|god|politic|'
                    r'president|trump|biden|racist|fat|ugly|stupid|poop|pee|vomit)\w*', re.I)


def load_bank():
    return json.loads(BANK.read_text(encoding='utf-8')) if BANK.exists() else []


def used_ids():
    return {q for r in K.rows(LOG) for q in r['topic_id'].split(':', 1)[-1].split('|')}


def refill(min_unused=40, n=40):
    bank = load_bank(); used = used_ids()
    unused = [q for q in bank if q['id'] not in used]
    if len(unused) >= min_unused or not os.environ.get('GEMINI_API_KEY'):
        return bank
    seen = {q['a'].lower() + '|' + q['b'].lower() for q in bank}
    prompt = f"""Write {n} NEW, fun, family-friendly "Would you rather" questions for a YouTube Shorts channel (13+ audience).
Topics: food, superpowers, travel, school, games, animals, money (light), tech, seasons, everyday dilemmas. Mix easy and hard choices.
Each option max 34 characters, no "would you rather" prefix. Each option gets ONE single emoji (no flags, no skin tones, no ZWJ sequences).
No violence, death, romance, alcohol, drugs, religion, politics, bodily functions, insults, real people or brands.
Do NOT repeat these: {json.dumps(sorted(seen)[:300], ensure_ascii=False)}
Return JSON list of {{"a": "...", "ea": "emoji", "b": "...", "eb": "emoji"}}."""
    try:
        res = K.gemini_json(prompt)
    except SystemExit as e:
        print(e); return bank
    nid = max([int(q['id'][1:]) for q in bank] + [0])
    for q in res if isinstance(res, list) else []:
        try:
            a, b, ea, eb = str(q['a']).strip(), str(q['b']).strip(), str(q['ea']).strip(), str(q['eb']).strip()
        except Exception:  # noqa: BLE001
            continue
        k = a.lower() + '|' + b.lower()
        if k in seen or not (3 <= len(a) <= 40 and 3 <= len(b) <= 40) or BANNED.search(a + ' ' + b): continue
        if not (K.emoji_ok(ea) and K.emoji_ok(eb)) or len(ea) > 2 or len(eb) > 2: continue
        nid += 1; bank.append(dict(id=f'q{nid}', a=a, ea=ea, b=b, eb=eb)); seen.add(k)
    BANK.parent.mkdir(parents=True, exist_ok=True)
    BANK.write_text(json.dumps(bank, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'banka: {len(bank)} soru', flush=True)
    return bank


def frame_fn(p):
    qs = p['qs']; total = INTRO + N_Q * QT + OUTRO

    def f(T):
        img = K.gradient((40, 30, 80), (20, 15, 45), False).copy(); d = ImageDraw.Draw(img)
        if T < INTRO:
            u = K.ease(T / 0.5)
            K.text(d, (K.W / 2, 760), 'WOULD YOU', int(130 * u) + 1)
            K.text(d, (K.W / 2, 900), 'RATHER...', int(150 * u) + 1, fill=(255, 220, 60))
            K.text(d, (K.W / 2, 1060), f"5 QUESTIONS · #{p['n']}", int(64 * u) + 1)
            return img
        if T >= INTRO + N_Q * QT:
            u = K.ease((T - INTRO - N_Q * QT) / 0.5)
            K.text(d, (K.W / 2, 700), 'COMMENT YOUR', int(100 * u) + 1)
            K.text(d, (K.W / 2, 830), 'ANSWERS!', int(130 * u) + 1, fill=(255, 220, 60))
            K.text(d, (K.W / 2, 1000), 'LIKE: ' + p['example'], int(80 * u) + 1)
            K.text(d, (K.W / 2, 1160), f"PART {p['n'] + 1} TOMORROW", int(60 * u) + 1)
            return img
        i = int((T - INTRO) // QT); lt = T - INTRO - i * QT; q = qs[i]; pop = K.ease(lt / 0.35)
        K.text(d, (K.W / 2, 150), f'QUESTION {i + 1}/{N_Q}', 60)
        for k, (col, label, txt, em, cy) in enumerate(((RED, 'A', q['a'], q['ea'], 640), (BLUE, 'B', q['b'], q['eb'], 1300))):
            y0, y1 = cy - 300, cy + 300
            d.rounded_rectangle([60, y0, K.W - 60, y1], radius=48, fill=col + (255,))
            e = K.emoji_img(em, int(230 * pop) + 1); img.alpha_composite(e, (int(K.W / 2 - e.width / 2), int(cy - 150 - e.height / 2)))
            K.text_block(d, K.W / 2, cy + 120, txt.upper(), 76, K.W - 200)
            K.text(d, (120, y0 + 70), label, 80)
        d.ellipse([K.W / 2 - 90, 880, K.W / 2 + 90, 1060], fill=(255, 220, 60))
        K.text(d, (K.W / 2, 970), 'OR', 72, fill=(34, 24, 60), stroke=(255, 255, 255))
        frac = max(0.0, 1 - lt / (QT - 0.2))
        d.rounded_rectangle([90, 1690, K.W - 90, 1736], radius=23, fill=(255, 255, 255, 120))
        d.rounded_rectangle([90, 1690, 90 + max(46, (K.W - 180) * frac), 1736], radius=23, fill=(255, 220, 60))
        return img
    events = [(INTRO + i * QT, 'new') for i in range(N_Q)] + [(INTRO + i * QT + s, 'tick') for i in range(N_Q) for s in (1, 2, 3)]
    events += [(INTRO + N_Q * QT, 'end')]
    return f, total, events


TITLES = ['Would You Rather? {ea} or {eb} 🤔 #{n}', 'Would You Rather: {a}? 🤔 (Part {n})', 'Hard Choices: {ea} vs {eb} 😳 Would You Rather #{n}',
          'Would You Rather... {ea} {eb} 5 Questions #{n}', 'Pick One! {ea} or {eb}? Would You Rather #{n}']


def main():
    a = sys.argv[1:]
    if '--auto' in a and K.today_count(LOG) >= int(os.environ.get('PER_DAY') or 3):
        print('bugünkü sayı doldu'); return
    bank = refill()
    used = used_ids(); pool = [q for q in bank if q['id'] not in used]
    if len(pool) < N_Q:
        raise SystemExit('soru bankası boş (GEMINI_API_KEY?)')
    rnd = random.Random(); qs = rnd.sample(pool, N_Q)
    n = len(K.rows(LOG)) + 1
    p = dict(qs=qs, n=n, example=''.join(rnd.choice('AB') for _ in range(N_Q)), seed=rnd.randrange(10 ** 6))
    seen = {K.tkey(r['title']) for r in K.rows(LOG)}
    opts = [t.format(a=qs[0]['a'], ea=qs[0]['ea'], eb=qs[0]['eb'], n=n) for t in TITLES]; rnd.shuffle(opts)
    title = next(o for o in opts if K.tkey(o) not in seen)
    desc = ('Would you rather...?\n\n' + '\n'.join(f"{i + 1}. {q['ea']} {q['a']}  OR  {q['eb']} {q['b']}" for i, q in enumerate(qs))
            + '\n\nComment your 5 answers (like ABBAB)! New questions every day 👇\n\n'
            'Emoji: Noto Color Emoji by Google (SIL Open Font License).\n\n#shorts #wouldyourather #choices #fun #quiz')
    tags = ['would you rather', 'would you rather questions', 'this or that', 'hard choices', 'pick one', 'quiz', 'fun', 'shorts']
    f, total, events = frame_fn(p)
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d_%H%M%S')
    print(f'[wyr] #{n} {title}', flush=True)
    mp4 = K.render(f, total, events, p['seed'], OUT / f'wyr_{stamp}.mp4')
    if DRY:
        print('  [dry-run]', mp4); return
    pa = K.publish_at(['15:30', '18:30', '21:00'], K.today_count(LOG))
    vid = K.upload(mp4, title + ' #shorts', desc, tags, pa, category='24')
    K.record(LOG, 'wyr:' + '|'.join(q['id'] for q in qs), vid, title, pa)
    print(f'  ✓ https://youtu.be/{vid} ({pa})')


if __name__ == '__main__':
    main()
