"""MP4 export: headless Chromium draws every frame with the same renderer.js the studio preview uses,
frames are piped into ffmpeg (H.264 + AAC) together with the instrumental audio."""
from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import re
import shutil
import threading
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Callable, Optional

from . import audio
from .jobs import JobStore, valid_id

# quality -> (x264 preset, crf, jpeg quality for the frame hand-off)
QUALITY = {"draft": ("veryfast", 27, 0.90), "standard": ("fast", 21, 0.95), "high": ("medium", 17, 0.98)}
TAIL_SECONDS = 1.5


class RenderCancelled(Exception):
    pass


def _chromium_launch_kwargs() -> dict:
    exe = os.environ.get("KARAOKE_CHROMIUM")
    if exe:
        return {"executable_path": exe}
    return {}


def _system_chrome() -> Optional[str]:
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"):
        if Path(p).exists():
            return p
    return None


async def _launch(pw):
    args = ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none", "--hide-scrollbars"]
    kw = _chromium_launch_kwargs()
    try:
        return await pw.chromium.launch(headless=True, args=args, **kw)
    except Exception as first:
        sysexe = _system_chrome()
        if sysexe and "executable_path" not in kw:
            try:
                return await pw.chromium.launch(headless=True, args=args, executable_path=sysexe)
            except Exception:
                pass
        raise RuntimeError(
            "Could not start the headless browser used for video export. Run `playwright install chromium` "
            "(or set KARAOKE_CHROMIUM to a Chrome/Chromium executable). Details: " + str(first).splitlines()[0])


async def render_video(base_url: str, cfg: dict, audio_path: Path, out_path: Path, fps: int, quality: str,
                       duration: float, workers: int, on_progress: Callable[[float, str], None],
                       cancelled: Callable[[], bool]) -> None:
    from playwright.async_api import async_playwright

    preset, crf, jpeg_q = QUALITY.get(quality, QUALITY["standard"])
    total = max(1, math.ceil((duration + TAIL_SECONDS) * fps))
    chunk = 6

    async with async_playwright() as pw:
        browser = await _launch(pw)
        try:
            pages = []
            size = None
            for _ in range(workers):
                ctx = await browser.new_context(viewport={"width": 320, "height": 240})
                page = await ctx.new_page()
                page.on("pageerror", lambda e: print("[render page error]", e))
                await page.goto(f"{base_url}/static/render.html")
                size = await page.evaluate("cfg => window.initRender(cfg)", {**cfg, "fps": fps})
                pages.append(page)
            w, h = size["width"], size["height"]

            vf = ("scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p")
            cmd = [audio.ffmpeg_bin(), "-y", "-v", "error",
                   "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
                   "-i", str(audio_path),
                   "-map", "0:v", "-map", "1:a",
                   "-vf", vf, "-r", str(fps),
                   "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
                   "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                   "-c:a", "aac", "-b:a", "192k", "-af", "apad", "-shortest",
                   "-movflags", "+faststart", str(out_path)]
            ff = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE,
                                                      stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            stderr_task = asyncio.create_task(ff.stderr.read())

            free: asyncio.Queue = asyncio.Queue()
            for p in pages:
                free.put_nowait(p)

            async def run_chunk(start: int, count: int):
                page = await free.get()
                try:
                    return await page.evaluate("([s, c, q]) => window.renderFrames(s, c, q)", [start, count, jpeg_q])
                finally:
                    free.put_nowait(page)

            starts = list(range(0, total, chunk))
            pending: deque = deque()
            nxt, done_frames, t0 = 0, 0, time.time()
            try:
                while nxt < len(starts) or pending:
                    if cancelled():
                        raise RenderCancelled()
                    while nxt < len(starts) and len(pending) < workers * 2:
                        s = starts[nxt]
                        pending.append(asyncio.create_task(run_chunk(s, min(chunk, total - s))))
                        nxt += 1
                    frames = await pending.popleft()
                    for b64 in frames:
                        ff.stdin.write(base64.b64decode(b64))
                    try:
                        await ff.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    done_frames += len(frames)
                    el = time.time() - t0
                    eta = el / done_frames * (total - done_frames) if done_frames else 0
                    on_progress(done_frames / total, f"Rendering frame {done_frames}/{total}  ·  about {int(eta // 60)}m {int(eta % 60):02d}s left")
                if ff.stdin and not ff.stdin.is_closing():
                    ff.stdin.close()
                rc = await ff.wait()
                err = (await stderr_task).decode(errors="replace").strip()
                if rc != 0:
                    raise RuntimeError(f"ffmpeg failed: {err[-600:]}")
            except BaseException:
                for t in pending:
                    t.cancel()
                if ff.returncode is None:
                    ff.kill()
                raise
        finally:
            await browser.close()


