/* Karaoke renderer: a pure function of (state, time) drawn on a 2D canvas.
 *
 * The same code runs in the live preview (browser) and in the MP4 export (headless Chromium),
 * so what you see in the studio is exactly what ends up in the video.
 *
 * Text is shaped by the browser's own engine, so Persian/Arabic joining and Turkish letters are
 * correct. Each word is drawn as one shaped unit, which keeps cursive letters connected while the
 * highlight sweeps across it (right-to-left for Persian words).
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ defaults
  const DEFAULT_STYLE = {
    canvas: { aspect: '16:9', quality: 1080 },           // quality = length of the short side in px
    background: {
      type: 'gradient',                                   // gradient | solid | image
      color: '#0b0720', color2: '#2a0a4a', angle: 150,
      image: null, dim: 0.35, blur: 0, zoom: 0.06,        // zoom = slow push-in over the song
      glow: 0.7, glowColors: ['#7c3aed', '#06b6d4', '#ec4899'],
      pulse: 0.6,                                         // glow breathes with the bass
      vignette: 0.4,
    },
    lyrics: {
      font: 'Vazirmatn', weight: 700, size: 84, lineHeight: 1.28,
      color: '#ffffff', highlight: '#ffd447',
      otherOpacity: 0.4, linesBefore: 1, linesAfter: 2,
      outline: 0, outlineColor: '#000000',
      shadow: 0.5, glow: 0.5,
      uppercase: false, sweep: 'wipe',                    // wipe | instant
      pop: 0.05, maxWidth: 0.86, y: 0.5,
    },
    visualizer: {
      type: 'bars',                                       // bars | mirror | wave | circle | none
      color: '#ffd447', color2: '#ec4899', opacity: 0.85,
      height: 0.16, position: 'bottom', bars: 48, thickness: 0.62, sensitivity: 1,
    },
    title: { show: true, position: 'top-left', color: '#ffffff', size: 36, intro: true, introSeconds: 4.5 },
    logo: { url: null, position: 'top-right', size: 0.1, opacity: 1, margin: 0.04 },
    footer: { text: '', position: 'bottom-center', color: '#ffffff', size: 30, opacity: 0.8 },
    progress: { show: true, color: '#ffd447', height: 6 },
    countdown: { show: true, minGap: 5, dots: 3 },
    customFonts: [],                                      // [{family, url}] uploaded brand fonts
  };

  const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] };

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
      out[k] = isObj(over[k]) && isObj(base ? base[k] : null) ? deepMerge(base[k], over[k]) : over[k];
    }
    return out;
  }
  /** Resolve a stored style (optionally "preset" + overrides) into a complete style object. */
  function resolveStyle(partial, presets) {
    let s = deepMerge(DEFAULT_STYLE, {});
    if (partial && partial.preset && presets) {
      const p = presets.find((x) => x.id === partial.preset);
      if (p) s = deepMerge(s, p.style);
    }
    if (partial) { const { preset, ...rest } = partial; s = deepMerge(s, rest); }
    return s;
  }
  /** Output pixel size for an aspect + quality (short side). Always even numbers (H.264). */
  function outputSize(canvasStyle) {
    const [aw, ah] = ASPECTS[canvasStyle.aspect] || ASPECTS['16:9'];
    const q = canvasStyle.quality || 1080;
    const k = q / Math.min(aw, ah);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return { w: even(aw * k), h: even(ah * k) };
  }

  // ------------------------------------------------------------------ small helpers
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  const LATIN_RE = /[A-Za-zÀ-ɏ]/;

  function lineIsRTL(texts) {
    let r = 0, l = 0;
    for (const ch of texts.join(' ')) { if (RTL_RE.test(ch)) r++; else if (LATIN_RE.test(ch)) l++; }
    return r > 0 && r >= l;
  }
  /** Paragraph direction by first strong character (like dir="auto"): right for titles/footers/handles. */
  function firstStrongDir(text) {
    for (const ch of String(text || '')) { if (RTL_RE.test(ch)) return 'rtl'; if (LATIN_RE.test(ch)) return 'ltr'; }
    return 'ltr';
  }
  function hexToRgb(hex) {
    let h = String(hex || '#fff').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  function bisectRight(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

  function fontStack(family) {
    const list = [family, 'Vazirmatn', 'Noto Naskh Arabic', 'system-ui', 'sans-serif'];
    return [...new Set(list.filter(Boolean))].map((f) => (/^(system-ui|sans-serif|serif)$/.test(f) ? f : `"${f}"`)).join(', ');
  }

  function parseSpectrum(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x3150534b) throw new Error('bad spectrum file');   // "KSP1"
    const bands = dv.getUint16(4, true), fps = dv.getUint16(6, true), frames = dv.getUint32(8, true);
    return { bands, fps, frames, data: new Uint8Array(buf, 12, bands * frames) };
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not load image ' + url));
      img.src = url;
    });
  }

  // ------------------------------------------------------------------ renderer
  class KaraokeRenderer {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.W = 1920; this.H = 1080;
      this.style = resolveStyle({});
      this.meta = { title: '', artist: '', duration: 0, language: 'en' };
      this.lines = [];
      this.offset = 0;
      this.spectrum = null;
      this.images = { bg: null, logo: null };
      this._bands = new Float32Array(64);
      this._dirty = true;
      this._registeredFonts = new Set();
    }

    /** Logical drawing size (output resolution). `pixelW/H` is the real canvas bitmap size. */
    setSize(W, H, pixelW, pixelH) {
      this.W = W; this.H = H;
      this.canvas.width = pixelW || W; this.canvas.height = pixelH || H;
      this._dirty = true;
      this._bgCache = null;
    }
    get u() { return Math.min(this.W, this.H) / 1080; }

    setStyle(style) { this.style = style; this._dirty = true; this._bgCache = null; }
    setMeta(meta) { this.meta = Object.assign({}, this.meta, meta); }
    setSpectrum(sp) { this.spectrum = sp; }
    setLyrics(lyrics) {
      this.offset = lyrics.offset || 0;
      this.lines = (lyrics.lines || []).filter((l) => l.words && l.words.length);
      this._dirty = true;
    }

    // ---------------------------------------------------------------- resources
    async loadAssets() {
      const s = this.style;
      const jobs = [];
      for (const f of s.customFonts || []) {
        if (this._registeredFonts.has(f.family + f.url)) continue;
        this._registeredFonts.add(f.family + f.url);
        jobs.push(new FontFace(f.family, `url(${f.url})`).load().then((ff) => document.fonts.add(ff)).catch(() => {}));
      }
      await Promise.all(jobs);

      const sample = this.lines.map((l) => l.words.map((w) => w.t).join(' ')).join(' ') +
        ' ' + this.meta.title + ' ' + this.meta.artist + ' ' + (s.footer.text || '') + ' ABCabc ğşİıçö سلام';
      const fams = [...new Set([s.lyrics.font, 'Vazirmatn', 'Noto Naskh Arabic'])];
      const weights = [...new Set([400, 700, s.lyrics.weight])];
      await Promise.all(fams.flatMap((f) => weights.map((w) => document.fonts.load(`${w} 40px "${f}"`, sample).catch(() => []))));

      const bgUrl = s.background.type === 'image' ? s.background.image : null;
      const logoUrl = s.logo.url;
      if (bgUrl !== this._bgUrl) { this._bgUrl = bgUrl; this.images.bg = bgUrl ? await loadImage(bgUrl).catch(() => null) : null; this._bgCache = null; }
      if (logoUrl !== this._logoUrl) { this._logoUrl = logoUrl; this.images.logo = logoUrl ? await loadImage(logoUrl).catch(() => null) : null; }
      this._dirty = true;
    }

    // ---------------------------------------------------------------- layout
    _transformText(t) {
      const L = this.style.lyrics;
      if (!L.uppercase) return t;
      return this.meta.language === 'tr' ? t.toLocaleUpperCase('tr-TR') : t.toLocaleUpperCase();
    }

    _ensureLayout() {
      if (!this._dirty) return;
      this._dirty = false;

      const ctx = this.ctx, L = this.style.lyrics, u = this.u;
      const size = L.size * u;
      const step = size * L.lineHeight;
      const maxW = this.W * L.maxWidth;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `${L.weight} ${size}px ${fontStack(L.font)}`;
      ctx.direction = 'ltr';
      const spaceW = ctx.measureText(' ').width * 1.1 + size * 0.06;

      this.layout = this.lines.map((line) => {
        const texts = line.words.map((w) => this._transformText(w.t));
        const rtl = lineIsRTL(texts);
        const items = texts.map((text, i) => {
          const wordRtl = RTL_RE.test(text) ? true : (LATIN_RE.test(text) ? false : rtl);
          ctx.direction = wordRtl ? 'rtl' : 'ltr';
          return { text, rtl: wordRtl, w: ctx.measureText(text).width, i };
        });
        const rows = wrapBalanced(items, spaceW, maxW);
        rows.forEach((row) => {
          const total = row.reduce((a, it) => a + it.w, 0) + spaceW * (row.length - 1);
          row.width = total;
          let x = 0;
          row.forEach((it) => {           // x = centre of the word relative to the row centre
            it.cx = rtl ? total / 2 - x - it.w / 2 : -total / 2 + x + it.w / 2;
            x += it.w + spaceW;
          });
        });
        return { rtl, rows, height: rows.length * step };
      });
      ctx.restore();

      // timeline
      const n = this.lines.length;
      this.starts = this.lines.map((l) => l.words[0].s + this.offset);
      this.ends = this.lines.map((l) => l.words[l.words.length - 1].e + this.offset);
      const gap = size * 0.42;
      this.centers = []; this.blockH = [];
      let y = 0;
      for (let k = 0; k < n; k++) {
        const h = this.layout[k].height;
        this.centers.push(y + h / 2);
        this.blockH.push(h);
        y += h + gap;
      }
      this.avgStep = n ? (this.centers[n - 1] - this.centers[0]) / Math.max(1, n - 1) || step * 1.3 : step * 1.3;
      this.scrollStart = [];
      for (let k = 0; k < n; k++) {
        if (k === 0) { this.scrollStart.push(-1e9); continue; }
        const cd = this.style.countdown;
        const bigGap = cd.show && this.starts[k] - this.ends[k - 1] >= cd.minGap;
        let s = this.starts[k] - (bigGap ? cd.dots + 1.4 : 0.6);
        s = Math.max(s, this.ends[k - 1] + (bigGap ? 0.3 : -0.1));
        s = Math.min(s, this.starts[k] - 0.1);
        s = Math.max(s, this.scrollStart[k - 1] + 0.01);
        this.scrollStart.push(s);
      }
      this.size = size; this.step = step;
    }

    _focus(t) {
      const k = bisectRight(this.scrollStart, t) - 1;
      if (k <= 0) return this.centers[0] || 0;
      const p = clamp((t - this.scrollStart[k]) / 0.5);
      return lerp(this.centers[k - 1], this.centers[k], easeInOut(p));
    }

    // ---------------------------------------------------------------- audio data
    bandsAt(t) {
      const out = this._bands, sp = this.spectrum;
      if (!sp) { out.fill(0); return out; }
      if (out.length !== sp.bands) this._bands = new Float32Array(sp.bands);
      const o = this._bands;
      const f = clamp(t, 0, (sp.frames - 1) / sp.fps) * sp.fps;
      const i0 = Math.floor(f), i1 = Math.min(sp.frames - 1, i0 + 1), fr = f - i0;
      const a = i0 * sp.bands, b = i1 * sp.bands;
      for (let k = 0; k < sp.bands; k++) o[k] = lerp(sp.data[a + k], sp.data[b + k], fr) / 255;
      return o;
    }
    _bass(bands) { let s = 0; const n = Math.min(10, bands.length); for (let i = 0; i < n; i++) s += bands[i]; return s / n; }

    // ---------------------------------------------------------------- main entry
    draw(t) {
      const ctx = this.ctx, s = this.style;
      this._ensureLayout();
      ctx.setTransform(this.canvas.width / this.W, 0, 0, this.canvas.height / this.H, 0, 0);
      ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.globalCompositeOperation = 'source-over';
      const bands = this.bandsAt(t);
      const bass = this._bass(bands);

      this._drawBackground(t, bass);
      if (s.visualizer.type === 'circle') this._drawVisualizer(t, bands);

      const intro = this._introAlpha(t);
      if (this.lines.length && intro < 1) {
        ctx.globalAlpha = 1 - intro;
        this._drawLyrics(t);
        ctx.globalAlpha = 1;
      }
      if (s.visualizer.type !== 'circle') this._drawVisualizer(t, bands);
      this._drawOverlays(t, intro);
    }

    // ---------------------------------------------------------------- background
    _drawBackground(t, bass) {
      const ctx = this.ctx, b = this.style.background, W = this.W, H = this.H;
      const dur = Math.max(1, this.meta.duration || 1);
      if (b.type === 'image' && this.images.bg) {
        this._drawBgImage(t / dur);
      } else if (b.type === 'solid') {
        ctx.fillStyle = b.color; ctx.fillRect(0, 0, W, H);
      } else {
        const a = (b.angle || 0) * Math.PI / 180;
        const vx = Math.sin(a), vy = -Math.cos(a);
        const half = (Math.abs(W * vx) + Math.abs(H * vy)) / 2;
        const g = ctx.createLinearGradient(W / 2 - vx * half, H / 2 - vy * half, W / 2 + vx * half, H / 2 + vy * half);
        g.addColorStop(0, b.color); g.addColorStop(1, b.color2);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }

      if (b.glow > 0 && b.glowColors && b.glowColors.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const base = Math.max(W, H);
        b.glowColors.forEach((c, i) => {
          const ph = i * 2.1;
          const cx = W * (0.5 + 0.34 * Math.sin(t * 0.11 + ph)), cy = H * (0.5 + 0.30 * Math.cos(t * 0.09 + ph * 1.3));
          const r = base * (0.42 + 0.06 * Math.sin(t * 0.17 + ph)) * (1 + b.pulse * bass * 0.35);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          const alpha = clamp(b.glow * 0.42 * (1 + b.pulse * bass * 0.9), 0, 1);
          g.addColorStop(0, rgba(c, alpha)); g.addColorStop(1, rgba(c, 0));
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        });
        ctx.restore();
      }
      if (b.vignette > 0) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${clamp(b.vignette * 0.9, 0, 1)})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
    }

    _drawBgImage(progress) {
      const ctx = this.ctx, b = this.style.background, img = this.images.bg, W = this.W, H = this.H;
      const z = Math.max(0, b.zoom || 0);
      if (!this._bgCache || this._bgCache.key !== `${W}x${H}|${b.blur}|${b.dim}|${z}|${this._bgUrl}`) {
        const pad = 1 + z;
        const cw = Math.round(W * pad), ch = Math.round(H * pad);
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const cc = c.getContext('2d');
        const k = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
        const iw = img.naturalWidth * k, ih = img.naturalHeight * k;
        const blur = (b.blur || 0) * this.u;
        if (blur > 0) cc.filter = `blur(${blur}px)`;
        const m = blur * 2;                                   // overdraw so blurred edges stay filled
        cc.drawImage(img, (cw - iw) / 2 - m, (ch - ih) / 2 - m, iw + 2 * m, ih + 2 * m);
        cc.filter = 'none';
        if (b.dim > 0) { cc.fillStyle = `rgba(0,0,0,${b.dim})`; cc.fillRect(0, 0, cw, ch); }
        this._bgCache = { key: `${W}x${H}|${b.blur}|${b.dim}|${z}|${this._bgUrl}`, canvas: c, cw, ch };
      }
      const { canvas: c, cw, ch } = this._bgCache;
      const zoom = 1 + z * clamp(progress);
      const sw = cw / (1 + z) * (1 + z) / zoom, sh = ch / (1 + z) * (1 + z) / zoom;
      const sx = (cw - sw) / 2, sy = (ch - sh) / 2;
      ctx.drawImage(c, sx, sy, sw, sh, 0, 0, W, H);
    }

    // ---------------------------------------------------------------- visualizer
    _resample(bands, n) {
      const out = new Float32Array(n), m = bands.length;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * m, b = ((i + 1) / n) * m;
        let sum = 0, cnt = 0;
        for (let k = Math.floor(a); k < Math.min(m, Math.ceil(b)); k++) { sum += bands[k]; cnt++; }
        out[i] = cnt ? sum / cnt : 0;
      }
      return out;
    }

    _drawVisualizer(t, bands) {
      const v = this.style.visualizer;
      if (!v || v.type === 'none' || !this.spectrum) return;
      const ctx = this.ctx, W = this.W, H = this.H, u = this.u;
      const sens = v.sensitivity || 1;
      const margin = 0.06 * W;
      const areaH = H * v.height;
      const vals = this._resample(bands, Math.max(8, Math.round(v.bars)));
      const n = vals.length;
      ctx.save();
      ctx.globalAlpha *= v.opacity;

      const rs = this._reserves();
      const baseY = v.position === 'top' ? Math.max(H * 0.05, rs.top + H * 0.015)
        : v.position === 'center' ? H / 2 : H - Math.max(H * 0.05, rs.bottom + H * 0.015);
      const dir = v.position === 'top' ? 1 : -1;               // growth direction

      // centred bars grow both ways, so keep their middle half a bar-height inside the safe area
      const mid = v.position === 'center' ? baseY : baseY + dir * areaH / 2;
      if (v.type === 'bars' || v.type === 'mirror') {
        const slot = (W - 2 * margin) / n, bw = slot * v.thickness;
        const g = v.type === 'mirror' ? ctx.createLinearGradient(0, mid - areaH / 2, 0, mid + areaH / 2) : ctx.createLinearGradient(0, baseY, 0, baseY + dir * areaH);
        g.addColorStop(0, v.color); g.addColorStop(1, v.color2);
        ctx.fillStyle = g;
        for (let i = 0; i < n; i++) {
          const h = Math.max(4 * u, clamp(vals[i] * sens) * areaH);
          const x = margin + i * slot + (slot - bw) / 2;
          if (v.type === 'mirror') this._rrect(x, mid - h / 2, bw, h, bw / 2);
          else this._rrect(x, dir < 0 ? baseY - h : baseY, bw, h, Math.min(bw / 2, 10 * u));
        }
      } else if (v.type === 'wave') {
        const g = ctx.createLinearGradient(0, baseY, 0, baseY + dir * areaH);
        g.addColorStop(0, rgba(v.color, 0.05)); g.addColorStop(1, rgba(v.color2, 0.55));
        const pts = [];
        for (let i = 0; i < n; i++) pts.push([margin + (i / (n - 1)) * (W - 2 * margin), baseY + dir * clamp(vals[i] * sens) * areaH]);
        const curve = () => {                                   // smooth line through the band levels
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
            ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
          }
          ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
        };
        ctx.beginPath(); ctx.moveTo(margin, baseY); ctx.lineTo(pts[0][0], pts[0][1]);
        curve(); ctx.lineTo(W - margin, baseY); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); curve();                                // outline only the curve, not the baseline
        ctx.lineWidth = 3 * u; ctx.strokeStyle = v.color; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
      } else if (v.type === 'circle') {
        const cx = W / 2, cy = this._band().cy;
        const r0 = Math.min(W, H) * 0.2, rLen = Math.min(W, H) * v.height * 1.6;
        const count = n * 2;
        ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, (2 * Math.PI * r0 / count) * v.thickness);
        const g = ctx.createLinearGradient(cx - r0, cy - r0, cx + r0, cy + r0);
        g.addColorStop(0, v.color); g.addColorStop(1, v.color2);
        ctx.strokeStyle = g;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 - Math.PI / 2;
          const val = vals[i < n ? i : count - 1 - i];
          const len = Math.max(3 * u, clamp(val * sens) * rLen);
          ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
          ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    /** Vertical band the lyrics may use: between title/logo and the visualizer/footer. `cy` honours lyrics.y. */
    _band() {
      const s = this.style, H = this.H, v = s.visualizer, rs = this._reserves();
      let top = rs.top, bottom = H - rs.bottom;
      if (v.type !== 'none' && v.type !== 'circle' && this.spectrum) {
        const areaH = H * v.height, pad = H * 0.012;
        if (v.position === 'bottom') bottom = Math.min(bottom, H - Math.max(H * 0.05, rs.bottom + H * 0.015) - areaH - pad);
        else if (v.position === 'top') top = Math.max(top, Math.max(H * 0.05, rs.top + H * 0.015) + areaH + pad);
      }
      if (bottom - top < H * 0.3) { top = rs.top; bottom = H - rs.bottom; }
      return { top, bottom, cy: top + (bottom - top) * s.lyrics.y };
    }

    /** Space taken by title / logo / footer / progress bar at the top and bottom edges. */
    _reserves() {
      const s = this.style, u = this.u, W = this.W, H = this.H;
      const margin = 0.045 * Math.min(W, H) + 10 * u;
      let top = 0, bottom = s.progress.show ? s.progress.height * u : 0;
      const add = (pos, hh) => { if (pos.startsWith('top')) top = Math.max(top, margin + hh); else bottom = Math.max(bottom, margin + hh); };
      if (s.title.show && s.title.size > 0 && (this.meta.title || this.meta.artist)) add(s.title.position, s.title.size * u * 1.9);
      const logo = this.images.logo;
      if (logo && s.logo.url) add(s.logo.position, W * s.logo.size * (logo.naturalHeight / logo.naturalWidth));
      if (s.footer.text) add(s.footer.position, s.footer.size * u * 1.2);
      return { top, bottom };
    }

    _rrect(x, y, w, h, r) {
      const ctx = this.ctx;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
      ctx.fill();
    }

    // ---------------------------------------------------------------- lyrics
    _drawLyrics(t) {
      const L = this.style.lyrics, ctx = this.ctx, n = this.lines.length;
      if (!n) return;
      const S = this._focus(t);
      const band = this._band(), cy = band.cy;
      const spacing = this.avgStep || this.step * 1.3;
      const lo = Math.max(0, Math.floor(bisectRight(this.scrollStart, t) - 1) - (L.linesBefore + 3));
      const hi = Math.min(n - 1, lo + L.linesBefore + L.linesAfter + 8);

      for (let k = lo; k <= hi; k++) {
        const d = this.centers[k] - S;                       // + = below focus (upcoming)
        const away = d / spacing;
        const limit = away >= 0 ? L.linesAfter : L.linesBefore;
        const edge = clamp(limit + 1 - Math.abs(away));
        if (edge <= 0) continue;
        const f = clamp(1 - Math.abs(away));
        const scale = lerp(0.84, 1, f);
        const yy = cy + d * scale, half = this.blockH[k] * scale / 2;
        const over = Math.max(yy + half - band.bottom, band.top - (yy - half), 0);          // pixels intruding on the visualizer/footer
        const fit = lerp(clamp(1 - over / (this.step * 0.6)), 1, f);                         // the active line never fades
        const alpha = lerp(L.otherOpacity, 1, f) * edge * fit;
        if (alpha > 0.003) this._drawLine(k, yy, alpha, scale, t);
      }
      if (this.style.countdown.show) this._drawCountdown(t, S, cy);
    }

    _drawLine(k, y, alpha, scale, t) {
      const ctx = this.ctx, lay = this.layout[k], words = this.lines[k].words, step = this.step;
      ctx.save();
      ctx.translate(this.W / 2, y);
      ctx.scale(scale, scale);
      ctx.globalAlpha *= alpha;
      const top = -lay.height / 2;
      lay.rows.forEach((row, r) => {
        const ry = top + (r + 0.5) * step;
        for (const it of row) {
          const w = words[it.i];
          const dur = Math.max(0.05, w.e - w.s);
          const ts = t - this.offset;
          let p = clamp((ts - w.s) / dur);
          if (this.style.lyrics.sweep === 'instant') p = ts >= w.s ? 1 : 0;
          this._drawWord(it, it.cx, ry, p);
        }
      });
      ctx.restore();
    }

    _drawWord(it, cx, cy, p) {
      const ctx = this.ctx, L = this.style.lyrics, u = this.u, size = this.size;
      ctx.save();
      const pop = L.pop && p > 0 && p < 1 ? 1 + L.pop * Math.sin(Math.PI * p) : 1;
      ctx.translate(cx, cy);
      if (pop !== 1) ctx.scale(pop, pop);
      ctx.font = `${L.weight} ${size}px ${fontStack(L.font)}`;
      ctx.direction = it.rtl ? 'rtl' : 'ltr';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const text = it.text, w = it.w;

      // base layer: drop shadow + outline + unsung colour
      if (L.shadow > 0) {
        ctx.shadowColor = `rgba(0,0,0,${0.55 * L.shadow})`;
        ctx.shadowBlur = size * 0.22 * L.shadow; ctx.shadowOffsetY = size * 0.05 * L.shadow;
      }
      if (L.outline > 0) { ctx.lineWidth = L.outline * u * 2; ctx.strokeStyle = L.outlineColor; ctx.strokeText(text, 0, 0); }
      ctx.fillStyle = L.color; ctx.fillText(text, 0, 0);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

      // sung layer: highlight colour, clipped to the swept part (right-to-left for RTL words)
      if (p > 0) {
        ctx.save();
        const pad = size;                                    // room for glow / ascenders / descenders
        ctx.beginPath();
        if (p >= 1) ctx.rect(-w / 2 - pad, -pad, w + 2 * pad, 2 * pad);
        else if (it.rtl) ctx.rect(w / 2 - w * p, -pad, w * p + pad, 2 * pad);
        else ctx.rect(-w / 2 - pad, -pad, w * p + pad, 2 * pad);
        ctx.clip();
        if (L.glow > 0) { ctx.shadowColor = rgba(L.highlight, 0.9 * L.glow); ctx.shadowBlur = size * 0.35 * L.glow; }
        if (L.outline > 0) { ctx.lineWidth = L.outline * u * 2; ctx.strokeStyle = L.outlineColor; ctx.strokeText(text, 0, 0); }
        ctx.fillStyle = L.highlight; ctx.fillText(text, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }

    _drawCountdown(t, S, cy) {
      const c = this.style.countdown, ctx = this.ctx, L = this.style.lyrics;
      const n = this.lines.length;
      const k = bisectRight(this.starts, t);                 // next line that has not started
      if (k >= n) return;
      const prevEnd = k > 0 ? this.ends[k - 1] : 0;
      const gap = this.starts[k] - prevEnd;
      if (gap < c.minGap) return;
      const until = this.starts[k] - t;
      if (until > c.dots + 0.4 || t < prevEnd) return;
      const size = this.size, r = size * 0.13;
      const d = this.centers[k] - S;
      const y = cy + d - this.blockH[k] / 2 - size * 0.21;      // inside the gap above the line
      const fade = clamp(until / 0.35) * clamp((c.dots + 0.4 - until) / 0.3);
      ctx.save();
      ctx.globalAlpha *= fade;
      for (let i = 0; i < c.dots; i++) {
        const lit = until <= c.dots - i;                     // dot i lights 3,2,1 s before the line
        const age = clamp((c.dots - i - until) / 0.35);
        const x = this.W / 2 + (i - (c.dots - 1) / 2) * r * 3.2;
        ctx.beginPath(); ctx.arc(x, y, r * (lit ? 1 + 0.25 * (1 - age) : 0.8), 0, Math.PI * 2);
        ctx.fillStyle = lit ? L.highlight : rgba(L.color, 0.35);
        if (lit) { ctx.shadowColor = rgba(L.highlight, 0.8); ctx.shadowBlur = r * 1.5; }
        ctx.fill(); ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    // ---------------------------------------------------------------- overlays
    _introAlpha(t) {
      const T = this.style.title;
      if (!T.show || !T.intro || !(this.meta.title || this.meta.artist)) return 0;
      const first = this.lines.length ? this.starts[0] : 1e9;
      const end = Math.min(T.introSeconds, first - 3.4);
      if (end < 1.6) return 0;
      return clamp(Math.min((t - 0.15) / 0.6, (end - t) / 0.7));
    }

    _anchor(pos, w, h, margin) {
      const [v, hz] = pos.split('-');
      const x = hz === 'left' ? margin : hz === 'right' ? this.W - margin - w : (this.W - w) / 2;
      const y = v === 'top' ? margin : this.H - margin - h;
      return [x, y];
    }

    _drawOverlays(t, introAlpha) {
      const ctx = this.ctx, s = this.style, u = this.u, W = this.W, H = this.H;
      const margin = 0.045 * Math.min(W, H) + 10 * u;

      // intro card
      if (introAlpha > 0.001) {
        ctx.save();
        ctx.globalAlpha = introAlpha;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const ts = s.lyrics.size * u * 1.15;
        ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = ts * 0.25;
        ctx.direction = firstStrongDir(this.meta.title);
        ctx.font = `700 ${ts}px ${fontStack(s.lyrics.font)}`;
        ctx.fillStyle = s.title.color;
        this._fitText(this.meta.title, W / 2, H * 0.44, W * 0.86);
        ctx.shadowBlur = 0;
        ctx.direction = firstStrongDir(this.meta.artist);
        ctx.font = `400 ${ts * 0.5}px ${fontStack(s.lyrics.font)}`;
        ctx.fillStyle = s.lyrics.highlight;
        this._fitText(this.meta.artist, W / 2, H * 0.44 + ts * 0.95, W * 0.8);
        ctx.restore();
      }

      // small title in the corner (hidden while the intro card is up)
      if (s.title.show && (this.meta.title || this.meta.artist) && introAlpha < 0.01 && s.title.size > 0) {
        const ts = s.title.size * u;
        ctx.save();
        ctx.direction = firstStrongDir(this.meta.title);
        ctx.font = `700 ${ts}px ${fontStack(s.lyrics.font)}`;
        const w1 = ctx.measureText(this.meta.title).width;
        ctx.direction = firstStrongDir(this.meta.artist);
        ctx.font = `400 ${ts * 0.78}px ${fontStack(s.lyrics.font)}`;
        const w2 = ctx.measureText(this.meta.artist).width;
        const bw = Math.min(W * 0.5, Math.max(w1, w2)), bh = ts * 1.9;
        const [x, y] = this._anchor(s.title.position, bw, bh, margin);
        const align = s.title.position.endsWith('right') ? 'right' : s.title.position.endsWith('center') ? 'center' : 'left';
        const ax = align === 'left' ? x : align === 'right' ? x + bw : x + bw / 2;
        ctx.textAlign = align; ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = ts * 0.4;
        ctx.fillStyle = s.title.color; ctx.font = `700 ${ts}px ${fontStack(s.lyrics.font)}`;
        ctx.direction = firstStrongDir(this.meta.title);
        ctx.fillText(this.meta.title, ax, y, bw);
        ctx.direction = firstStrongDir(this.meta.artist);
        ctx.fillStyle = rgba(s.title.color, 0.75); ctx.font = `400 ${ts * 0.78}px ${fontStack(s.lyrics.font)}`;
        ctx.fillText(this.meta.artist, ax, y + ts * 1.2, bw);
        ctx.restore();
      }

      // logo
      const logo = this.images.logo;
      if (logo && s.logo.url) {
        const lw = W * s.logo.size, lh = lw * (logo.naturalHeight / logo.naturalWidth);
        const [x, y] = this._anchor(s.logo.position, lw, lh, s.logo.margin * Math.min(W, H) + 6 * u);
        ctx.save(); ctx.globalAlpha = s.logo.opacity; ctx.drawImage(logo, x, y, lw, lh); ctx.restore();
      }

      // footer / handle
      if (s.footer.text) {
        const fs = s.footer.size * u;
        ctx.save();
        ctx.direction = firstStrongDir(s.footer.text);
        ctx.font = `700 ${fs}px ${fontStack(s.lyrics.font)}`;
        const fw = Math.min(W * 0.8, ctx.measureText(s.footer.text).width);
        const progressPad = s.progress.show ? s.progress.height * u : 0;
        const [x, y] = this._anchor(s.footer.position, fw, fs, margin + (s.footer.position.startsWith('bottom') ? progressPad : 0));
        ctx.globalAlpha = s.footer.opacity; ctx.fillStyle = s.footer.color;
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = fs * 0.3;
        ctx.fillText(s.footer.text, x, y, fw);
        ctx.restore();
      }

      // progress bar
      if (s.progress.show && this.meta.duration) {
        const ph = s.progress.height * u;
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(0, H - ph, W, ph);
        ctx.fillStyle = s.progress.color; ctx.fillRect(0, H - ph, W * clamp(t / this.meta.duration), ph);
        ctx.restore();
      }
    }

    _fitText(text, x, y, maxW) { this.ctx.fillText(text, x, y, maxW); }
  }

  /** Greedy wrap, then rebalance so rows are similar in width (no orphan last word). */
  function wrapBalanced(items, spaceW, maxW) {
    const greedy = (limit) => {
      const rows = []; let row = [], w = 0;
      for (const it of items) {
        const add = (row.length ? spaceW : 0) + it.w;
        if (row.length && w + add > limit) { rows.push(row); row = []; w = 0; }
        w += (row.length ? spaceW : 0) + it.w; row.push(it);
      }
      if (row.length) rows.push(row);
      return rows;
    };
    let rows = greedy(maxW);
    if (rows.length > 1) {
      const target = rows.length;
      let lo = Math.max(...items.map((i) => i.w)), hi = maxW;
      for (let n = 0; n < 14; n++) { const mid = (lo + hi) / 2; if (greedy(mid).length <= target) hi = mid; else lo = mid; }
      rows = greedy(hi);
    }
    return rows;
  }

  global.KaraokeRenderer = KaraokeRenderer;
  global.KaraokeStyle = { DEFAULT_STYLE, ASPECTS, resolveStyle, outputSize, deepMerge, parseSpectrum, fontStack, lineIsRTL, RTL_RE };
})(typeof window !== 'undefined' ? window : globalThis);
