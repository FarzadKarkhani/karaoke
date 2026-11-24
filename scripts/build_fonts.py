#!/usr/bin/env python3
"""Rebuild karaoke/static/fonts from @fontsource npm packages (all SIL OFL 1.1).

Usage:  python scripts/build_fonts.py
Needs `npm` and network access. The generated files are committed to the repo,
so end users never have to run this.
"""
import json, re, shutil, subprocess, sys, tarfile, tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "karaoke" / "static" / "fonts"
WEIGHTS = (400, 700)
SUBSETS = ("arabic", "latin", "latin-ext")

# family label, npm slug, CSS family name, scripts the font itself covers, short note
FONTS = [
    ("Vazirmatn", "vazirmatn", ["latin", "arabic"], "Persian / Arabic UI font, clean and modern"),
    ("Inter", "inter", ["latin"], "Neutral sans-serif (Persian falls back to Vazirmatn)"),
    ("Montserrat", "montserrat", ["latin"], "Geometric sans-serif (Persian falls back to Vazirmatn)"),
    ("Poppins", "poppins", ["latin"], "Rounded geometric sans-serif (Persian falls back to Vazirmatn)"),
    ("Playfair Display", "playfair-display", ["latin"], "Elegant serif (Persian falls back to Noto Naskh Arabic)"),
    ("Lalezar", "lalezar", ["latin", "arabic"], "Bold display face for Persian titles"),
    ("Noto Naskh Arabic", "noto-naskh-arabic", ["arabic"], "Traditional Naskh style for Persian"),
]


def main():
    tmp = Path(tempfile.mkdtemp())
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    css_parts, manifest = [], []
    for label, slug, scripts, note in FONTS:
        subprocess.run(["npm", "pack", f"@fontsource/{slug}", "--silent"], cwd=tmp, check=True,
                       stdout=subprocess.DEVNULL)
        tgz = next(tmp.glob(f"fontsource-{slug}-*.tgz"))
        dest = tmp / slug
        dest.mkdir()
        with tarfile.open(tgz) as t:
            t.extractall(dest, filter="data")
        pkg = dest / "package"
        have = []
        for w in WEIGHTS:
            css_file = pkg / f"{w}.css"
            if not css_file.exists():
                continue
            have.append(w)
            for block in re.findall(r"@font-face\s*\{.*?\}", css_file.read_text(), flags=re.S):
                m = re.search(r"/files/([\w-]+-(%s)-%d-normal)\.woff2" % ("|".join(SUBSETS), w), block)
                if not m:
                    continue
                name = m.group(1) + ".woff2"
                shutil.copy(pkg / "files" / name, OUT / name)
                rng = re.search(r"unicode-range:\s*([^;]+);", block).group(1)
                css_parts.append(
                    f"@font-face{{font-family:'{label}';font-style:normal;font-weight:{w};"
                    f"font-display:block;src:url('{name}') format('woff2');unicode-range:{rng};}}")
        lic = pkg / "LICENSE"
        if lic.exists():
            shutil.copy(lic, OUT / f"LICENSE-{slug}.txt")
        manifest.append({"family": label, "weights": have, "scripts": scripts, "note": note})
    (OUT / "fonts.css").write_text("\n".join(css_parts) + "\n")
    (OUT / "fonts.json").write_text(json.dumps(manifest, indent=1))
    shutil.rmtree(tmp, ignore_errors=True)
    size = sum(p.stat().st_size for p in OUT.glob("*.woff2"))
    print(f"{len(manifest)} families, {len(css_parts)} faces, {size/1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
