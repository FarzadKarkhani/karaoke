"""Headless command line: song in, MP4 out (no browser UI needed).

    python -m karaoke.cli make song.mp3 --lang fa --lyrics lyrics.txt --preset neon -o song.mp4
    python -m karaoke.cli demo --preset gold -o demo.mp4
"""
from __future__ import annotations

import argparse
import json
import shutil
import socket
import sys
import threading
import time
from pathlib import Path


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(poll, label: str, interval: float = 1.0):
    last = None
    while True:
        st = poll()
        line = f"{label}: {st['message']} ({st['progress']:.0f}%)"
        if line != last:
            print("\r" + line.ljust(90), end="", flush=True)
            last = line
        if st.get("stage", st.get("state")) in ("ready", "done"):
            print()
            return st
        if st.get("stage", st.get("state")) in ("failed", "canceled"):
            print()
            raise SystemExit(f"{label} failed: {st.get('error') or st.get('message')}")
        time.sleep(interval)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m karaoke.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("-o", "--output", default="karaoke.mp4")
    common.add_argument("--preset", default="neon", help="neon, gold, clean, sunset, studio, ocean")
    common.add_argument("--style", help="JSON file with style overrides (as exported from the studio)")
    common.add_argument("--aspect", default="16:9", choices=["16:9", "9:16", "1:1", "4:5"])
    common.add_argument("--height", type=int, default=1080, help="short side in px (720 / 1080 / 1440)")
    common.add_argument("--fps", type=int, default=30)
    common.add_argument("--quality", default="standard", choices=["draft", "standard", "high"])
    common.add_argument("--guide", type=float, default=0.0, help="guide-vocal level 0..0.6")
    common.add_argument("--workers", type=int, help="parallel browser pages (default: CPU count, max 4)")
    common.add_argument("--data", help="project storage folder")

    mk = sub.add_parser("make", parents=[common], help="process a song and export the video")
    mk.add_argument("song")
    mk.add_argument("--lang", default="auto", choices=["auto", "fa", "en", "tr"])
    mk.add_argument("--lyrics", help="text file with the lyrics (one line per sung line)")
    mk.add_argument("--title", default="")
    mk.add_argument("--artist", default="")
    mk.add_argument("--asr", default="balanced", choices=["fast", "balanced", "best", "tiny"])
    mk.add_argument("--separation", default="fast", choices=["fast", "best"])
    sub.add_parser("demo", parents=[common], help="export the built-in demo project")
    args = ap.parse_args(argv)

    if args.data:
        import os
        os.environ["KARAOKE_DATA"] = args.data

    import uvicorn
    from .server import create_app

    port = _free_port()
    app = create_app(port)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)

    store, renders = app.state.store, app.state.renders
    if args.cmd == "demo":
        from .demo import create_demo
        job = create_demo(store)
    else:
        lyrics = Path(args.lyrics).read_text(encoding="utf-8") if args.lyrics else ""
        src = Path(args.song)
        tmp = Path(args.data or ".") / f".upload-{src.name}"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, tmp)
        job = store.create(tmp, src.name, args.lang, lyrics, args.title, args.artist, args.asr, args.separation)
        _wait(lambda: store.get(job["id"]), "Analysing")
        st = store.get(job["id"])
        print(f"  language: {st.get('detected_language')}  lyrics matched: {(st.get('stats') or {}).get('matched')}")

    jid = job["id"]
    project = store.load_project(jid)
    style = {"preset": args.preset, "canvas": {"aspect": args.aspect, "quality": args.height}}
    if args.style:
        from .jsonmerge import merge
        style = merge(style, json.loads(Path(args.style).read_text(encoding="utf-8")))
    rs = renders.start(jid, style, project["lyrics"],
                       {"fps": args.fps, "quality": args.quality, "guide": args.guide, "workers": args.workers})
    st = _wait(lambda: renders.status(jid, rs["id"]), "Rendering", 0.5)
    out = Path(args.output)
    shutil.copyfile(renders.dir(jid, rs["id"]) / "video.mp4", out)
    print(f"Saved {out} ({out.stat().st_size / 1e6:.1f} MB)")
    server.should_exit = True


if __name__ == "__main__":
    main()
