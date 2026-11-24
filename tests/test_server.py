"""API tests. They use the built-in demo project, so no AI models or browser are needed."""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="karaoke-test-")
os.environ["KARAOKE_DATA"] = _TMP          # must be set before karaoke.config is imported

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from karaoke.server import create_app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app(8000)) as c:
        yield c


@pytest.fixture(scope="module")
def demo(client):
    r = client.post("/api/demo")
    assert r.status_code == 200
    return r.json()


def test_index_and_static(client):
    assert "Karaoke Studio" in client.get("/").text
    assert client.get("/static/renderer.js").status_code == 200
    assert client.get("/static/fonts/fonts.css").status_code == 200
    assert client.get("/static/fonts/vazirmatn-arabic-700-normal.woff2").status_code == 200


def test_config_lists_bundled_fonts_with_persian_support(client):
    cfg = client.get("/api/config").json()
    fonts = {f["family"]: f for f in cfg["fonts"]}
    assert "arabic" in fonts["Vazirmatn"]["scripts"]
    assert set(cfg["languages"]) == {"fa", "en", "tr"}


def test_demo_project_roundtrip(client, demo):
    jid = demo["id"]
    assert demo["stage"] == "ready"
    proj = client.get(f"/api/jobs/{jid}/project").json()
    assert len(proj["lyrics"]["lines"]) == 10
    proj["lyrics"]["lines"][0]["words"][0]["t"] = "ویرایش"
    assert client.put(f"/api/jobs/{jid}/project", json={"lyrics": proj["lyrics"], "style": {"lyrics": {"size": 70}}}).status_code == 200
    again = client.get(f"/api/jobs/{jid}/project").json()
    assert again["lyrics"]["lines"][0]["words"][0]["t"] == "ویرایش"
    assert again["style"]["lyrics"]["size"] == 70
    assert client.put(f"/api/jobs/{jid}/project", json={"meta": {"title": "عنوان", "artist": "X"}}).status_code == 200
    assert client.get(f"/api/jobs/{jid}").json()["title"] == "عنوان"


def test_media_endpoints(client, demo):
    jid = demo["id"]
    r = client.get(f"/api/jobs/{jid}/audio/instrumental")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"
    sp = client.get(f"/api/jobs/{jid}/spectrum").content
    assert sp[:4] == b"KSP1" and len(sp) > 1000
    assert client.get(f"/api/jobs/{jid}/audio/../../etc/passwd").status_code in (404, 405)


def test_bad_ids_are_rejected(client):
    for bad in ("../../etc", "ZZZZZZZZZZZZ", "abc"):
        assert client.get(f"/api/jobs/{bad}").status_code == 404
    assert client.get("/assets/../../etc/passwd").status_code == 404
    assert client.get("/assets/0123456789abcdef.png").status_code == 404


def test_asset_upload_validation(client):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    r = client.post("/api/assets", data={"kind": "image"}, files={"file": ("logo.svg", svg, "image/svg+xml")})
    assert r.status_code == 200
    url = r.json()["url"]
    got = client.get(url)
    assert got.status_code == 200
    assert got.headers["content-security-policy"] == "sandbox"          # uploaded SVG cannot run scripts
    assert client.post("/api/assets", data={"kind": "image"}, files={"file": ("x.exe", b"MZ", "application/octet-stream")}).status_code == 400
    assert client.post("/api/assets", data={"kind": "font"}, files={"file": ("x.png", b"x", "image/png")}).status_code == 400
    f = client.post("/api/assets", data={"kind": "font"}, files={"file": ("My Brand-Font.ttf", b"\x00\x01\x00\x00fake", "font/ttf")})
    assert f.status_code == 200 and f.json()["family"] == "My Brand-Font (brand)"


def test_presets_crud(client):
    assert client.put("/api/presets/my-brand", json={"name": "My brand", "style": {"lyrics": {"font": "Inter"}}}).status_code == 200
    names = {p["id"]: p for p in client.get("/api/presets").json()}
    assert names["my-brand"]["style"]["lyrics"]["font"] == "Inter"
    assert client.put("/api/presets/../evil", json={"name": "x", "style": {}}).status_code in (400, 404, 405)
    assert client.delete("/api/presets/my-brand").status_code == 200
    assert "my-brand" not in {p["id"] for p in client.get("/api/presets").json()}


