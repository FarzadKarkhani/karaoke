/* Headless entry point used by the exporter (karaoke/render.py). Not part of the studio UI. */
(function () {
  'use strict';
  let renderer = null;
  let fps = 30;

  /** cfg: { style, lyrics, meta, spectrumUrl, fps } */
  window.initRender = async function (cfg) {
    const style = KaraokeStyle.resolveStyle(cfg.style, window.KARAOKE_PRESETS);
    const { w, h } = KaraokeStyle.outputSize(style.canvas);
    const canvas = document.getElementById('c');
    renderer = new KaraokeRenderer(canvas);
    renderer.setSize(w, h);
    renderer.setStyle(style);
    renderer.setMeta(cfg.meta || {});
    renderer.setLyrics(cfg.lyrics || { lines: [] });
    if (cfg.spectrumUrl) {
      const buf = await (await fetch(cfg.spectrumUrl)).arrayBuffer();
      renderer.setSpectrum(KaraokeStyle.parseSpectrum(buf));
    }
    await renderer.loadAssets();
    fps = cfg.fps || 30;
    return { width: w, height: h };
  };

  /** Render `count` frames starting at frame index `start`; returns base64 JPEGs. */
  window.renderFrames = function (start, count, quality) {
    const out = [];
    for (let i = 0; i < count; i++) {
      renderer.draw((start + i) / fps);
      const url = renderer.canvas.toDataURL('image/jpeg', quality || 0.95);
      out.push(url.slice(url.indexOf(',') + 1));
    }
    return out;
  };

  /** Single PNG, for thumbnails / tests. */
  window.renderPng = function (t) {
    renderer.draw(t);
    const url = renderer.canvas.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
  };
})();
