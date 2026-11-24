"""Vercel entrypoint: serves the UI only. The processing backend runs elsewhere (see README, "Deploy")."""
from karaoke.webui import app  # noqa: F401  (Vercel looks for a top-level `app`)
