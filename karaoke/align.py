"""Turn speech-recognition words (+ optional user-supplied lyrics) into timed karaoke lines.

Two modes
---------
* No lyrics given  -> group the recognised words into lines.
* Lyrics given     -> keep the user's exact text and line breaks, and borrow timings from the
                      recognised words wherever they fuzzy-match (global sequence alignment).
                      Words the recogniser missed are interpolated between their neighbours.

Matching is script-aware: Persian/Arabic spelling variants (ي/ی, ك/ک, ZWNJ, diacritics, digits)
and Turkish letters (İ/I/ı/i, ğ ş ç ö ü) are folded so that harmless spelling differences do not
break the alignment. Only the matching uses the folded form; the text shown in the video is
exactly what the user wrote.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

import numpy as np
from rapidfuzz import fuzz, process

# ------------------------------------------------------------------ normalisation
_AR_MARKS = re.compile("[ً-ٰٟۖ-ۭـ]")      # harakat, tatweel, quranic marks
_INVISIBLE = dict.fromkeys(map(ord, "‌‍‎‏‪‫‬؜﻿"), None)
_LETTER_MAP = str.maketrans({
    "ي": "ی", "ى": "ی", "ئ": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه", "ە": "ه",
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ؤ": "و",
    **{c: str(i) for i, c in enumerate("٠١٢٣٤٥٦٧٨٩")},
    **{c: str(i) for i, c in enumerate("۰۱۲۳۴۵۶۷۸۹")},
})
_TR_FOLD = str.maketrans("ığşçöü", "igscou")


def norm(token: str) -> str:
    """Aggressively folded form of a token, used only for matching."""
    t = unicodedata.normalize("NFKC", token).translate(_INVISIBLE)
    t = _AR_MARKS.sub("", t).translate(_LETTER_MAP)
    t = t.replace("İ", "i").replace("I", "ı").lower().translate(_TR_FOLD)
    return "".join(ch for ch in t if ch.isalnum())


# ------------------------------------------------------------------ language guess from text
_ARABIC_LETTER = re.compile("[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]")
_TURKISH_ONLY = re.compile("[ğĞşŞıİ]")
_TURKISH_MAYBE = re.compile("[çÇöÖüÜ]")           # also German/French, but neither is supported here


def guess_language(text: str) -> Optional[str]:
    """fa / tr / en from the lyrics themselves (far more reliable than detecting it from singing)."""
    letters = [c for c in (text or "") if c.isalpha()]
    if len(letters) < 8:
        return None
    if sum(1 for c in letters if _ARABIC_LETTER.match(c)) / len(letters) > 0.3:
        return "fa"
    if _TURKISH_ONLY.search(text) or len(_TURKISH_MAYBE.findall(text)) >= 2:
        return "tr"
    return "en"


# ------------------------------------------------------------------ lyrics parsing
_SECTION = re.compile(r"^\s*\[[^\]]{0,40}\]\s*$")


def parse_lyrics(text: str) -> list[list[str]]:
    """Lines of tokens. Blank lines and `[Chorus]`-style markers are dropped."""
    lines: list[list[str]] = []
    for raw in (text or "").splitlines():
        if not raw.strip() or _SECTION.match(raw):
            continue
        toks: list[str] = []
        carry = ""
        for tok in raw.split():
            if not norm(tok):                       # lone punctuation ("-", "&"): glue to a neighbour
                if toks:
                    toks[-1] += " " + tok
                else:
                    carry = (carry + " " + tok).strip()
                continue
            toks.append((carry + " " + tok).strip() if carry else tok)
            carry = ""
        if toks:
            lines.append(toks)
    return lines


# ------------------------------------------------------------------ grouping ASR words into lines
_SENTENCE_END = tuple(".!?؟۔…")


def lines_from_asr(words: list[dict], max_words: int = 8, max_chars: int = 44, gap: float = 0.9) -> list[list[dict]]:
    lines: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        item = {"t": w["w"], "s": float(w["s"]), "e": float(w["e"])}
        if cur:
            chars = sum(len(x["t"]) + 1 for x in cur)
            pause = item["s"] - cur[-1]["e"]
            sentence_done = cur[-1]["t"].endswith(_SENTENCE_END) and len(cur) >= 3
            if pause >= gap or len(cur) >= max_words or chars + len(item["t"]) > max_chars or sentence_done:
                lines.append(cur)
                cur = []
        cur.append(item)
    if cur:
        lines.append(cur)
    return lines


# ------------------------------------------------------------------ sequence alignment
_MATCH_MIN = 60          # rapidfuzz ratio (0-100) needed to call two tokens "the same word"
_GAP = -0.6


def match_sequences(a: list[str], b: list[str]) -> list[tuple[int, int, float]]:
    """Global alignment of two normalised token lists. Returns [(i, j, similarity)] for matched pairs."""
    n, m = len(a), len(b)
    if not n or not m:
        return []
    sim = process.cdist(a, b, scorer=fuzz.ratio, dtype=np.uint8, workers=-1)
    gain = np.where(sim >= _MATCH_MIN, (sim.astype(np.float32) - 50.0) / 25.0, -1.5).tolist()

    F = [[0.0] * (m + 1) for _ in range(n + 1)]
    P = [bytearray(m + 1) for _ in range(n + 1)]       # 0 diagonal, 1 up (skip a[i]), 2 left (skip b[j])
    for i in range(1, n + 1):
        F[i][0] = i * _GAP
        P[i][0] = 1
    for j in range(1, m + 1):
        F[0][j] = j * _GAP
        P[0][j] = 2
    for i in range(1, n + 1):
        Fi, Fp, Pi, g = F[i], F[i - 1], P[i], gain[i - 1]
        for j in range(1, m + 1):
            d = Fp[j - 1] + g[j - 1]
            u = Fp[j] + _GAP
            l = Fi[j - 1] + _GAP
            if d >= u and d >= l:
                Fi[j] = d
            elif u >= l:
                Fi[j] = u
                Pi[j] = 1
            else:
                Fi[j] = l
                Pi[j] = 2
    pairs = []
    i, j = n, m
    while i > 0 or j > 0:
        p = P[i][j]
        if i > 0 and j > 0 and p == 0:
            if sim[i - 1, j - 1] >= _MATCH_MIN:
                pairs.append((i - 1, j - 1, float(sim[i - 1, j - 1]) / 100))
            i -= 1
            j -= 1
        elif i > 0 and (p == 1 or j == 0):
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


# ------------------------------------------------------------------ timing assignment
def _natural(w: dict) -> float:
    """Typical sung duration of a word, by length (seconds)."""
    return 0.22 + 0.06 * max(1, len(w["n"] or w["t"]))


def _spread(run: list[dict], left: Optional[dict], right: Optional[dict], t_left: Optional[float],
            t_right: Optional[float], lo: float, hi: float) -> None:
    """Assign times to a run of consecutive un-anchored words."""
    nat = [_natural(w) for w in run]
    total = sum(nat)

    if t_left is None:                                  # before the first anchor: end just before it
        t_right = hi if t_right is None else t_right
        start = max(lo, t_right - 0.1 - total)
        f = min(1.0, max(0.05, (t_right - 0.1 - start) / total))
        t = start
        for w, d in zip(run, nat):
            w["s"], w["e"] = t, t + d * f
            t += d * f
        return
    if t_right is None:                                 # after the last anchor: start just after it
        avail = max(0.0, hi - t_left - 0.1)
        f = min(1.0, avail / total) if total else 1.0
        t = t_left + 0.1
        for w, d in zip(run, nat):
            w["s"], w["e"] = t, t + d * f
            t += d * f
        return

    gap = max(0.0, t_right - t_left)
    if total >= gap:                                    # not enough room: squeeze
        f = gap / total if total else 0.0
        t = t_left
        for w, d in zip(run, nat):
            w["s"], w["e"] = t, t + d * f
            t += d * f
        return

    # Spare time: put it at line boundaries (where singers actually pause); stretch a lone line a bit.
    bounds = [k for k in range(1, len(run)) if run[k]["line"] != run[k - 1]["line"]]
    left_edge = left is not None and left["line"] != run[0]["line"]
    right_edge = right is not None and right["line"] != run[-1]["line"]
    weight_total = len(bounds) + int(left_edge) + int(right_edge)
    if weight_total == 0:
        f = min(gap / total, 2.5)
        t = t_left + (gap - f * total) / 2
        for w, d in zip(run, nat):
            w["s"], w["e"] = t, t + d * f
            t += d * f
        return
    unit = (gap - total) / weight_total
    t = t_left + (unit if left_edge else 0.0)
    bset = set(bounds)
    for k, (w, d) in enumerate(zip(run, nat)):
        if k in bset:
            t += unit
        w["s"], w["e"] = t, t + d
        t += d


def align_lyrics(lyric_lines: list[list[str]], asr_words: list[dict], duration: float,
                 span: Optional[tuple[float, float]] = None) -> tuple[list[list[dict]], dict]:
    flat: list[dict] = []
    for li, toks in enumerate(lyric_lines):
        for tok in toks:
            flat.append({"t": tok, "n": norm(tok), "line": li, "s": None, "e": None, "anchor": False})

    asr_norm = [norm(w["w"]) for w in asr_words]
    keep = [k for k, x in enumerate(asr_norm) if x]
    pairs = match_sequences([w["n"] for w in flat], [asr_norm[k] for k in keep])
    for i, j, _ in pairs:
        src = asr_words[keep[j]]
        flat[i]["s"], flat[i]["e"], flat[i]["anchor"] = float(src["s"]), float(src["e"]), True

    # time bounds for words outside the anchored region
    lo, hi = 0.0, max(duration, 1.0)
    if span:
        lo, hi = max(0.0, span[0]), min(hi, span[1])
    elif asr_words:
        lo, hi = max(0.0, float(asr_words[0]["s"]) - 0.2), min(hi, float(asr_words[-1]["e"]) + 0.2)
    if hi - lo < 1.0:
        lo, hi = 0.0, max(duration, 1.0)

    anchors = [k for k, w in enumerate(flat) if w["anchor"]]
    k = 0
    while k < len(flat):
        if flat[k]["anchor"]:
            k += 1
            continue
        a = k
        while k < len(flat) and not flat[k]["anchor"]:
            k += 1
        run = flat[a:k]
        left = flat[a - 1] if a > 0 else None
        right = flat[k] if k < len(flat) else None
        _spread(run, left, right, left["e"] if left else None, right["s"] if right else None, lo, hi)

    _tidy(flat, duration)

    out: list[list[dict]] = [[] for _ in lyric_lines]
    for w in flat:
        out[w["line"]].append({"t": w["t"], "s": round(w["s"], 3), "e": round(w["e"], 3)})
    stats = {"mode": "lyrics", "words": len(flat), "matched": round(len(anchors) / max(1, len(flat)), 3)}
    return out, stats


def _tidy(flat: list[dict], duration: float) -> None:
    """Monotonic times, minimum durations, and continuous sweeps inside a line."""
    prev_e = 0.0
    for idx, w in enumerate(flat):
        s = max(w["s"], prev_e)
        e = max(w["e"], s + 0.08)
        w["s"], w["e"] = s, e
        prev_e = e
    for idx in range(len(flat) - 1):
        cur, nxt = flat[idx], flat[idx + 1]
        if cur["line"] == nxt["line"] and 0 < nxt["s"] - cur["e"] <= 0.5:
            cur["e"] = nxt["s"]                          # no dead air between words of one line
    # Recognisers cut words short, and sung words are held longer: let the last word of each line ring on.
    for idx, w in enumerate(flat):
        if idx + 1 < len(flat) and flat[idx + 1]["line"] == w["line"]:
            continue
        nxt = flat[idx + 1]["s"] if idx + 1 < len(flat) else w["e"] + 1.0
        w["e"] += min(0.45, max(0.0, (nxt - w["e"] - 0.1) * 0.6))
    if duration:
        for w in flat:
            w["s"] = min(w["s"], duration - 0.1)
            w["e"] = min(max(w["e"], w["s"] + 0.05), duration)


# ------------------------------------------------------------------ public entry point
def build_lines(asr: dict, lyrics_text: str, duration: float,
                span: Optional[tuple[float, float]] = None) -> dict:
    """Return {"lines": [{"words": [{"t","s","e"}]}], "stats": {...}}."""
    words = asr.get("words", [])
    parsed = parse_lyrics(lyrics_text)
    if parsed:
        lines, stats = align_lyrics(parsed, words, duration, span)
    else:
        lines = lines_from_asr(words)
        _tidy_plain(lines, duration)
        stats = {"mode": "asr", "words": sum(len(l) for l in lines), "matched": 1.0 if lines else 0.0}
    return {"lines": [{"words": l} for l in lines if l], "stats": stats}


def _tidy_plain(lines: list[list[dict]], duration: float) -> None:
    flat = [dict(w, line=li, n="") for li, l in enumerate(lines) for w in l]
    _tidy(flat, duration)
    it = iter(flat)
    for l in lines:
        for w in l:
            f = next(it)
            w["s"], w["e"] = round(f["s"], 3), round(f["e"], 3)
