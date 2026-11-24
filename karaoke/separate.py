"""Vocal removal with Demucs (hybrid transformer). Runs on GPU when available, otherwise CPU."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Optional

Progress = Optional[Callable[[float], None]]


def pick_device() -> str:
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def separate(wav_in: Path, vocals_out: Path, instrumental_out: Path,
             model_name: str = "htdemucs", progress: Progress = None) -> None:
    """Split `wav_in` into vocals + everything-else and write both as 16-bit wav files."""
    import numpy as np
    import soundfile as sf
    import torch
    import demucs.apply as dapply
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    device = pick_device()
    model = get_model(model_name)
    model.eval()
    sr = model.samplerate

    data, file_sr = sf.read(str(wav_in), dtype="float32", always_2d=True)   # (n, ch)
    if file_sr != sr:
        raise RuntimeError(f"expected {sr} Hz audio, got {file_sr}")
    wav = torch.from_numpy(data.T.copy())                                  # (ch, n)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    wav = wav[: model.audio_channels]

    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)

    # Demucs shows a tqdm bar; swap in a shim so we can report real progress to the UI.
    class _Tqdm:
        @staticmethod
        def tqdm(iterable, **_kw):
            items = list(iterable)
            for i, item in enumerate(items):
                yield item
                if progress:
                    progress((i + 1) / max(1, len(items)))

    # If a future Demucs drops that hook, separation still works, just without a live progress bar.
    has_hook = hasattr(dapply, "tqdm")
    original = getattr(dapply, "tqdm", None)
    if has_hook:
        dapply.tqdm = _Tqdm
    try:
        with torch.no_grad():
            sources = apply_model(model, wav[None], device=device, shifts=1, split=True,
                                  overlap=0.25, progress=has_hook, num_workers=0)[0]
    finally:
        if has_hook:
            dapply.tqdm = original

    sources = sources * (ref.std() + 1e-8) + ref.mean()
    names = list(model.sources)
    vocals = sources[names.index("vocals")]
    instrumental = sum(sources[i] for i, n in enumerate(names) if n != "vocals")

    peak = max(float(vocals.abs().max()), float(instrumental.abs().max()), 1e-6)
    scale = 0.98 / peak if peak > 0.98 else 1.0
    for tensor, path in ((vocals, vocals_out), (instrumental, instrumental_out)):
        arr = (tensor * scale).clamp(-1, 1).T.cpu().numpy().astype(np.float32)
        sf.write(str(path), arr, sr, subtype="PCM_16")
