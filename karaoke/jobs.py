"""Job storage and the background pipeline (decode -> separate -> transcribe -> align)."""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

from . import align, audio, config

_ID_RE = re.compile(r"^[0-9a-f]{12}$")

# (stage key, label shown in the UI, progress range)
STAGES = [
    ("decode", "Reading your audio", 0, 4),
    ("separate", "Removing the vocals", 4, 48),
    ("transcribe", "Listening to the lyrics", 48, 92),
    ("finalize", "Syncing the words", 92, 100),
]
_RANGE = {k: (lo, hi) for k, _, lo, hi in STAGES}


class JobError(RuntimeError):
    pass


def valid_id(job_id: str) -> bool:
    return bool(_ID_RE.match(job_id or ""))


class JobStore:
    def __init__(self) -> None:
        config.ensure_dirs()
        self._lock = threading.RLock()
        # One heavy task (separation, speech recognition, video render) at a time keeps CPU/RAM predictable.
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="karaoke-worker")
        self._recover()

    # -------------------------------------------------------------- paths / state
    def dir(self, job_id: str) -> Path:
        if not valid_id(job_id):
            raise JobError("bad job id")
        return config.JOBS_DIR / job_id

    def path(self, job_id: str, name: str) -> Path:
        return self.dir(job_id) / name

    def get(self, job_id: str) -> dict:
        p = self.path(job_id, "job.json")
        if not p.exists():
            raise JobError("job not found")
        with self._lock:
            return json.loads(p.read_text())

    def list(self) -> list[dict]:
        out = []
        for d in config.JOBS_DIR.iterdir():
            if (d / "job.json").exists() and valid_id(d.name):
                try:
                    out.append(json.loads((d / "job.json").read_text()))
                except Exception:
                    pass
        return sorted(out, key=lambda j: j.get("created", 0), reverse=True)

    def update(self, job_id: str, **kv: Any) -> dict:
        with self._lock:
            job = self.get(job_id)
            job.update(kv)
            job["updated"] = time.time()
            tmp = self.path(job_id, "job.json.tmp")
            tmp.write_text(json.dumps(job, ensure_ascii=False, indent=1))
            os.replace(tmp, self.path(job_id, "job.json"))
            return job

    def disk_usage(self) -> dict:
        """Bytes used by every project (and by their exports), plus free space on the data disk."""
        per = {}
        for d in config.JOBS_DIR.iterdir():
            if valid_id(d.name) and d.is_dir():
                per[d.name] = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        return {"projects": per, "bytes": sum(per.values()), "free": shutil.disk_usage(config.DATA_DIR).free}

    def delete(self, job_id: str) -> None:
        shutil.rmtree(self.dir(job_id), ignore_errors=True)

    def _recover(self) -> None:
        """Jobs that were mid-flight when the server stopped can be retried from the UI."""
        for j in self.list():
            if j.get("stage") not in ("ready", "failed"):
                self.update(j["id"], stage="failed", error="Processing was interrupted. Press Retry to continue.")

    # -------------------------------------------------------------- creating
    def create(self, upload: Path, filename: str, language: str, lyrics: str, title: str, artist: str,
               asr: str, separation: str) -> dict:
        job_id = uuid.uuid4().hex[:12]
        d = self.dir(job_id)
        d.mkdir(parents=True)
        ext = Path(filename).suffix.lower() or ".bin"
        src = d / f"source{ext}"
        shutil.move(str(upload), src)
        try:
            info = audio.probe(src)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
        job = {
            "id": job_id, "filename": filename, "source": src.name,
            "title": title.strip() or info["title"] or Path(filename).stem,
            "artist": artist.strip() or info["artist"],
            "duration": info["duration"], "language": language, "detected_language": None,
            "lyrics_text": lyrics, "asr": asr, "separation": separation,
            "stage": "queued", "progress": 0, "message": "Waiting to start", "error": None,
            "created": time.time(), "updated": time.time(), "stats": None,
        }
        (d / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=1))
        self.enqueue(job_id)
        return job

    def enqueue(self, job_id: str) -> None:
        self.update(job_id, stage="queued", progress=0, message="Waiting to start", error=None)
        self.pool.submit(self._run, job_id)

    # -------------------------------------------------------------- pipeline
    def _progress(self, job_id: str, stage: str, frac: float, message: Optional[str] = None) -> None:
        lo, hi = _RANGE[stage]
        label = dict((k, l) for k, l, _, _ in STAGES)[stage]
        self.update(job_id, stage=stage, progress=round(lo + (hi - lo) * max(0.0, min(1.0, frac)), 1),
                    message=message or label)

    def _run(self, job_id: str) -> None:
        try:
            job = self.get(job_id)
            d = self.dir(job_id)
            wav = d / "audio.wav"
            vocals, inst = d / "vocals.wav", d / "instrumental.wav"

            need_separation = not (vocals.exists() and inst.exists())
            if need_separation and not wav.exists():        # the decoded copy is only needed for separation
                self._progress(job_id, "decode", 0.1)
                audio.decode_to_wav(d / job["source"], wav)
            self._progress(job_id, "decode", 1)

            if need_separation:
                from . import separate
                model = config.SEPARATION_MODELS.get(job["separation"], "htdemucs")
                self._progress(job_id, "separate", 0, "Removing the vocals (first run downloads the model)")
                separate.separate(wav, vocals, inst, model,
                                  progress=lambda f: self._progress(job_id, "separate", f))
            self._progress(job_id, "separate", 1)

            asr_path = d / "asr.json"
            if not asr_path.exists():
                from . import transcribe
                model_name = config.ASR_MODELS.get(job["asr"], config.ASR_MODELS["balanced"])[0]
                language = job["language"]
                if language == "auto":
                    language = align.guess_language(job["lyrics_text"]) or "auto"
                self._progress(job_id, "transcribe", 0, "Listening to the lyrics (first run downloads the model)")
                asr = transcribe.transcribe(vocals, language, model_name, job["duration"],
                                            progress=lambda f: self._progress(job_id, "transcribe", f))
                asr_path.write_text(json.dumps(asr, ensure_ascii=False))
            asr = json.loads(asr_path.read_text())
            self.update(job_id, detected_language=asr.get("language"))
            self._progress(job_id, "transcribe", 1)

            self._progress(job_id, "finalize", 0.05)
            audio.encode_preview(inst, d / "instrumental.mp3")
            audio.encode_preview(vocals, d / "vocals.mp3")
            self._progress(job_id, "finalize", 0.5)
            (d / "spectrum.bin").write_bytes(audio.compute_spectrum(inst))
            self._progress(job_id, "finalize", 0.8)

            project = self.load_project(job_id)
            if not project["lyrics"]["lines"]:              # never overwrite the user's edits on a retry
                project["lyrics"] = self.align_text(job_id, job["lyrics_text"])
                self.save_project(job_id, project)
            wav.unlink(missing_ok=True)                    # ~10 MB per minute of audio that nothing needs any more
            self.update(job_id, stage="ready", progress=100, message="Ready", error=None)
        except Exception as e:  # noqa: BLE001 - surfaced to the UI
            traceback.print_exc()
            self.update(job_id, stage="failed", error=_friendly(e))

    def reprocess(self, job_id: str, language: str, asr: str, lyrics_text: Optional[str]) -> None:
        """Redo speech recognition + alignment (e.g. the language was guessed wrong). Keeps stems and style."""
        job = self.get(job_id)
        d = self.dir(job_id)
        (d / "asr.json").unlink(missing_ok=True)
        project = self.load_project(job_id)
        project["lyrics"] = {"lines": [], "offset": 0.0}
        self.save_project(job_id, project)
        self.update(job_id, language=language, asr=asr, detected_language=None, stats=None,
                    lyrics_text=job["lyrics_text"] if lyrics_text is None else lyrics_text)
        self.enqueue(job_id)

    # -------------------------------------------------------------- lyrics
    def align_text(self, job_id: str, text: str) -> dict:
        """(Re)build timed lines from the cached recognition result and the given lyrics text."""
        job = self.get(job_id)
        d = self.dir(job_id)
        asr = json.loads((d / "asr.json").read_text())
        span = audio.active_span(d / "vocals.wav") if (d / "vocals.wav").exists() else None
        res = align.build_lines(asr, text, job["duration"], span)
        self.update(job_id, lyrics_text=text, stats=res["stats"])
        return {"lines": res["lines"], "offset": 0.0, "stats": res["stats"]}

    # -------------------------------------------------------------- project (lyrics + style)
    def load_project(self, job_id: str) -> dict:
        p = self.path(job_id, "project.json")
        if p.exists():
            return json.loads(p.read_text())
        return {"lyrics": {"lines": [], "offset": 0.0}, "style": {}}

    def save_project(self, job_id: str, project: dict) -> None:
        tmp = self.path(job_id, "project.json.tmp")
        tmp.write_text(json.dumps(project, ensure_ascii=False))
        os.replace(tmp, self.path(job_id, "project.json"))


def _friendly(e: Exception) -> str:
    msg = str(e) or e.__class__.__name__
    if "ffmpeg" in msg.lower() and "not found" in msg.lower():
        return msg
    if isinstance(e, (OSError, ConnectionError)) and any(k in msg.lower() for k in ("connect", "resolve", "timed out", "network", "offline", "hub", "ssl")):
        return ("Could not download an AI model (network problem). The first run needs internet to fetch the "
                "vocal-removal and speech models. " + msg[:200])
    return msg[:600]