class RenderManager:
    """Tracks MP4 exports. They share the store's single worker thread with the analysis jobs."""

    def __init__(self, store: JobStore, base_url_getter: Callable[[], str]):
        self.store = store
        self.base_url = base_url_getter
        self._cancel: dict[str, threading.Event] = {}

    def dir(self, job_id: str, rid: str) -> Path:
        if not valid_id(rid):
            raise ValueError("bad render id")
        return self.store.dir(job_id) / "renders" / rid

    def status(self, job_id: str, rid: str) -> dict:
        p = self.dir(job_id, rid) / "status.json"
        if not p.exists():
            raise FileNotFoundError(rid)
        return json.loads(p.read_text())

    def list(self, job_id: str) -> list[dict]:
        root = self.store.dir(job_id) / "renders"
        out = []
        if root.exists():
            for d in root.iterdir():
                if (d / "status.json").exists():
                    out.append(json.loads((d / "status.json").read_text()))
        return sorted(out, key=lambda r: r.get("created", 0), reverse=True)

    def _write(self, job_id: str, rid: str, **kv) -> dict:
        d = self.dir(job_id, rid)
        p = d / "status.json"
        cur = json.loads(p.read_text()) if p.exists() else {}
        cur.update(kv)
        tmp = d / "status.json.tmp"
        tmp.write_text(json.dumps(cur, ensure_ascii=False))
        os.replace(tmp, p)
        return cur

    def start(self, job_id: str, style: dict, lyrics: dict, options: dict) -> dict:
        job = self.store.get(job_id)
        if job["stage"] != "ready":
            raise ValueError("This project is not ready yet.")
        rid = uuid.uuid4().hex[:12]
        d = self.dir(job_id, rid)
        d.mkdir(parents=True)
        fps = int(options.get("fps", 30))
        if fps not in (24, 25, 30, 50, 60):
            fps = 30
        quality = options.get("quality", "standard")
        if quality not in QUALITY:
            quality = "standard"
        opts = {"fps": fps, "quality": quality, "guide": max(0.0, min(0.6, float(options.get("guide", 0.0)))),
                "workers": options.get("workers")}
        (d / "project.json").write_text(json.dumps({"style": style, "lyrics": lyrics, "options": opts}, ensure_ascii=False))
        self._cancel[rid] = threading.Event()
        self._write(job_id, rid, id=rid, job=job_id, state="queued", progress=0, message="Waiting for other work to finish",
                    created=time.time(), options=opts, file=None, error=None, title=job["title"])
        self.store.pool.submit(self._run, job_id, rid)
        return self.status(job_id, rid)

    def cancel(self, job_id: str, rid: str) -> None:
        ev = self._cancel.get(rid)
        if ev:
            ev.set()

    def remove(self, job_id: str, rid: str) -> None:
        """Cancel a queued/running export, or delete a finished one (frees its disk space)."""
        try:
            state = self.status(job_id, rid)["state"]
        except FileNotFoundError:
            return
        if state in ("queued", "running"):
            self.cancel(job_id, rid)
        else:
            shutil.rmtree(self.dir(job_id, rid), ignore_errors=True)

    def _run(self, job_id: str, rid: str) -> None:
        ev = self._cancel.setdefault(rid, threading.Event())
        d = self.dir(job_id, rid)
        try:
            if ev.is_set():
                raise RenderCancelled()
            proj = json.loads((d / "project.json").read_text())
            opts = proj["options"]
            job = self.store.get(job_id)
            jd = self.store.dir(job_id)
            self._write(job_id, rid, state="running", message="Preparing audio", progress=0)

            mix = d / "audio.wav"
            audio.make_mix(jd / "instrumental.wav", jd / "vocals.wav", opts["guide"], mix)

            workers = opts.get("workers") or max(1, min(4, (os.cpu_count() or 2) // 2))   # Chromium and ffmpeg share the cores
            cfg = {
                "style": proj["style"],
                "lyrics": proj["lyrics"],
                "meta": {"title": job["title"], "artist": job["artist"], "duration": job["duration"],
                         "language": job.get("language") if job.get("language") in ("fa", "en", "tr") else job.get("detected_language")},
                "spectrumUrl": f"/api/jobs/{job_id}/spectrum",
            }
            out = d / "video.mp4"

            def on_progress(frac: float, msg: str) -> None:
                self._write(job_id, rid, progress=round(frac * 100, 1), message=msg)

            asyncio.run(render_video(self.base_url(), cfg, mix, out, opts["fps"], opts["quality"], job["duration"],
                                     int(workers), on_progress, ev.is_set))
            mix.unlink(missing_ok=True)
            self._write(job_id, rid, state="done", progress=100, message="Done", file="video.mp4",
                        size=out.stat().st_size)
        except RenderCancelled:
            (d / "video.mp4").unlink(missing_ok=True)
            self._write(job_id, rid, state="canceled", message="Canceled")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            (d / "video.mp4").unlink(missing_ok=True)
            self._write(job_id, rid, state="failed", error=str(e)[:700], message="Failed")


def safe_filename(name: str, default: str = "karaoke") -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", name or "").strip(" .")
    return (re.sub(r"\s+", " ", name) or default)[:120]
