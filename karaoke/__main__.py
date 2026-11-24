"""`python -m karaoke` / `karaoke-studio`: start the local studio and open it in the browser."""
import argparse
import os
import threading
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(prog="karaoke-studio", description="Turn songs into karaoke videos.")
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to reach it from other devices on your network")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--data", help="where projects are stored (default: ./data)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if args.data:
        os.environ["KARAOKE_DATA"] = args.data

    import uvicorn
    from .server import create_app

    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("KARAOKE_TOKEN"):
        print("\n  WARNING: listening on a network address with no KARAOKE_TOKEN set: anyone who can reach this port\n"
              "  can run heavy jobs and upload files. Set KARAOKE_TOKEN=<secret> (and KARAOKE_CORS_ORIGINS for a hosted UI).\n")
    app = create_app(args.port)
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}"
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"\n  Karaoke Studio is running at {url}\n  (Ctrl+C to stop)\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
