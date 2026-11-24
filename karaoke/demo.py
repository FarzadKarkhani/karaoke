"""A ready-made demo project (synthesised backing track + Persian/Turkish/English lyrics).

Lets people explore styling and export without uploading a song or waiting for the AI models.
"""
from __future__ import annotations

import json
import time
import uuid

import numpy as np
import soundfile as sf

from . import audio
from .jobs import JobStore

SR = 44100
DURATION = 64.0

# (start, end, words) – timings are laid out proportionally to word length inside each line
_SECTIONS = [
    (8.0, ["من عاشق تو هستم ای نازنین", "در دل شب ستاره‌ ها می‌درخشند", "بیا با من بمان تا صبح", "که دنیا بی تو هیچ است و پوچ"], 4.4),
    (34.0, ["Gözlerinde kayboldum bu gece", "İstanbul'un ışıkları yanıyor", "Şimdi gel de sarıl bana"], 4.2),
    (48.0, ["I walk alone down this empty road", "The stars above are guiding me home", "And I know that you are waiting there"], 4.4),
]


def _lines():
    out = []
    for start, lines, per in _SECTIONS:
        t = start
        for text in lines:
            words = text.split()
            weights = np.array([len(w) + 1.5 for w in words], dtype=float)
            span = per - 0.5
            cuts = np.concatenate([[0], np.cumsum(weights / weights.sum())]) * span
            out.append({"words": [{"t": w, "s": round(t + cuts[i], 3), "e": round(t + cuts[i + 1] - 0.04, 3)}
                                  for i, w in enumerate(words)]})
            t += per
    return out


def _music() -> np.ndarray:
    n = int(SR * DURATION)
    t = np.arange(n) / SR
    beat = 60 / 96
    chords = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (261.63, 329.63, 392.0), (196.0, 246.94, 293.66)]
    out = np.zeros(n)
    bar = beat * 4
    for i in range(int(DURATION / bar) + 1):
        a, b = int(i * bar * SR), min(n, int((i + 1) * bar * SR))
        if a >= n:
            break
        tt = t[a:b] - t[a]
        root = chords[(i // 2) % 4]
        env = np.minimum(1, tt / 0.25) * np.minimum(1, (bar - tt) / 0.25)
        for f in root:
            out[a:b] += 0.11 * env * (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * 2 * f * tt))
        out[a:b] += 0.22 * env * np.sin(2 * np.pi * (root[0] / 2) * tt)
    for k in range(int(DURATION / beat)):
        a = int(k * beat * SR)
        m = min(n - a, int(0.35 * SR))
        tt = np.arange(m) / SR
        out[a:a + m] += 0.55 * np.sin(2 * np.pi * (50 + 90 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)   # kick
        h = int((k * beat + beat / 2) * SR)
        mh = min(n - h, int(0.06 * SR))
        if mh > 0:
            out[h:h + mh] += 0.07 * np.random.default_rng(k).standard_normal(mh) * np.exp(-np.arange(mh) / SR * 70)
    out /= max(1e-6, np.abs(out).max()) / 0.7
    return out.astype(np.float32)


def _guide_vocal(lines) -> np.ndarray:
    n = int(SR * DURATION)
    out = np.zeros(n, dtype=np.float32)
    scale = [0, 2, 4, 7, 9, 12]
    k = 0
    for line in lines:
        for w in line["words"]:
            a, b = int(w["s"] * SR), min(n, int(w["e"] * SR))
            if b <= a:
                continue
            f = 220 * 2 ** (scale[k % len(scale)] / 12)
            tt = np.arange(b - a) / SR
            env = np.minimum(1, tt / 0.03) * np.minimum(1, (tt[-1] - tt) / 0.05)
            out[a:b] += (0.25 * env * np.sin(2 * np.pi * f * tt)).astype(np.float32)
            k += 1
    return out


def create_demo(store: JobStore) -> dict:
    job_id = "de" + uuid.uuid4().hex[:10]
    d = store.dir(job_id)
    d.mkdir(parents=True)
    lines = _lines()
    inst, voc = _music(), _guide_vocal(lines)
    sf.write(str(d / "instrumental.wav"), np.stack([inst, inst], 1), SR, subtype="PCM_16")
    sf.write(str(d / "vocals.wav"), np.stack([voc, voc], 1), SR, subtype="PCM_16")
    audio.encode_preview(d / "instrumental.wav", d / "instrumental.mp3")
    audio.encode_preview(d / "vocals.wav", d / "vocals.mp3")
    (d / "spectrum.bin").write_bytes(audio.compute_spectrum(d / "instrumental.wav"))
    (d / "project.json").write_text(json.dumps({"lyrics": {"lines": lines, "offset": 0.0}, "style": {}}, ensure_ascii=False))
    job = {
        "id": job_id, "filename": "demo", "source": "", "title": "شب ستاره · Demo", "artist": "Karaoke Studio",
        "duration": DURATION, "language": "auto", "detected_language": "fa", "lyrics_text": "", "asr": "demo",
        "separation": "fast", "stage": "ready", "progress": 100, "message": "Ready", "error": None,
        "created": time.time(), "updated": time.time(), "stats": {"mode": "demo", "words": 0, "matched": 1.0},
        "demo": True,
    }
    (d / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=1))
    return job
