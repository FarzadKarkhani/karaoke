"""HTTP API + static studio UI."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, audio, config
from .jobs import JobError, JobStore, valid_id
from .render import RenderManager, safe_filename

MAX_IMAGE = 40 * 1024 * 1024
MAX_FONT = 15 * 1024 * 1024
_ASSET_RE = re.compile(r"^[0-9a-f]{16}\.(png|jpg|jpeg|webp|gif|svg|ttf|otf|woff|woff2)$")
_PRESET_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class AlignBody(BaseModel):
    text: str = ""


class ReprocessBody(BaseModel):
    language: str = "auto"
    asr: str = "balanced"
    lyrics: Optional[str] = None


class ProjectBody(BaseModel):
    lyrics: Optional[dict] = None
    style: Optional[dict] = None
    meta: Optional[dict] = None


class RenderBody(BaseModel):
    style: dict
    lyrics: dict
    options: dict = {}


class PresetBody(BaseModel):
    name: str
    style: dict


def create_app(port: int = 8000) -> FastAPI:
    config.ensure_dirs()
    app = FastAPI(title="Karaoke Studio", version=__version__)
    store = JobStore()
    renders = RenderManager(store, lambda: f"http://127.0.0.1:{app.state.port}")
    app.state.port = port
    app.state.store = store
    app.state.renders = renders

    @app.middleware("http")
    async def headers(request: Request, call_next):
        resp = await call_next(request)
        p = request.url.path
        if p.startswith("/static/") and not p.startswith("/static/fonts/"):
            resp.headers["Cache-Control"] = "no-cache"
        if p.startswith("/assets/"):
            resp.headers["Content-Security-Policy"] = "sandbox"       # uploaded SVGs must not run scripts
            resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    def job_or_404(job_id: str) -> dict:
        try:
            return store.get(job_id)
        except JobError:
            raise HTTPException(404, "Project not found")

    def public(job: dict) -> dict:
        j = dict(job)
        j.pop("source", None)
        return j

    # ------------------------------------------------------------ config
    @app.get("/api/config")
    def get_config():
        fonts = json.loads((config.STATIC_DIR / "fonts" / "fonts.json").read_text())
        return {
            "version": __version__,
            "languages": config.LANGUAGES,
            "asr": {k: v[1] for k, v in config.ASR_MODELS.items() if k != "tiny"},
            "separation": {"fast": "Fast", "best": "Best (4x slower)"},
            "fonts": fonts,
        }

    # ------------------------------------------------------------ jobs
    @app.get("/api/jobs")
    def list_jobs():
        return [public(j) for j in store.list()]

    @app.post("/api/jobs")
    async def create_job(file: UploadFile = File(...), language: str = Form("auto"), lyrics: str = Form(""),
                         title: str = Form(""), artist: str = Form(""), asr: str = Form("balanced"),
                         separation: str = Form("fast")):
        if language not in ("auto", *config.LANGUAGES):
            raise HTTPException(400, "Unsupported language")
        if asr not in config.ASR_MODELS:
            asr = "balanced"
        if separation not in config.SEPARATION_MODELS:
            separation = "fast"
        tmp_dir = config.DATA_DIR / "tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp = tmp_dir / uuid.uuid4().hex
        with tmp.open("wb") as fh:
            while chunk := await file.read(1024 * 1024):
                fh.write(chunk)
        try:
            job = store.create(tmp, file.filename or "song", language, lyrics, title, artist, asr, separation)
        except Exception as e:  # unreadable audio etc.
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, str(e))
        return public(job)

    @app.post("/api/demo")
    def make_demo():
        from .demo import create_demo
        return public(create_demo(store))

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return public(job_or_404(job_id))

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str):
        job_or_404(job_id)
        store.delete(job_id)
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/retry")
    def retry_job(job_id: str):
        job = job_or_404(job_id)
        if job["stage"] != "failed":
            raise HTTPException(409, "Only failed projects can be retried")
        store.enqueue(job_id)
        return public(store.get(job_id))

    @app.post("/api/jobs/{job_id}/reprocess")
    def reprocess_job(job_id: str, body: ReprocessBody):
        job = job_or_404(job_id)
        if job["stage"] not in ("ready", "failed"):
            raise HTTPException(409, "Still processing")
        if job.get("demo"):
            raise HTTPException(409, "The demo has no audio to analyse")
        if body.language not in ("auto", *config.LANGUAGES):
            raise HTTPException(400, "Unsupported language")
        store.reprocess(job_id, body.language, body.asr if body.asr in config.ASR_MODELS else job["asr"], body.lyrics)
        return public(store.get(job_id))

    @app.get("/api/jobs/{job_id}/project")
    def get_project(job_id: str):
        job_or_404(job_id)
        return store.load_project(job_id)

    @app.put("/api/jobs/{job_id}/project")
    def put_project(job_id: str, body: ProjectBody):
        job = job_or_404(job_id)
        project = store.load_project(job_id)
        if body.lyrics is not None:
            project["lyrics"] = body.lyrics
        if body.style is not None:
            project["style"] = body.style
        store.save_project(job_id, project)
        if body.meta:
            kv = {k: str(body.meta[k])[:200] for k in ("title", "artist") if k in body.meta}
            if kv:
                store.update(job_id, **kv)
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/align")
    def realign(job_id: str, body: AlignBody):
        job = job_or_404(job_id)
        if job["stage"] != "ready":
            raise HTTPException(409, "Still processing")
        lyr = store.align_text(job_id, body.text)
        project = store.load_project(job_id)
        project["lyrics"] = lyr
        store.save_project(job_id, project)
        return lyr

    @app.get("/api/jobs/{job_id}/audio/{which}")
    def get_audio(job_id: str, which: str):
        job_or_404(job_id)
        if which not in ("instrumental", "vocals"):
            raise HTTPException(404)
        p = store.path(job_id, f"{which}.mp3")
        if not p.exists():
            raise HTTPException(404, "Audio is not ready yet")
        return FileResponse(p, media_type="audio/mpeg")

    @app.get("/api/jobs/{job_id}/spectrum")
    def get_spectrum(job_id: str):
        job_or_404(job_id)
        p = store.path(job_id, "spectrum.bin")
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p, media_type="application/octet-stream")

    # ------------------------------------------------------------ renders
    @app.post("/api/jobs/{job_id}/renders")
    def start_render(job_id: str, body: RenderBody):
        job_or_404(job_id)
        try:
            return renders.start(job_id, body.style, body.lyrics, body.options)
        except ValueError as e:
            raise HTTPException(409, str(e))

    @app.get("/api/jobs/{job_id}/renders")
    def list_renders(job_id: str):
        job_or_404(job_id)
        return renders.list(job_id)

    @app.get("/api/jobs/{job_id}/renders/{rid}")
    def render_status(job_id: str, rid: str):
        job_or_404(job_id)
        try:
            return renders.status(job_id, rid)
        except (FileNotFoundError, ValueError):
            raise HTTPException(404, "Render not found")

    @app.delete("/api/jobs/{job_id}/renders/{rid}")
    def cancel_render(job_id: str, rid: str):
        job_or_404(job_id)
        renders.cancel(job_id, rid)
        return {"ok": True}

    @app.get("/api/jobs/{job_id}/renders/{rid}/download")
    def download_render(job_id: str, rid: str):
        job = job_or_404(job_id)
        try:
            st = renders.status(job_id, rid)
        except (FileNotFoundError, ValueError):
            raise HTTPException(404, "Render not found")
        if st["state"] != "done":
            raise HTTPException(409, "Render is not finished")
        name = safe_filename(f"{job['artist']} - {job['title']}" if job["artist"] else job["title"]) + ".mp4"
        return FileResponse(renders.dir(job_id, rid) / "video.mp4", media_type="video/mp4", filename=name)

    # ------------------------------------------------------------ assets (logos, backgrounds, fonts)
    @app.post("/api/assets")
    async def upload_asset(kind: str = Form(...), file: UploadFile = File(...)):
        ext = Path(file.filename or "").suffix.lower()
        if kind == "image" and ext in config.IMAGE_EXTS:
            limit = MAX_IMAGE
        elif kind == "font" and ext in config.FONT_EXTS:
            limit = MAX_FONT
        else:
            raise HTTPException(400, f"Unsupported {kind} file type: {ext or 'unknown'}")
        data = await file.read(limit + 1)
        if len(data) > limit:
            raise HTTPException(413, "File is too large")
        digest = hashlib.sha256(data).hexdigest()[:16]
        name = f"{digest}{ext}"
        (config.ASSETS_DIR / name).write_bytes(data)
        meta = {"kind": kind, "original": file.filename, "url": f"/assets/{name}"}
        if kind == "font":
            stem = re.sub(r"[^A-Za-z0-9 _-]+", "", Path(file.filename).stem).strip() or "Custom font"
            meta["family"] = f"{stem} (brand)"
        (config.ASSETS_DIR / f"{name}.json").write_text(json.dumps(meta))
        return meta

    @app.get("/api/assets")
    def list_assets(kind: Optional[str] = None):
        out = []
        for p in sorted(config.ASSETS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            m = json.loads(p.read_text())
            if kind in (None, m.get("kind")):
                out.append(m)
        return out

    @app.get("/assets/{name}")
    def get_asset(name: str):
        if not _ASSET_RE.match(name):
            raise HTTPException(404)
        p = config.ASSETS_DIR / name
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p)

    # ------------------------------------------------------------ saved style presets ("brand kits")
    @app.get("/api/presets")
    def list_presets():
        out = []
        for p in sorted(config.PRESETS_DIR.glob("*.json")):
            try:
                d = json.loads(p.read_text())
                out.append({"id": p.stem, "name": d.get("name", p.stem), "style": d.get("style", {}), "custom": True})
            except Exception:
                pass
        return out

    @app.put("/api/presets/{preset_id}")
    def save_preset(preset_id: str, body: PresetBody):
        if not _PRESET_RE.match(preset_id):
            raise HTTPException(400, "Bad preset id")
        (config.PRESETS_DIR / f"{preset_id}.json").write_text(
            json.dumps({"name": body.name[:60], "style": body.style}, ensure_ascii=False))
        return {"ok": True}

    @app.delete("/api/presets/{preset_id}")
    def delete_preset(preset_id: str):
        if not _PRESET_RE.match(preset_id):
            raise HTTPException(400, "Bad preset id")
        (config.PRESETS_DIR / f"{preset_id}.json").unlink(missing_ok=True)
        return {"ok": True}

    # ------------------------------------------------------------ UI
    @app.get("/")
    def index():
        return FileResponse(config.STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
    return app
