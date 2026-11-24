#!/usr/bin/env python3
"""Generate three tiny test songs (Persian / Turkish / English) with KNOWN line timings.

Speech comes from espeak-ng, the backing track from the built-in demo synth. Handy for checking the
whole pipeline (vocal removal -> recognition -> alignment) against ground truth without real music:

    sudo apt install espeak-ng          # or: brew install espeak-ng
    python scripts/make_test_songs.py /tmp/songs
    python -m karaoke.cli make /tmp/songs/tr.mp3 --lang tr --lyrics /tmp/songs/tr.txt --asr fast -o /tmp/tr.mp4

`<lang>_truth.json` lists the true start/end of every line. The voice is robotic, so recognition is
harder than for a real singer: that makes it a conservative test.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from karaoke.demo import SR, _music  # noqa: E402

SONGS = {
    "fa": ["من عاشق تو هستم ای نازنین", "در دل شب ستاره ها می درخشند", "بیا با من بمان تا صبح", "که دنیا بی تو هیچ است و پوچ"],
    "tr": ["Gözlerinde kayboldum bu gece", "İstanbul'un ışıkları yanıyor", "Seni bekledim yıllarca sessizce", "Şimdi gel de sarıl bana"],
    "en": ["I walk alone down this empty road", "The stars above are guiding me home",
           "Every step I take feels light as air", "And I know that you are waiting there"],
}


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    music = _music()
    for lang, lines in SONGS.items():
        t, truth, mix = 6.0, [], music.copy() * 0.8
        for i, text in enumerate(lines):
            wav = out / f"{lang}_{i}.wav"
            subprocess.run(["espeak-ng", "-v", lang, "-s", "115", "-p", "55", "-w", str(wav), text], check=True)
            d, sr = sf.read(str(wav), dtype="float32")
            d = d.mean(1) if d.ndim > 1 else d
            d = np.interp(np.linspace(0, len(d) - 1, int(len(d) * SR / sr)), np.arange(len(d)), d).astype(np.float32)
            a = int(t * SR)
            mix[a:a + len(d)] += d * 0.9
            truth.append({"text": text, "start": round(t, 2), "end": round(t + len(d) / SR, 2)})
            t += len(d) / SR + 2.0
            wav.unlink()
        mix = mix[: int((t + 4) * SR)]
        mix /= max(1e-6, np.abs(mix).max()) / 0.9
        sf.write(str(out / f"{lang}.wav"), np.stack([mix, mix], 1), SR)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(out / f"{lang}.wav"), "-b:a", "192k", str(out / f"{lang}.mp3")], check=True)
        (out / f"{lang}.wav").unlink()
        (out / f"{lang}.txt").write_text("\n".join(lines), encoding="utf-8")
        (out / f"{lang}_truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{lang}: {out / (lang + '.mp3')}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "test-songs"))
