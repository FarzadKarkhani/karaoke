"""ffmpeg helpers and the audio-reactive spectrum used by the visualizer."""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np

SR = 44100
SPECTRUM_FPS = 60
SPECTRUM_BANDS = 64


def ffmpeg_bin() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg was not found on PATH. Install it (e.g. `apt install ffmpeg`, `brew install ffmpeg`).")
    return exe


def run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{Path(cmd[0]).name} failed: {p.stderr.strip()[-800:]}")


def probe(path: Path) -> dict:
    """Duration + embedded title/artist tags."""
    exe = shutil.which("ffprobe")
    if not exe:
        raise RuntimeError("ffprobe was not found on PATH (it ships with ffmpeg).")
    p = subprocess.run(
        [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError("This file could not be read as audio.")
    info = json.loads(p.stdout or "{}")
    if not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
        raise RuntimeError("No audio stream found in this file.")
    fmt = info.get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    duration = float(fmt.get("duration") or 0)
    if not duration:
        for s in info["streams"]:
            if s.get("codec_type") == "audio" and s.get("duration"):
                duration = float(s["duration"])
    return {"duration": duration, "title": tags.get("title", ""), "artist": tags.get("artist", "")}


def decode_to_wav(src: Path, dst: Path, sr: int = SR) -> None:
    run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "2", "-ar", str(sr),
         "-c:a", "pcm_s16le", str(dst)])


def load_mono_16k(path: Path) -> "np.ndarray":
    """Decode to 16 kHz mono float32 with ffmpeg (speech models want this; avoids a PyAV dependency)."""
    p = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
                        "-f", "f32le", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.decode(errors='replace').strip()[-400:]}")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def encode_preview(wav: Path, dst: Path) -> None:
    """Small mp3 for the in-browser preview player."""
    run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(wav), "-vn", "-c:a", "libmp3lame", "-b:a", "160k", str(dst)])


def make_mix(instrumental: Path, vocals: Path | None, guide: float, dst: Path) -> None:
    """Instrumental plus an optional quiet guide vocal (0..1)."""
    if not vocals or guide <= 0.001:
        shutil.copyfile(instrumental, dst)
        return
    run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(instrumental), "-i", str(vocals),
         "-filter_complex", f"[1:a]volume={guide:.3f}[v];[0:a][v]amix=inputs=2:normalize=0:duration=first[m]",
         "-map", "[m]", "-c:a", "pcm_s16le", str(dst)])


def active_span(wav: Path) -> tuple[float, float] | None:
    """First and last moment the (vocal) track is clearly audible, in seconds."""
    import soundfile as sf

    data, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    win = max(1, int(sr * 0.05))
    n = len(mono) // win
    if n < 2:
        return None
    rms = np.sqrt((mono[: n * win].reshape(n, win) ** 2).mean(axis=1))
    if rms.max() < 1e-4:
        return None
    thr = max(np.percentile(rms, 95) * 0.12, 1e-4)
    idx = np.where(rms > thr)[0]
    if not len(idx):
        return None
    return float(idx[0] * 0.05), float((idx[-1] + 1) * 0.05)


# ---------------------------------------------------------------- spectrum
def compute_spectrum(wav: Path, fps: int = SPECTRUM_FPS, bands: int = SPECTRUM_BANDS) -> bytes:
    """Per-frame log-spaced band levels (uint8), pre-smoothed so frames can be rendered in any order.

    Layout: b'KSP1' | uint16 bands | uint16 fps | uint32 frames | frames*bands bytes
    """
    import soundfile as sf

    data, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    n_fft = 2048
    hop = int(round(sr / fps))
    n_frames = max(1, int(np.ceil(len(mono) / hop)))
    pad = np.zeros(n_fft + n_frames * hop, dtype=np.float32)
    pad[n_fft // 2: n_fft // 2 + len(mono)] = mono
    win = np.hanning(n_fft).astype(np.float32)

    # log-spaced band edges, 45 Hz .. 16 kHz, each band covers at least one FFT bin
    edges = np.geomspace(45, min(16000, sr / 2 - 1), bands + 1)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    lo_idx = np.searchsorted(freqs, edges[:-1]).astype(int)
    hi_idx = np.maximum(np.searchsorted(freqs, edges[1:]).astype(int), lo_idx + 1)
    centre = (edges[:-1] * edges[1:]) ** 0.5
    tilt_db = 3.0 * np.log2(centre / 1000.0)           # +3 dB/octave so highs are visible

    out = np.empty((n_frames, bands), dtype=np.float32)
    chunk = 2048
    for c0 in range(0, n_frames, chunk):
        c1 = min(n_frames, c0 + chunk)
        idx = (np.arange(c0, c1)[:, None] * hop) + np.arange(n_fft)[None, :]
        mag = np.abs(np.fft.rfft(pad[idx] * win, axis=1)) / (n_fft / 4)
        cs = np.concatenate([np.zeros((mag.shape[0], 1), dtype=np.float64), np.cumsum(mag, axis=1, dtype=np.float64)], axis=1)
        sums = cs[:, hi_idx] - cs[:, lo_idx]
        out[c0:c1] = sums / (hi_idx - lo_idx)[None, :]

    db = 20 * np.log10(out + 1e-7) + tilt_db[None, :]
    lo, hi = np.percentile(db, 8), np.percentile(db, 99.7)
    if hi - lo < 1e-3:
        hi = lo + 1
    v = np.clip((db - lo) / (hi - lo), 0, 1) ** 1.35

    # attack/release smoothing across frames (vectorised over bands)
    s = np.zeros_like(v)
    prev = np.zeros(bands, dtype=np.float32)
    for i in range(n_frames):
        cur = v[i]
        prev = np.where(cur > prev, prev + (cur - prev) * 0.65, prev * 0.90 + cur * 0.10)
        s[i] = prev
    q = np.clip(s * 255 + 0.5, 0, 255).astype(np.uint8)
    return b"KSP1" + struct.pack("<HHI", bands, fps, n_frames) + q.tobytes()
