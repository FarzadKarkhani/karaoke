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
