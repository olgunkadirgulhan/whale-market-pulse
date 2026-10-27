"""Kokoro (Apache-2.0, ücretsiz, ticari kullanım serbest) ile satırları seslendirir.
Kullanım: python3 pipeline/kokoro_say.py jobs.json   ·   jobs.json = {"voice": "af_heart", "speed": 1.06, "lines": [[metin, çıktı.wav], ...]}
Model bir kez yüklenir; başarısız satırın dosyası yazılmaz (Node tarafı Piper'a düşer)."""
import json, sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

job = json.load(open(sys.argv[1]))
voice = job.get("voice") or "af_heart"
pipe = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
for text, out in job["lines"]:
    try:
        chunks = [a.numpy() if hasattr(a, "numpy") else np.asarray(a) for _, _, a in pipe(text, voice=voice, speed=float(job.get("speed", 1.0)))]
        if not chunks:
            raise RuntimeError("no audio")
        sf.write(out, np.concatenate(chunks), 24000)
    except Exception as e:  # noqa: BLE001
        print(f"kokoro failed: {out}: {e}", file=sys.stderr)
