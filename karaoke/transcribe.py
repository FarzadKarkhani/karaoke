"""Word-level speech recognition on the isolated vocal stem (faster-whisper)."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable, Optional

SUPPORTED = ("fa", "en", "tr")
Progress = Optional[Callable[[float], None]]

# Whisper tends to invent these in silent stretches.
_HALLUCINATIONS = re.compile(
    r"(thanks for watching|thank you for watching|subtitles by|amara\.org|please subscribe|"
    r"altyazı m\.k\.|izlediğiniz için teşekkürler|ترجمه|زیرنویس)", re.I)


def pick_device() -> tuple[str, str]:
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def transcribe(vocals: Path, language: Optional[str], model_name: str, duration: float,
               progress: Progress = None) -> dict:
    """Return {"language", "words": [{"w","s","e","p"}...]} with absolute times in seconds."""
    from faster_whisper import WhisperModel

    from . import audio as audio_io

    device, compute = pick_device()
    model = WhisperModel(model_name, device=device, compute_type=compute,
                         cpu_threads=max(1, (os.cpu_count() or 2)))
    audio = audio_io.load_mono_16k(vocals)

    if not language or language == "auto":
        # Auto-detect, but only choose among the languages this tool supports.
        _, _, probs = model.detect_language(audio, vad_filter=True, language_detection_segments=4)
        allowed = [(p, l) for l, p in probs if l in SUPPORTED]
        language = max(allowed)[1] if allowed else "en"

    def run(vad: bool):
        segs, info = model.transcribe(
            audio, language=language, word_timestamps=True, beam_size=5,
            condition_on_previous_text=False, temperature=[0.0, 0.2, 0.4],
            vad_filter=vad, vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=250),
            hallucination_silence_threshold=2.0, no_speech_threshold=0.6)
        words = []
        for seg in segs:
            if _HALLUCINATIONS.search(seg.text or ""):
                continue
            for w in seg.words or []:
                token = (w.word or "").strip()
                if token:
                    words.append({"w": token, "s": round(float(w.start), 3), "e": round(float(w.end), 3),
                                  "p": round(float(w.probability), 3)})
            if progress and duration:
                progress(min(1.0, seg.end / duration))
        return words

    words = run(vad=True)
    if len(words) < 3:                      # the VAD can swallow quiet singing; retry without it
        words = run(vad=False)
    if progress:
        progress(1.0)
    return {"language": language, "model": model_name, "words": words}
