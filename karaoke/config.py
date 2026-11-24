"""Paths and constants. Everything user-generated lives under DATA_DIR."""
import os
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
STATIC_DIR = PKG_DIR / "static"

DATA_DIR = Path(os.environ.get("KARAOKE_DATA", Path.cwd() / "data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
ASSETS_DIR = DATA_DIR / "assets"      # uploaded logos, backgrounds, fonts (content-addressed)
PRESETS_DIR = DATA_DIR / "presets"    # saved brand / style presets

LANGUAGES = {"fa": "Persian", "en": "English", "tr": "Turkish"}

# Speech-model choices shown in the UI: key -> (faster-whisper model name, label)
ASR_MODELS = {
    "fast": ("small", "Fast (small)"),
    "balanced": ("medium", "Balanced (medium)"),
    "best": ("large-v3-turbo", "Best (large-v3-turbo)"),
    "tiny": ("tiny", "Tiny (testing only)"),
}
SEPARATION_MODELS = {
    "fast": "htdemucs",
    "best": "htdemucs_ft",
}

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif", ".mp4", ".webm", ".mka"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
FONT_EXTS = {".ttf", ".otf", ".woff", ".woff2"}


def ensure_dirs():
    for d in (JOBS_DIR, ASSETS_DIR, PRESETS_DIR):
        d.mkdir(parents=True, exist_ok=True)