def test_upload_rejects_non_audio(client):
    r = client.post("/api/jobs", data={"language": "fa"}, files={"file": ("notes.mp3", b"this is not audio", "audio/mpeg")})
    assert r.status_code == 400


def test_render_requires_ready_project_and_valid_ids(client, demo):
    assert client.get(f"/api/jobs/{demo['id']}/renders/nonexistent1").status_code == 404
    assert client.post("/api/jobs/aaaaaaaaaaaa/renders", json={"style": {}, "lyrics": {"lines": []}}).status_code == 404


def test_reprocess_refused_for_demo(client, demo):
    assert client.post(f"/api/jobs/{demo['id']}/reprocess", json={"language": "fa"}).status_code == 409


# ---------------------------------------------------------------- hosted-UI deployment (Vercel UI + separate backend)
def test_health_is_public_and_reports_auth(client):
    h = client.get("/api/health").json()
    assert h["ok"] is True and h["auth_required"] is False


def test_token_protects_api_and_assets_but_not_ui_or_preflight(monkeypatch):
    monkeypatch.setenv("KARAOKE_TOKEN", "s3cret")
    monkeypatch.setenv("KARAOKE_CORS_ORIGINS", "https://studio.example.com/")
    with TestClient(create_app(8000)) as c:
        assert c.get("/api/health").json()["auth_required"] is True
        assert c.get("/api/config").status_code == 401
        assert c.get("/api/jobs", headers={"x-karaoke-token": "wrong"}).status_code == 401
        assert c.get("/api/jobs", headers={"x-karaoke-token": "s3cret"}).status_code == 200
        assert c.get("/api/jobs?token=s3cret").status_code == 200           # media elements cannot send headers
        assert c.get("/assets/0123456789abcdef.png").status_code == 401     # auth is checked before existence
        assert c.get("/").status_code == 200 and c.get("/config.js").status_code == 200
        pre = c.options("/api/jobs", headers={"Origin": "https://studio.example.com",
                                              "Access-Control-Request-Method": "POST",
                                              "Access-Control-Request-Headers": "x-karaoke-token"})
        assert pre.status_code == 200
        assert pre.headers["access-control-allow-origin"] == "https://studio.example.com"
        bad = c.get("/api/health", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in bad.headers
        # the 401 itself must carry CORS headers, otherwise the browser reports an opaque network error
        denied = c.get("/api/jobs", headers={"Origin": "https://studio.example.com"})
        assert denied.status_code == 401 and denied.headers["access-control-allow-origin"] == "https://studio.example.com"


def test_vercel_entrypoint_is_light_and_serves_ui(monkeypatch):
    import importlib, sys
    monkeypatch.setenv("KARAOKE_BACKEND_URL", "https://api.example.com/")
    for m in [m for m in sys.modules if m in ("app", "karaoke.webui")]:
        del sys.modules[m]
    entry = importlib.import_module("app")                 # exactly what Vercel imports
    c = TestClient(entry.app)
    assert "Karaoke Studio" in c.get("/").text
    cfg = c.get("/config.js").text
    assert '"backend": "https://api.example.com"' in cfg and '"uiOnly": true' in cfg
    assert c.get("/static/renderer.js").status_code == 200
    assert c.get("/api/jobs").status_code == 404           # the UI host has no processing API
    heavy = {"torch", "demucs", "faster_whisper", "playwright", "numpy", "soundfile", "rapidfuzz"}
    import ast, pathlib
    src = pathlib.Path(entry.__file__).read_text() + pathlib.Path(sys.modules["karaoke.webui"].__file__).read_text()
    imported = {n.names[0].name.split(".")[0] for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Import)}
    imported |= {n.module.split(".")[0] for n in ast.walk(ast.parse(src)) if isinstance(n, ast.ImportFrom) and n.module}
    assert not (imported & heavy)
