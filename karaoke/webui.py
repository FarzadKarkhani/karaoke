"""UI-only app: serves the studio front-end and points it at a separate processing backend.

This is what runs on Vercel (see ../app.py). It deliberately imports nothing heavy: the vocal-removal /
speech / video-export stack cannot run inside a serverless function, so it lives in the backend
(`python -m karaoke`, or the Dockerfile) and the browser talks to it directly.

Set KARAOKE_BACKEND_URL (e.g. https://karaoke-api.example.com) in the host's environment variables.
"""
import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

STATIC = Path(__file__).resolve().parent / "static"


def create_ui_app() -> FastAPI:
    app = FastAPI(title="Karaoke Studio (UI)", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/config.js")
    def config_js():
        cfg = {"backend": os.environ.get("KARAOKE_BACKEND_URL", "").strip().rstrip("/"), "uiOnly": True}
        return Response("window.KARAOKE_CONFIG = " + json.dumps(cfg) + ";", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


app = create_ui_app()
