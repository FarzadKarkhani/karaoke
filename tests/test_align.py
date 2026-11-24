import random
from karaoke.align import norm, parse_lyrics, build_lines, lines_from_asr, match_sequences, guess_language


def fake_asr(tokens, start=5.0, per=0.45, drop=(), garble=(), skip_after=None):
    """Pretend recogniser: one word every `per` seconds."""
    words, t = [], start
    for i, tok in enumerate(tokens):
        if i not in drop:
            w = tok[:-1] + "x" if i in garble and len(tok) > 3 else tok
            words.append({"w": w, "s": round(t, 3), "e": round(t + per * 0.9, 3), "p": 0.9})
        t += per
    return {"words": words}


def all_words(res):
    return [w for l in res["lines"] for w in l["words"]]


def test_norm_persian_variants():
    assert norm("می‌روم") == norm("میروم")            # ZWNJ ignored
    assert norm("كتاب") == norm("کتاب")                # Arabic kaf -> Persian kaf
    assert norm("عشقِ") == norm("عشق")                 # diacritics dropped
    assert norm("۱۲۳") == "123" == norm("١٢٣")
    assert norm("سلام،") == norm("سلام")


def test_norm_turkish_and_english():
    assert norm("İstanbul") == norm("istanbul") == norm("ISTANBUL") == norm("Istanbul")
    assert norm("Güzel") == norm("guzel")
    assert norm("Don't!") == "dont"


def test_parse_lyrics_drops_markers_and_glues_punctuation():
    lines = parse_lyrics("[Chorus]\nI love you - so much\n\n  \nسلام  دنیا\n- \n")
    assert lines == [["I", "love", "you -", "so", "much"], ["سلام", "دنیا"]]


def test_match_handles_missing_and_garbled():
    a = [norm(x) for x in "the quick brown fox jumps over the lazy dog".split()]
    b = [norm(x) for x in "quick brwn fox over lazy dog".split()]
    pairs = match_sequences(a, b)
    got = {(i, j) for i, j, _ in pairs}
    assert (1, 0) in got and (2, 1) in got and (3, 2) in got and (5, 3) in got and (7, 4) in got and (8, 5) in got


def check_invariants(res, duration):
    ws = all_words(res)
    prev = -1
    for w in ws:
        assert 0 <= w["s"] < w["e"] <= duration + 1e-6
        assert w["s"] >= prev - 1e-6, "words must not go back in time"
        prev = w["e"]


def run_language(lyrics, duration=60.0):
    lines = parse_lyrics(lyrics)
    toks = [t for l in lines for t in l]
    n = len(toks)
    rnd = random.Random(1)
    drop = set(rnd.sample(range(n), n // 4))
    garble = set(rnd.sample(range(n), n // 5))
    res = build_lines(fake_asr(toks, drop=drop, garble=garble), lyrics, duration)
    check_invariants(res, duration)
    # text is exactly what the user wrote, line structure preserved
    assert [[w["t"] for w in l["words"]] for l in res["lines"]] == lines
    # anchored (unaffected) words land where the recogniser put them
    truth = {i: 5.0 + 0.45 * i for i in range(n)}
    ws = all_words(res)
    errs = [abs(ws[i]["s"] - truth[i]) for i in range(n)]
    assert sorted(errs)[len(errs) // 2] < 0.2, "median timing error should be small"
    assert res["stats"]["matched"] > 0.6
    return res


def test_persian():
    run_language("من عاشق تو هستم ای نازنین\nدر دل شب ستاره ها می‌درخشند\nبیا با من بمان تا صبح\nکه دنیا بی تو هیچ است و پوچ")


def test_turkish():
    run_language("Gözlerinde kayboldum bu gece\nİstanbul'un ışıkları yanıyor\nSeni bekledim yıllarca sessizce\nŞimdi gel de sarıl bana")


def test_english():
    run_language("I walk alone down this empty road\nThe stars above are guiding me home\nEvery step I take feels light as air\nAnd I know that you are waiting there")


def test_missed_verse_is_interpolated_inside_gap():
    lyrics = "one two three four\nfive six seven eight\nnine ten eleven twelve"
    toks = [t for l in parse_lyrics(lyrics) for t in l]
    asr = fake_asr(toks, drop=set(range(4, 8)))          # whole middle line missed
    res = build_lines(asr, lyrics, 40.0)
    check_invariants(res, 40.0)
    mid = res["lines"][1]["words"]
    assert res["lines"][0]["words"][-1]["e"] <= mid[0]["s"] + 1e-6
    assert mid[-1]["e"] <= res["lines"][2]["words"][0]["s"] + 1e-6


def test_no_match_at_all_still_gives_ordered_timings_in_span():
    res = build_lines({"words": []}, "alpha beta gamma\ndelta epsilon", 30.0, span=(4.0, 20.0))
    check_invariants(res, 30.0)
    ws = all_words(res)
    assert ws[0]["s"] >= 4.0 - 1e-6 and ws[-1]["e"] <= 20.0 + 1.0
    assert res["stats"]["matched"] == 0


def test_without_lyrics_groups_by_pause_and_length():
    words = [{"w": w, "s": 1 + i * 0.4, "e": 1.3 + i * 0.4, "p": 1} for i, w in enumerate("a b c d e f".split())]
    words += [{"w": "x", "s": 10.0, "e": 10.3, "p": 1}, {"w": "y", "s": 10.4, "e": 10.7, "p": 1}]
    res = build_lines({"words": words}, "", 20.0)
    assert [len(l["words"]) for l in res["lines"]] == [6, 2]
    check_invariants(res, 20.0)


def test_guess_language_from_lyrics():
    assert guess_language("من عاشق تو هستم ای نازنین\nدر دل شب ستاره ها") == "fa"
    assert guess_language("Gözlerinde kayboldum bu gece\nİstanbul'un ışıkları yanıyor") == "tr"
    assert guess_language("Şimdi gel de sarıl bana, güzel gün") == "tr"
    assert guess_language("I walk alone down this empty road") == "en"
    assert guess_language("hi") is None


def test_last_word_of_each_line_rings_on():
    words = [{"w": w, "s": s, "e": s + 0.4, "p": 1} for w, s in
             [("one", 5.0), ("two", 5.5), ("three", 6.0), ("four", 9.0), ("five", 9.5), ("six", 10.0)]]
    res = build_lines({"words": words}, "one two three\nfour five six", 40.0)
    end1, start2 = res["lines"][0]["words"][-1]["e"], res["lines"][1]["words"][0]["s"]
    assert end1 > 6.4 + 0.3                  # stretched beyond the raw recogniser end (6.4)
    assert end1 <= start2 - 0.1              # but never into the next line
    assert res["lines"][1]["words"][-1]["e"] > 10.4 + 0.3    # last line rings on too
    # words inside a line are not stretched past their neighbours
    assert res["lines"][0]["words"][0]["e"] <= res["lines"][0]["words"][1]["s"] + 1e-6
