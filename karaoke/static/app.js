/* Karaoke Studio UI (vanilla JS, no build step). */
(() => {
  'use strict';
  const KS = window.KaraokeStyle;
  const BUILTIN = window.KARAOKE_PRESETS;

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected']);
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  }
  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch (_) {} throw new Error(typeof m === 'string' ? m : JSON.stringify(m)); }
    return r.json();
  }
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); let c = o; for (const k of ks) c = c[k] = c[k] || {}; c[last] = v; }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
  const fmtShort = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const debounce = (fn, ms) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; };
  function toast(msg, ms = 2600) { const t = h('div', { class: 'toast', text: msg }); document.body.append(t); setTimeout(() => t.remove(), ms); }
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const S = {                                   // app state
    cfg: null, saved: [], job: null, style: null, lyrics: null, renderer: null, controls: [],
    exportOpts: Object.assign({ fps: 30, quality: 'standard', guide: 0 }, lsGet('karaoke.export', {})),
    poll: null, raf: 0, needDraw: true, lastT: -1, activeLine: -1, render: null, renderPoll: null,
  };

  // ------------------------------------------------------------------ routing
  const views = { home: $('#viewHome'), progress: $('#viewProgress'), studio: $('#viewStudio') };
  function show(name) {
    for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
    $('#projTitle').hidden = name !== 'studio';
    $('#btnHome').hidden = name === 'home';
  }
  $('#btnHome').onclick = () => { location.hash = '#/'; };
  window.addEventListener('hashchange', route);

  function leaveStudio() {
    cancelAnimationFrame(S.raf); S.raf = 0;
    clearTimeout(S.poll); clearTimeout(S.renderPoll); clearTimeout(H.timer);
    for (const id of ['aInst', 'aVoc']) { const a = $('#' + id); a.pause(); a.removeAttribute('src'); a.load(); }
    S.job = null;
  }
  async function route() {
    leaveStudio();
    const m = location.hash.match(/^#\/p\/([0-9a-f]{12})$/);
    if (m) return openProject(m[1]);
    showHome();
  }

  // ------------------------------------------------------------------ home
  const H = { files: [], lang: 'auto', list: [], usage: null, showNew: false, timer: 0 };
  const LANG_NAME = { fa: 'Persian', en: 'English', tr: 'Turkish' };
  const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');

  async function showHome() {
    clearTimeout(H.timer);
    show('home');
    if (!S.cfg) S.cfg = await api('GET', '/api/config');
    const chips = $('#langChips'); chips.innerHTML = '';
    for (const [k, label] of [['auto', 'Auto-detect'], ['fa', 'فارسی · Persian'], ['en', 'English'], ['tr', 'Türkçe · Turkish']]) {
      chips.append(h('div', { class: 'chip' + (H.lang === k ? ' on' : ''), text: label, onclick: () => { H.lang = k; showHome(); } }));
    }
    const asr = $('#asr'), sep = $('#sep');
    if (!asr.options.length) {
      for (const [k, v] of Object.entries(S.cfg.asr)) asr.append(h('option', { value: k, text: v, selected: k === 'best' }));
      for (const [k, v] of Object.entries(S.cfg.separation)) sep.append(h('option', { value: k, text: v }));
      asr.value = lsGet('karaoke.asr', 'best'); sep.value = lsGet('karaoke.sep', 'fast');
    }
    updateCreateUi();
    await loadProjects();
  }

  /** Loads every saved project (no limit besides disk space) and keeps refreshing while any is still processing. */
  async function loadProjects() {
    clearTimeout(H.timer);
    const [list, usage] = await Promise.all([api('GET', '/api/jobs').catch(() => []), api('GET', '/api/storage').catch(() => null)]);
    H.list = list; H.usage = usage;
    renderProjects();
    if (!views.home.hidden && list.some((j) => j.stage !== 'ready' && j.stage !== 'failed')) H.timer = setTimeout(loadProjects, 2500);
  }
  function renderProjects() {
    const all = H.list, has = all.length > 0;
    $('#hero').hidden = has; $('#projects').hidden = !has;
    $('#newCard').hidden = has && !H.showNew;
    $('#btnNew').textContent = H.showNew ? '✕ Close' : '＋ New karaoke';
    if (!has) return;
    const q = $('#projSearch').value.trim().toLowerCase();
    const list = q ? all.filter((j) => `${j.title} ${j.artist} ${j.filename}`.toLowerCase().includes(q)) : all;
    $('#projCount').textContent = q ? `Your projects (${list.length} of ${all.length})` : `Your projects (${all.length})`;
    const box = $('#projList'); box.innerHTML = '';
    for (const j of list) {
      const processing = j.stage !== 'ready' && j.stage !== 'failed';
      const lang = LANG_NAME[j.language !== 'auto' ? j.language : j.detected_language];
      const size = H.usage && H.usage.projects[j.id];
      box.append(h('div', { class: 'pcard ' + (j.stage === 'failed' ? 'failed' : ''), onclick: () => { location.hash = '#/p/' + j.id; } },
        h('div', { class: 'pt', dir: 'auto', text: j.title || j.filename }),
        h('div', { class: 'pa muted', dir: 'auto', text: j.artist || '' }),
        processing ? h('div', { class: 'bar' }, h('i', { style: `width:${j.progress}%` })) : null,
        h('div', { class: 'pm' },
          h('span', { class: 'pill ' + (j.stage === 'ready' ? 'ready' : j.stage === 'failed' ? 'failed' : ''), text: j.stage === 'ready' ? 'Ready' : j.stage === 'failed' ? 'Failed' : `${Math.round(j.progress)}%` }),
          h('span', { text: [fmtShort(j.duration), lang, size ? fmtBytes(size) : null].filter(Boolean).join(' · ') })),
        h('button', { class: 'x', title: 'Delete project', text: '✕', onclick: async (e) => { e.stopPropagation(); if (confirm(`Delete “${j.title || j.filename}” and all its files?`)) { await api('DELETE', '/api/jobs/' + j.id); loadProjects(); } } })));
    }
    if (!list.length) box.append(h('div', { class: 'pcard empty muted', text: 'No project matches your search.' }));
    const u = H.usage;
    $('#storageNote').textContent = u ? `${all.length} project${all.length === 1 ? '' : 's'} · ${fmtBytes(u.bytes)} used · ${fmtBytes(u.free)} free on this disk` : '';
  }
  $('#projSearch').oninput = renderProjects;
  $('#btnNew').onclick = () => { H.showNew = !H.showNew; renderProjects(); if (H.showNew) $('#newCard').scrollIntoView({ behavior: 'smooth' }); };

  function pickFiles(fl) {
    const files = [...(fl || [])].filter(Boolean);
    if (files.length) { H.files = files; updateCreateUi(); }
  }
  function updateCreateUi() {
    const n = H.files.length;
    const kids = n
      ? [h('span', { class: 'file', text: n === 1 ? '🎵 ' + H.files[0].name : `🎵 ${n} songs selected` }),
        h('div', { class: 'muted small', text: n > 1 ? H.files.slice(0, 4).map((f) => f.name).join(' · ') + (n > 4 ? ` · +${n - 4} more` : '') : 'Click to choose a different file' })]
      : ['Drop a song here, or click to choose'];
    $('#dropText').replaceChildren(...kids);
    $('#fieldLyrics').hidden = $('#fieldMeta').hidden = n > 1;
    $('#multiNote').hidden = n <= 1;
    $('#btnCreate').disabled = !n;
    $('#btnCreate').textContent = n > 1 ? `Create ${n} karaoke projects →` : 'Create karaoke →';
  }
  const drop = $('#drop');
  drop.onclick = () => $('#file').click();
  $('#file').onchange = (e) => pickFiles(e.target.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); pickFiles(e.dataTransfer.files); };

  function uploadSong(file, fields, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData(); fd.append('file', file);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/jobs');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let body = {}; try { body = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new Error(body.detail || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Is the server still running?'));
      xhr.send(fd);
    });
  }
  $('#btnCreate').onclick = async () => {
    const files = H.files.slice(), n = files.length;
    if (!n) return;
    const common = { language: H.lang, asr: $('#asr').value, separation: $('#sep').value };
    lsSet('karaoke.asr', common.asr); lsSet('karaoke.sep', common.separation);
    const fields = n > 1 ? { ...common, lyrics: '', title: '', artist: '' }
      : { ...common, lyrics: $('#lyrics').value, title: $('#title').value, artist: $('#artist').value };
    const btn = $('#btnCreate'); btn.disabled = true;
    let ok = 0, last = null;
    for (let i = 0; i < n; i++) {
      const label = n > 1 ? `Uploading ${i + 1}/${n}… ` : 'Uploading… ';
      try { last = await uploadSong(files[i], fields, (f) => { $('#uploadMsg').textContent = label + Math.round(f * 100) + '%'; }); ok++; }
      catch (e) { toast(`${files[i].name}: ${e.message}`, 5000); }
    }
    $('#uploadMsg').textContent = '';
    if (!ok) { btn.disabled = false; return; }
    H.files = []; $('#file').value = '';
    if (n === 1) { updateCreateUi(); location.hash = '#/p/' + last.id; return; }
    H.showNew = false; updateCreateUi();
    toast(`${ok} song${ok === 1 ? '' : 's'} queued. They are processed one after another.`, 4500);
    loadProjects();
  };
  $('#btnDemo').onclick = async () => { const j = await api('POST', '/api/demo'); location.hash = '#/p/' + j.id; };

  // ------------------------------------------------------------------ processing view
  const STEPS = [['decode', 'Reading your audio'], ['separate', 'Removing the vocals'], ['transcribe', 'Listening to the lyrics'], ['finalize', 'Syncing the words']];
  async function openProject(id) {
    if (!S.cfg) S.cfg = await api('GET', '/api/config');
    let job;
    try { job = await api('GET', '/api/jobs/' + id); } catch (e) { toast('Project not found'); location.hash = '#/'; return; }
    S.job = job;
    if (job.stage === 'ready') return enterStudio(job);
    show('progress'); renderProgress(job);
    const loop = async () => {
      try { job = await api('GET', '/api/jobs/' + id); } catch (_) { S.poll = setTimeout(loop, 2000); return; }
      renderProgress(job);
      if (job.stage === 'ready') return enterStudio(job);
      if (job.stage !== 'failed') S.poll = setTimeout(loop, 1000);
    };
    S.poll = setTimeout(loop, 800);
  }
  function renderProgress(job) {
    $('#pgTitle').textContent = job.title || 'Working on it…';
    $('#pgTitle').dir = 'auto';
    $('#pgMsg').textContent = job.stage === 'failed' ? 'Something went wrong' : job.message;
    $('#pgBar').style.width = job.progress + '%';
    const idx = STEPS.findIndex((s) => s[0] === job.stage);
    const ul = $('#pgSteps'); ul.innerHTML = '';
    STEPS.forEach(([k, label], i) => {
      const done = job.stage === 'ready' || (idx > i), active = idx === i && job.stage !== 'failed';
      ul.append(h('li', { class: done ? 'done' : active ? 'active' : '' }, h('span', { class: 'dot', text: done ? '✓' : '' }), label));
    });
    const err = $('#pgErr'); err.hidden = !job.error; err.textContent = job.error || '';
    $('#pgRetry').hidden = job.stage !== 'failed';
    $('#pgRetry').onclick = async () => { await api('POST', `/api/jobs/${job.id}/retry`); openProject(job.id); };
    $('#pgDelete').onclick = async () => { if (confirm('Delete this project?')) { await api('DELETE', '/api/jobs/' + job.id); location.hash = '#/'; } };
  }

  // ------------------------------------------------------------------ studio
  function initialStyle(saved) {
    if (saved && Object.keys(saved).length) return KS.resolveStyle(saved, BUILTIN);
    const last = lsGet('karaoke.style', null);
    return KS.resolveStyle(last || { preset: 'neon' }, BUILTIN);
  }
  function normalizeLyrics(l) {
    const lines = ((l && l.lines) || []).filter((x) => x.words && x.words.length);
    lines.sort((a, b) => a.words[0].s - b.words[0].s);
    return { lines, offset: (l && l.offset) || 0, stats: l && l.stats };
  }

  async function enterStudio(job) {
    show('studio');
    S.job = job;
    const [project, saved] = await Promise.all([api('GET', `/api/jobs/${job.id}/project`), api('GET', '/api/presets').catch(() => [])]);
    S.saved = saved;
    S.lyrics = normalizeLyrics(project.lyrics);
    S.style = initialStyle(project.style);
    $('#inTitle').value = job.title || ''; $('#inArtist').value = job.artist || '';

    const cv = $('#cv');
    S.renderer = new KaraokeRenderer(cv);
    S.renderer.setMeta({ title: job.title, artist: job.artist, duration: job.duration, language: job.language !== 'auto' ? job.language : job.detected_language });
    S.renderer.setStyle(S.style);
    S.renderer.setLyrics(S.lyrics);
    layoutCanvas();
    fetch(`/api/jobs/${job.id}/spectrum`).then((r) => r.arrayBuffer()).then((b) => { S.renderer.setSpectrum(KS.parseSpectrum(b)); S.needDraw = true; }).catch(() => {});
    await S.renderer.loadAssets();

    const a = $('#aInst'), v = $('#aVoc');
    a.src = `/api/jobs/${job.id}/audio/instrumental`; v.src = `/api/jobs/${job.id}/audio/vocals`;
    updateGuide();

    buildTabs();
    S.controls.forEach((c) => c.sync && c.sync());
    S.needDraw = true; S.activeLine = -1;
    cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(tick);
    loadRenders();
  }

  // ---- canvas sizing + preview loop
  function layoutCanvas() {
    if (!S.renderer) return;
    const { w, h: hh } = KS.outputSize(S.style.canvas);
    const fs = isFullscreen();
    const stage = $('.stage');
    const availW = fs ? window.innerWidth : (stage.clientWidth || 800);
    const availH = fs ? window.innerHeight : Math.max(260, window.innerHeight - 190);
    const cssW = Math.min(availW, availH * (w / hh));
    const wrap = $('#canvasWrap'); wrap.style.width = cssW + 'px'; wrap.style.aspectRatio = `${w} / ${hh}`;   // CSS overrides both in fullscreen
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.min(fs ? 2560 : 1400, Math.round(cssW * dpr));
    S.renderer.setSize(w, hh, pw, Math.round(pw * hh / w));
    S.needDraw = true;
  }
  window.addEventListener('resize', debounce(layoutCanvas, 120));

  function tick() {
    S.raf = requestAnimationFrame(tick);
    const a = $('#aInst'), t = a.currentTime || 0;
    if (!a.paused || S.needDraw || t !== S.lastT) {
      S.renderer.draw(t); S.lastT = t; S.needDraw = false;
      const dur = S.job.duration || a.duration || 1;
      if (document.activeElement !== $('#seek')) $('#seek').value = Math.round(t / dur * 1000);
      $('#timeLbl').textContent = `${fmtShort(t)} / ${fmtShort(dur)}`;
      markActiveLine(t);
    }
  }
  const aInst = $('#aInst'), aVoc = $('#aVoc');
  function updateGuide() {
    aVoc.volume = Math.min(1, S.exportOpts.guide);
    if (!aInst.paused) syncVoc(true);
    $('#guideLbl').textContent = `🎤 ${Math.round(S.exportOpts.guide * 100)}%`;
  }
  /** Guide vocal level 0-50% in 5% steps; keeps the Export tab slider and the saved setting in step. */
  function setGuide(v, announce) {
    S.exportOpts.guide = Math.round(Math.max(0, Math.min(0.5, v)) * 20) / 20;
    if (S.exportOpts.guide > 0) S.lastGuide = S.exportOpts.guide;
    lsSet('karaoke.export', S.exportOpts);
    S.controls.forEach((c) => c.sync && c.sync());
    updateGuide();
    if (announce && !isFullscreen()) toast(`Guide vocal ${Math.round(S.exportOpts.guide * 100)}%`, 1100);
  }
  function syncVoc(force) {
    if (S.exportOpts.guide <= 0) { aVoc.pause(); return; }
    if (force || Math.abs(aVoc.currentTime - aInst.currentTime) > 0.12) aVoc.currentTime = aInst.currentTime;
    if (aVoc.paused && !aInst.paused) aVoc.play().catch(() => {});
  }
  aInst.addEventListener('play', () => { $('#btnPlay').textContent = '⏸'; syncVoc(true); });
  aInst.addEventListener('pause', () => { $('#btnPlay').textContent = '▶'; aVoc.pause(); });
  aInst.addEventListener('ended', () => { $('#btnPlay').textContent = '▶'; aVoc.pause(); });
  aInst.addEventListener('seeked', () => { S.needDraw = true; if (!aInst.paused) syncVoc(true); });
  setInterval(() => { if (!aInst.paused) syncVoc(false); }, 400);
  $('#btnPlay').onclick = () => { aInst.paused ? aInst.play().catch(() => {}) : aInst.pause(); };
  $('#seek').oninput = (e) => { aInst.currentTime = (e.target.value / 1000) * (S.job.duration || aInst.duration || 0); S.needDraw = true; };
  const dur = () => S.job.duration || aInst.duration || 0;
  const seekBy = (d) => { aInst.currentTime = Math.max(0, Math.min(dur(), aInst.currentTime + d)); S.needDraw = true; };
  function jumpLine(dir) {
    const starts = S.lyrics.lines.map((l) => l.words[0].s + S.lyrics.offset), t = aInst.currentTime;
    const target = dir > 0 ? starts.find((x) => x - 0.6 > t + 0.15) : [...starts].reverse().find((x) => x - 0.6 < t - 1.2);
    if (target !== undefined) seekTo(target - 0.6); else if (dir < 0) seekTo(0);
  }

  // ---- fullscreen: only the picture, no UI
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function isFullscreen() { return !!fsEl(); }
  function toggleFullscreen() {
    const wrap = $('#canvasWrap');
    if (isFullscreen()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(wrap)).catch(() => toast('Fullscreen is not available in this browser', 3000));
  }
  let idleTimer = 0;
  function onFullscreenChange() {
    const wrap = $('#canvasWrap');
    wrap.classList.remove('idle');
    layoutCanvas();
    setTimeout(layoutCanvas, 150);                      // some browsers report the final size a moment later
    if (isFullscreen()) idleTimer = setTimeout(() => wrap.classList.add('idle'), 1800);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  $('#canvasWrap').addEventListener('mousemove', () => {      // hide the mouse pointer after a moment, too
    const wrap = $('#canvasWrap'); wrap.classList.remove('idle'); clearTimeout(idleTimer);
    if (isFullscreen()) idleTimer = setTimeout(() => wrap.classList.add('idle'), 1800);
  });
  $('#btnFs').onclick = toggleFullscreen;
  $('#btnKeys').onclick = () => { const p = $('#keysPanel'); p.hidden = !p.hidden; };
  $('#cv').addEventListener('click', () => $('#btnPlay').click());          // click = play / pause
  $('#cv').addEventListener('dblclick', toggleFullscreen);                    // double-click = fullscreen

  // ---- hotkeys
  window.addEventListener('keydown', (e) => {
    if (views.studio.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = t.tagName, type = (t.type || '').toLowerCase();
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable ||
      (tag === 'INPUT' && !['range', 'checkbox', 'button'].includes(type));
    if (typing) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const arrow = key.startsWith('Arrow');
    if (arrow && tag === 'INPUT' && type === 'range' && t.id !== 'seek') return;     // let other sliders use their own arrows
    if (tag === 'BUTTON' || tag === 'A' || (tag === 'INPUT' && type === 'checkbox')) t.blur();   // so Space does not also "click" it
    let handled = true;
    switch (key) {
      case ' ': case 'k': $('#btnPlay').click(); break;
      case 'ArrowLeft': seekBy(e.shiftKey ? -15 : -5); break;
      case 'ArrowRight': seekBy(e.shiftKey ? 15 : 5); break;
      case 'j': seekBy(-10); break;
      case 'l': seekBy(10); break;
      case 'ArrowUp': setGuide(S.exportOpts.guide + 0.05, true); break;
      case 'ArrowDown': setGuide(S.exportOpts.guide - 0.05, true); break;
      case 'g': setGuide(S.exportOpts.guide > 0 ? 0 : (S.lastGuide || 0.25), true); break;
      case 'f': toggleFullscreen(); break;
      case 'Home': case '0': seekTo(0); break;
      case '[': jumpLine(-1); break;
      case ']': jumpLine(1); break;
      case '?': $('#btnKeys').click(); break;
      case 'Escape': $('#keysPanel').hidden = true; handled = false; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });
  const seekTo = (t) => { aInst.currentTime = Math.max(0, t); S.needDraw = true; };

  // ---- title / artist
  const saveMeta = debounce(async () => {
    const meta = { title: $('#inTitle').value, artist: $('#inArtist').value };
    S.job.title = meta.title; S.job.artist = meta.artist;
    S.renderer.setMeta(meta); S.needDraw = true;
    await api('PUT', `/api/jobs/${S.job.id}/project`, { meta }).catch(() => {});
  }, 500);
  $('#inTitle').oninput = saveMeta; $('#inArtist').oninput = saveMeta;

  // ---- persistence
  const saveProject = debounce(async () => {
    if (!S.job) return;
    lsSet('karaoke.style', S.style);
    try { await api('PUT', `/api/jobs/${S.job.id}/project`, { lyrics: { lines: S.lyrics.lines, offset: S.lyrics.offset, stats: S.lyrics.stats }, style: S.style }); } catch (_) {}
  }, 700);

  const reloadAssets = debounce(async () => { await S.renderer.loadAssets(); S.needDraw = true; }, 120);
  function styleChanged(path) {
    S.renderer.setStyle(S.style);
    if (path && path.startsWith('canvas')) layoutCanvas();
    S.needDraw = true; reloadAssets(); saveProject();
  }
  function lyricsChanged() { S.renderer.setLyrics(S.lyrics); S.needDraw = true; saveProject(); }

  // ------------------------------------------------------------------ controls (declarative helpers)
  function reg(c) { S.controls.push(c); return c; }
  /** Every control sits in the same 3-column grid: label | control | value (value column optional). */
  function row(label, control, out) {
    return h('div', { class: 'row' + (out ? '' : ' wide') }, h('span', { class: 'lb', text: label }), control, out || null);
  }

  function range(parent, label, path, min, max, step, f = (v) => v) {
    const out = h('output'), inp = h('input', { type: 'range', min, max, step });
    inp.oninput = () => { const v = parseFloat(inp.value); setPath(S.style, path, v); out.textContent = f(v); styleChanged(path); };
    reg({ sync() { const v = getPath(S.style, path); inp.value = v; out.textContent = f(v); } });
    parent.append(row(label, inp, out));
  }
  function color(parent, label, path) {
    const inp = h('input', { type: 'color' }), out = h('output');
    inp.oninput = () => { setPath(S.style, path, inp.value); out.textContent = inp.value.toUpperCase(); styleChanged(path); };
    reg({ sync() { inp.value = getPath(S.style, path) || '#000000'; out.textContent = inp.value.toUpperCase(); } });
    parent.append(row(label, inp, out));
  }
  function toggle(parent, label, path) {
    const inp = h('input', { type: 'checkbox' });
    inp.onchange = () => { setPath(S.style, path, inp.checked); styleChanged(path); };
    reg({ sync() { inp.checked = !!getPath(S.style, path); } });
    parent.append(h('label', { class: 'row check' }, h('span', { text: label }), inp));
  }
  function select(parent, label, path, options, numeric) {
    const sel = h('select');
    for (const [v, t] of options) sel.append(h('option', { value: v, text: t }));
    sel.onchange = () => { setPath(S.style, path, numeric ? parseFloat(sel.value) : sel.value); styleChanged(path); };
    reg({ sync() { sel.value = getPath(S.style, path); } });
    parent.append(row(label, sel));
  }
  function seg(parent, label, path, options) {
    const box = h('div', { class: 'seg' });
    const btns = options.map(([v, t]) => h('button', { text: t, onclick: () => { setPath(S.style, path, v); sync(); styleChanged(path); } }));
    btns.forEach((b) => box.append(b));
    const sync = () => btns.forEach((b, i) => b.classList.toggle('on', getPath(S.style, path) === options[i][0]));
    reg({ sync });
    parent.append(row(label, box));
  }
  function text(parent, label, path, placeholder) {
    const inp = h('input', { type: 'text', placeholder: placeholder || '', dir: 'auto' });
    inp.oninput = () => { setPath(S.style, path, inp.value); styleChanged(path); };
    reg({ sync() { inp.value = getPath(S.style, path) || ''; } });
    parent.append(row(label, inp));
  }
  function section(parent, title, open) {
    const body = h('div', { class: 'in' });
    parent.append(h('details', { class: 'sec', open: !!open }, h('summary', { text: title }), body));
    return body;
  }
  async function uploadAsset(kind, file) {
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', file);
    const r = await fetch('/api/assets', { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Upload failed');
    return r.json();
  }
  function imageUpload(parent, label, urlPath, kind = 'image') {
    const img = h('img', { alt: '' }), file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif', hidden: true });
    const sync = () => { const u = getPath(S.style, urlPath); img.hidden = !u; if (u) img.src = u; clear.hidden = !u; };
    const clear = h('button', { class: 'btn ghost', text: 'Remove', onclick: () => { setPath(S.style, urlPath, null); sync(); styleChanged(urlPath); } });
    file.onchange = async () => {
      if (!file.files[0]) return;
      try { const a = await uploadAsset('image', file.files[0]); setPath(S.style, urlPath, a.url); sync(); styleChanged(urlPath); } catch (e) { toast(e.message, 4000); }
      file.value = '';
    };
    reg({ sync });
    parent.append(row(label, h('div', { class: 'upl' }, img, h('button', { class: 'btn', text: 'Upload…', onclick: () => file.click() }), clear, file)));
  }

  // ------------------------------------------------------------------ tabs
  function buildTabs() {
    S.controls = [];
    buildLyricsTab(); buildStyleTab(); buildBrandTab(); buildExportTab();
    for (const b of document.querySelectorAll('#tabs .tab')) {
      b.onclick = () => {
        document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('on', x === b));
        for (const n of ['lyrics', 'style', 'brand', 'export']) $('#tab-' + n).hidden = n !== b.dataset.tab;
      };
    }
  }

  // ---- LYRICS TAB
  function buildLyricsTab() {
    const root = $('#tab-lyrics'); root.innerHTML = '';
    const st = S.lyrics.stats;
    if (st && st.mode === 'lyrics') {
      const pct = Math.round(st.matched * 100);
      root.append(h('div', { class: 'banner' + (pct < 50 ? ' warn' : '') },
        pct < 50 ? `Only ${pct}% of your lyrics could be matched to the audio, so many timings are estimated. Check the highlighted line while the song plays and use ⏱ to fix any that drift.`
          : `Your lyrics were matched to the audio (${pct}% of words anchored). Play the song and fix anything that drifts with ⏱.`));
    } else if (st && st.mode === 'asr') {
      root.append(h('div', { class: 'banner' }, 'These lyrics are what the AI heard. Fix any wrong words below, or paste the real lyrics at the bottom and re-sync.'));
    } else if (st && st.mode === 'demo') {
      root.append(h('div', { class: 'banner' }, 'This is a demo track. Try the Style and Brand tabs, then export.'));
    }
    const LN = { fa: 'Persian', en: 'English', tr: 'Turkish' };
    const lang = S.job.language !== 'auto' ? S.job.language : S.job.detected_language;
    if (lang && !S.job.demo) root.append(h('div', { class: 'hint', style: 'margin-top:-4px', text: `Recognised as ${LN[lang] || lang}. Wrong? Use “Re-run recognition” at the bottom.` }));
    const offInp = h('input', { type: 'range', min: -3, max: 3, step: 0.05 }), offOut = h('output');
    const offText = () => { const v = S.lyrics.offset || 0; offInp.value = v; offOut.textContent = (v > 0 ? '+' : '') + v.toFixed(2) + 's'; };
    offInp.oninput = () => { S.lyrics.offset = parseFloat(offInp.value); offText(); lyricsChanged(); renderLinesTimes(); };
    reg({ sync: offText });
    const timing = section(root, 'Timing', true);
    timing.append(row('Sync offset', offInp, offOut),
      h('div', { class: 'hint', text: 'Moves every word earlier or later. Click a time to jump there; ⏱ sets that line’s start to the playhead.' }));
    root.append(h('div', { class: 'lbl muted', style: 'margin:var(--s4) 0 var(--s2)', text: `Lines (${S.lyrics.lines.length})` }));

    const list = h('div', { class: 'lines', id: 'lineList' }); root.append(list);
    renderLines();

    const ta = h('textarea', { dir: 'auto', placeholder: 'Paste corrected lyrics here…' });
    ta.value = S.lyrics.lines.map((l) => l.words.map((w) => w.t).join(' ')).join('\n');
    root.append(h('details', { class: 'sec', style: 'margin-top:14px' }, h('summary', { text: 'Re-sync from pasted lyrics' }),
      h('div', { class: 'in' }, h('div', { class: 'hint', text: 'Replaces all lines. Your text is kept exactly; timing is re-matched to the audio. Manual timing fixes are lost.' }), ta,
        h('button', { class: 'btn', style: 'margin-top:10px', text: 'Re-sync to audio', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Matching…';
          try { const r = await api('POST', `/api/jobs/${S.job.id}/align`, { text: ta.value }); S.lyrics = normalizeLyrics(r); lyricsChanged(); buildLyricsTab(); S.controls.forEach((c2) => c2.sync && c2.sync()); toast('Lyrics re-synced'); }
          catch (err) { toast(err.message, 4000); } finally { e.target.disabled = false; e.target.textContent = 'Re-sync to audio'; }
        } }))));

    if (!S.job.demo) {
      const lsel = h('select'), asel = h('select');
      for (const [v, t] of [['auto', 'Auto-detect'], ['fa', 'فارسی · Persian'], ['en', 'English'], ['tr', 'Türkçe · Turkish']]) lsel.append(h('option', { value: v, text: t }));
      for (const [v, t] of Object.entries(S.cfg.asr)) asel.append(h('option', { value: v, text: t }));
      lsel.value = S.job.language; asel.value = S.job.asr in S.cfg.asr ? S.job.asr : 'best';
      root.append(h('details', { class: 'sec' }, h('summary', { text: 'Re-run recognition' }),
        h('div', { class: 'in' }, h('div', { class: 'hint', text: 'Use this if the language was guessed wrong or the AI heard the song badly. It listens again (the vocal removal is kept) and replaces all lyrics and timing edits.' }),
          row('Language', lsel), row('Accuracy', asel),
          h('button', { class: 'btn', style: 'margin-top:10px', text: 'Re-run recognition', onclick: async () => {
            if (!confirm('This replaces all lyrics and timing edits. Continue?')) return;
            const id = S.job.id;
            try { await api('POST', `/api/jobs/${id}/reprocess`, { language: lsel.value, asr: asel.value }); leaveStudio(); openProject(id); }
            catch (err) { toast(err.message, 4000); }
          } }))));
    }
  }

  function lineRow(i) {
    const line = S.lyrics.lines[i];
    const tm = h('button', { class: 'tm', title: 'Jump here', onclick: () => seekTo(line.words[0].s + S.lyrics.offset - 0.6) });
    tm.textContent = fmt(line.words[0].s + S.lyrics.offset);
    const tx = h('input', { type: 'text', class: 'tx', dir: 'auto', value: line.words.map((w) => w.t).join(' ') });
    tx.onchange = () => editLineText(i, tx.value);
    tx.onfocus = () => seekTo(line.words[0].s + S.lyrics.offset - 0.6);
    const ops = h('div', { class: 'ops' },
      h('button', { title: 'Set this line’s start to the playhead', text: '⏱', onclick: () => { const d = (aInst.currentTime - S.lyrics.offset) - line.words[0].s; line.words.forEach((w) => { w.s += d; w.e += d; }); resortLines(); } }),
      h('button', { title: 'Add a line after this one', text: '+', onclick: () => insertLineAfter(i) }),
      h('button', { title: 'Delete line', text: '✕', onclick: () => { S.lyrics.lines.splice(i, 1); renderLines(); lyricsChanged(); } }));
    return h('div', { class: 'ln', 'data-i': i }, tm, tx, ops);
  }
  function renderLines() {
    const box = $('#lineList'); if (!box) return;
    box.replaceChildren(...S.lyrics.lines.map((_, i) => lineRow(i)));
    S.activeLine = -1;
  }
  function renderLinesTimes() {
    document.querySelectorAll('#lineList .ln').forEach((r) => { const l = S.lyrics.lines[+r.dataset.i]; if (l) r.querySelector('.tm').textContent = fmt(l.words[0].s + S.lyrics.offset); });
  }
  function resortLines() { S.lyrics.lines.sort((a, b) => a.words[0].s - b.words[0].s); renderLines(); lyricsChanged(); }
  function spreadWords(tokens, s, e) {
    const wts = tokens.map((t) => t.length + 1.5), tot = wts.reduce((a, b) => a + b, 0);
    let acc = 0;
    return tokens.map((t, k) => { const a = s + (acc / tot) * (e - s); acc += wts[k]; return { t, s: +a.toFixed(3), e: +(s + (acc / tot) * (e - s) - 0.04).toFixed(3) }; });
  }
  function editLineText(i, value) {
    const line = S.lyrics.lines[i], toks = value.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) { S.lyrics.lines.splice(i, 1); renderLines(); lyricsChanged(); return; }
    if (toks.length === line.words.length) line.words.forEach((w, k) => { w.t = toks[k]; });
    else line.words = spreadWords(toks, line.words[0].s, line.words[line.words.length - 1].e);
    lyricsChanged();
  }
  function insertLineAfter(i) {
    const lines = S.lyrics.lines, prev = lines[i];
    const s = prev.words[prev.words.length - 1].e + 0.2;
    const next = lines[i + 1], e = Math.min(s + 3, next ? next.words[0].s - 0.1 : s + 3);
    lines.splice(i + 1, 0, { words: spreadWords(['New', 'line'], s, Math.max(e, s + 0.6)) });
    renderLines(); lyricsChanged();
    const inp = document.querySelector(`#lineList .ln[data-i="${i + 1}"] .tx`); if (inp) { inp.focus(); inp.select(); }
  }
  function markActiveLine(t) {
    const lines = S.lyrics.lines; if (!lines.length) return;
    const tt = t - S.lyrics.offset; let k = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].words[0].s <= tt + 0.05) k = i; else break; }
    if (k === S.activeLine) return;
    S.activeLine = k;
    document.querySelectorAll('#lineList .ln').forEach((r) => r.classList.toggle('active', +r.dataset.i === k));
    const act = document.querySelector('#lineList .ln.active');
    if (act && !aInst.paused && !document.activeElement.classList.contains('tx')) act.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- STYLE TAB
  const POS6 = [['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right']];
  function presetThumb(p) {
    const b = KS.deepMerge(KS.DEFAULT_STYLE.background, (p.style && p.style.background) || {}), L = KS.deepMerge(KS.DEFAULT_STYLE.lyrics, (p.style && p.style.lyrics) || {});
    const bg = b.type === 'solid' ? b.color : b.type === 'image' ? '#222' : `linear-gradient(${b.angle}deg, ${b.color}, ${b.color2})`;
    return h('div', { style: `position:absolute;inset:0;background:${bg};display:grid;place-items:center;font:700 22px "${L.font}", Vazirmatn;color:${L.color}` },
      h('span', { style: `position:static;background:none;padding:0;font-size:22px;color:${L.highlight};text-shadow:0 2px 10px #0008` }, 'Aa ', h('span', { style: `position:static;background:none;padding:0;color:${L.color}`, text: 'آوا' })));
  }
  function applyLook(p) {
    const D = KS.DEFAULT_STYLE, cur = S.style;
    if (p.custom) {
      const keepCanvas = cur.canvas;
      S.style = KS.resolveStyle(p.style, BUILTIN); S.style.canvas = keepCanvas;
    } else {
      for (const g of ['background', 'lyrics', 'visualizer']) cur[g] = KS.deepMerge(D[g], p.style[g] || {});
      if (p.style.progress && p.style.progress.color) cur.progress.color = p.style.progress.color;
      if (p.style.title && p.style.title.color) cur.title.color = p.style.title.color; else cur.title.color = D.title.color;
      if (p.style.footer && p.style.footer.color) cur.footer.color = p.style.footer.color; else cur.footer.color = D.footer.color;
    }
    S.controls.forEach((c) => c.sync && c.sync()); renderPresets(); styleChanged('look');
  }
  function renderPresets() {
    const box = $('#presetBox'); if (!box) return;
    box.innerHTML = '';
    for (const p of [...BUILTIN, ...S.saved.map((x) => ({ ...x, custom: true }))]) {
      const b = h('button', { class: 'preset', title: p.name, onclick: () => applyLook(p) }, presetThumb(p), h('span', { text: p.name }));
      if (p.custom) b.append(h('button', { class: 'x', title: 'Delete preset', text: '×', onclick: async (e) => { e.stopPropagation(); await api('DELETE', '/api/presets/' + p.id); S.saved = S.saved.filter((x) => x.id !== p.id); renderPresets(); } }));
      box.append(b);
    }
  }
  function fontOptions() {
    const opts = S.cfg.fonts.map((f) => [f.family, f.family + (f.scripts.includes('arabic') ? '  ·  فارسی' : '')]);
    for (const f of S.style.customFonts || []) opts.push([f.family, f.family]);
    return opts;
  }
  function buildStyleTab() {
    const root = $('#tab-style'); root.innerHTML = '';
    const lookS = section(root, 'Look', true);
    lookS.append(h('div', { class: 'presets', id: 'presetBox' }));
    const nm = h('input', { type: 'text', placeholder: 'Name this look…', dir: 'auto' });
    lookS.append(h('div', { class: 'save-row' }, nm, h('button', { class: 'btn', text: 'Save as preset', onclick: async () => {
      const name = nm.value.trim(); if (!name) { toast('Give the preset a name first'); return; }
      const id = (name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'preset') + '-' + Math.random().toString(36).slice(2, 6);
      const style = clone(S.style); delete style.canvas;
      await api('PUT', '/api/presets/' + id, { name, style });
      S.saved.push({ id, name, style, custom: true }); nm.value = ''; renderPresets(); toast('Preset saved — it includes your logo, fonts and brand settings');
    } })));
    lookS.append(h('div', { class: 'hint', text: 'Saved presets keep everything (colors, fonts, logo, footer) so every video matches your brand.' }));
    renderPresets();

    const bg = section(root, 'Background');
    seg(bg, 'Type', 'background.type', [['gradient', 'Gradient'], ['solid', 'Solid'], ['image', 'Image']]);
    color(bg, 'Color', 'background.color'); color(bg, 'Second color', 'background.color2');
    range(bg, 'Angle', 'background.angle', 0, 360, 5, (v) => v + '°');
    imageUpload(bg, 'Image', 'background.image');
    range(bg, 'Darken image', 'background.dim', 0, 0.9, 0.05, (v) => Math.round(v * 100) + '%');
    range(bg, 'Blur image', 'background.blur', 0, 40, 1, (v) => v + 'px');
    range(bg, 'Slow zoom', 'background.zoom', 0, 0.2, 0.01, (v) => Math.round(v * 100) + '%');
    range(bg, 'Color glow', 'background.glow', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    range(bg, 'Beat pulse', 'background.pulse', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    range(bg, 'Vignette', 'background.vignette', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    for (let i = 0; i < 3; i++) color(bg, `Glow color ${i + 1}`, `background.glowColors.${i}`);

    const ly = section(root, 'Lyrics', true);
    const fontRow = h('div'); ly.append(fontRow);
    const fontSel = h('select'); fontRow.append(row('Font', fontSel));
    const fillFonts = () => { fontSel.replaceChildren(...fontOptions().map(([v, t]) => h('option', { value: v, text: t }))); fontSel.value = S.style.lyrics.font; };
    fontSel.onchange = () => { S.style.lyrics.font = fontSel.value; styleChanged('lyrics.font'); };
    reg({ sync: fillFonts });
    seg(ly, 'Weight', 'lyrics.weight', [[400, 'Regular'], [700, 'Bold']]);
    range(ly, 'Size', 'lyrics.size', 40, 150, 1, (v) => v + 'px');
    range(ly, 'Line spacing', 'lyrics.lineHeight', 1, 1.8, 0.02, (v) => v.toFixed(2));
    color(ly, 'Text color', 'lyrics.color'); color(ly, 'Highlight color', 'lyrics.highlight');
    seg(ly, 'Highlight', 'lyrics.sweep', [['wipe', 'Sweep'], ['instant', 'Whole word']]);
    range(ly, 'Glow', 'lyrics.glow', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    range(ly, 'Shadow', 'lyrics.shadow', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    range(ly, 'Outline', 'lyrics.outline', 0, 12, 0.5, (v) => v + 'px'); color(ly, 'Outline color', 'lyrics.outlineColor');
    range(ly, 'Other lines', 'lyrics.otherOpacity', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    range(ly, 'Lines before', 'lyrics.linesBefore', 0, 3, 1); range(ly, 'Lines after', 'lyrics.linesAfter', 0, 4, 1);
    range(ly, 'Max width', 'lyrics.maxWidth', 0.5, 0.95, 0.01, (v) => Math.round(v * 100) + '%');
    range(ly, 'Vertical position', 'lyrics.y', 0.25, 0.75, 0.01, (v) => Math.round(v * 100) + '%');
    range(ly, 'Word pop', 'lyrics.pop', 0, 0.15, 0.01, (v) => Math.round(v * 100) + '%');
    toggle(ly, 'UPPERCASE (Turkish-aware İ/I)', 'lyrics.uppercase');

    const vz = section(root, 'Visualizer');
    select(vz, 'Type', 'visualizer.type', [['bars', 'Bars'], ['mirror', 'Centered bars'], ['wave', 'Wave'], ['circle', 'Ring behind lyrics'], ['none', 'None']]);
    color(vz, 'Color', 'visualizer.color'); color(vz, 'Second color', 'visualizer.color2');
    seg(vz, 'Position', 'visualizer.position', [['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']]);
    range(vz, 'Height', 'visualizer.height', 0.04, 0.4, 0.01, (v) => Math.round(v * 100) + '%');
    range(vz, 'Bars', 'visualizer.bars', 12, 96, 2);
    range(vz, 'Thickness', 'visualizer.thickness', 0.2, 1, 0.02, (v) => Math.round(v * 100) + '%');
    range(vz, 'Sensitivity', 'visualizer.sensitivity', 0.4, 2, 0.05, (v) => v.toFixed(2) + '×');
    range(vz, 'Opacity', 'visualizer.opacity', 0.1, 1, 0.05, (v) => Math.round(v * 100) + '%');
  }

  // ---- BRAND TAB
  function buildBrandTab() {
    const root = $('#tab-brand'); root.innerHTML = '';
    const lg = section(root, 'Logo', true);
    imageUpload(lg, 'Logo', 'logo.url');
    select(lg, 'Position', 'logo.position', POS6);
    range(lg, 'Size', 'logo.size', 0.03, 0.4, 0.005, (v) => Math.round(v * 100) + '%');
    range(lg, 'Opacity', 'logo.opacity', 0.1, 1, 0.05, (v) => Math.round(v * 100) + '%');
    range(lg, 'Margin', 'logo.margin', 0, 0.12, 0.005, (v) => Math.round(v * 100) + '%');

    const ft = section(root, 'Footer / handle', true);
    text(ft, 'Text', 'footer.text', '@yourchannel · yoursite.com');
    select(ft, 'Position', 'footer.position', POS6);
    range(ft, 'Size', 'footer.size', 14, 64, 1, (v) => v + 'px');
    color(ft, 'Color', 'footer.color'); range(ft, 'Opacity', 'footer.opacity', 0.1, 1, 0.05, (v) => Math.round(v * 100) + '%');

    const tt = section(root, 'Title & artist');
    toggle(tt, 'Cover card at the start', 'title.cover'); toggle(tt, 'Show in the corner', 'title.show'); toggle(tt, 'Intro title card', 'title.intro');
    select(tt, 'Position', 'title.position', POS6);
    range(tt, 'Size', 'title.size', 16, 80, 1, (v) => v + 'px'); color(tt, 'Color', 'title.color');
    range(tt, 'Intro length', 'title.introSeconds', 2, 10, 0.5, (v) => v + 's');

    const ex = section(root, 'Extras');
    toggle(ex, 'Countdown dots before lines', 'countdown.show');
    range(ex, 'Dots after a gap of', 'countdown.minGap', 3, 15, 1, (v) => v + 's');
    toggle(ex, 'Progress bar', 'progress.show'); color(ex, 'Progress color', 'progress.color');

    const fs = section(root, 'Brand font', true);
    const file = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true });
    file.onchange = async () => {
      if (!file.files[0]) return;
      try {
        const a = await uploadAsset('font', file.files[0]);
        S.style.customFonts = (S.style.customFonts || []).filter((f) => f.url !== a.url).concat([{ family: a.family, url: a.url }]);
        S.style.lyrics.font = a.family;
        S.controls.forEach((c) => c.sync && c.sync()); styleChanged('lyrics.font'); toast(`Font “${a.family}” is now used for lyrics`);
      } catch (e) { toast(e.message, 4000); }
      file.value = '';
    };
    fs.append(h('div', { class: 'hint', text: 'Upload your own TTF / OTF / WOFF font. Persian words fall back to Vazirmatn if your font has no Arabic letters.' }),
      h('button', { class: 'btn', text: 'Upload font…', onclick: () => file.click() }), file);
  }

  // ---- EXPORT TAB
  function buildExportTab() {
    const root = $('#tab-export'); root.innerHTML = '';
    const asp = h('div', { class: 'aspects' });
    const AS = [['16:9', 'Landscape', 34, 19], ['9:16', 'Vertical', 19, 34], ['1:1', 'Square', 26, 26], ['4:5', 'Portrait', 24, 30]];
    const abtns = AS.map(([v, name, w, hh]) => h('div', { class: 'aspect', role: 'button', tabindex: 0, onclick: () => { S.style.canvas.aspect = v; sync(); styleChanged('canvas.aspect'); } },
      h('div', { class: 'ic' }, h('i', { style: `width:${w}px;height:${hh}px` })), h('span', { class: 'ar', text: v }), h('span', { text: name })));
    abtns.forEach((b) => asp.append(b));
    const sync = () => abtns.forEach((b, i) => b.classList.toggle('on', S.style.canvas.aspect === AS[i][0]));
    reg({ sync });
    const video = section(root, 'Video', true);
    video.append(h('div', { class: 'lbl muted', text: 'Format' }), asp, h('div', { style: 'height:var(--s3)' }));
    const body = video;
    select(body, 'Resolution', 'canvas.quality', [[720, '720p (HD)'], [1080, '1080p (Full HD)'], [1440, '1440p (2K)']], true);

    const optRow = (label, key, options, numeric) => {
      const sel = h('select');
      options.forEach(([v, t]) => sel.append(h('option', { value: v, text: t })));
      sel.onchange = () => { S.exportOpts[key] = numeric ? parseFloat(sel.value) : sel.value; lsSet('karaoke.export', S.exportOpts); };
      reg({ sync() { sel.value = S.exportOpts[key]; } });
      body.append(row(label, sel));
    };
    optRow('Frame rate', 'fps', [[24, '24 fps'], [30, '30 fps'], [60, '60 fps (smoother, 2× slower)']], true);
    optRow('Quality', 'quality', [['draft', 'Draft — fastest, smaller file'], ['standard', 'Standard'], ['high', 'High — best, larger file']]);
    const g = h('input', { type: 'range', min: 0, max: 0.5, step: 0.05 }), go = h('output');
    g.oninput = () => { S.exportOpts.guide = parseFloat(g.value); go.textContent = Math.round(S.exportOpts.guide * 100) + '%'; lsSet('karaoke.export', S.exportOpts); updateGuide(); };
    reg({ sync() { g.value = S.exportOpts.guide; go.textContent = Math.round(S.exportOpts.guide * 100) + '%'; } });
    const audioSec = section(root, 'Audio', true);
    audioSec.append(row('Guide vocal', g, go));
    audioSec.append(h('div', { class: 'hint', style: 'margin-bottom:0', text: 'Mixes a quiet copy of the original singer into the video, handy for learning the song. 0% = pure karaoke. Plays in the preview too.' }));

    const go2 = h('button', { class: 'btn primary big', style: 'width:100%;margin-top:var(--s1)', id: 'btnRender', text: '🎬  Render MP4', onclick: startRender });
    root.append(go2, h('div', { id: 'renderBox' }), h('div', { id: 'renderList', style: 'margin-top:16px' }));
  }

  async function startRender() {
    const btn = $('#btnRender'); btn.disabled = true;
    try {
      lsSet('karaoke.style', S.style);
      const r = await api('POST', `/api/jobs/${S.job.id}/renders`, { style: S.style, lyrics: { lines: S.lyrics.lines, offset: S.lyrics.offset }, options: S.exportOpts });
      S.render = r; pollRender();
    } catch (e) { toast(e.message, 5000); btn.disabled = false; }
  }
  function renderBox(r) {
    const box = $('#renderBox'); if (!box) return;
    if (!r) { box.innerHTML = ''; return; }
    const active = r.state === 'queued' || r.state === 'running';
    box.replaceChildren(
      h('div', { class: 'bar', style: 'margin-top:14px' }, h('i', { style: `width:${r.progress}%` })),
      h('div', { class: 'muted small', style: 'margin-top:6px', text: r.state === 'failed' ? '' : r.message }),
      r.state === 'failed' ? h('div', { class: 'err', text: r.error }) : null,
      active ? h('button', { class: 'btn small ghost danger', style: 'margin-top:8px', text: 'Cancel', onclick: () => api('DELETE', `/api/jobs/${S.job.id}/renders/${r.id}`) }) : null,
      r.state === 'done' ? downloadCard(r) : null);
  }
  function downloadCard(r) {
    return h('div', { class: 'dl' }, h('div', { style: 'flex:1' }, h('b', { text: 'Your video is ready' }), h('div', { class: 'muted small', text: `${(r.size / 1e6).toFixed(1)} MB · ${r.options.fps} fps` })),
      h('a', { class: 'btn primary', href: `/api/jobs/${S.job.id}/renders/${r.id}/download`, text: '⬇ Download MP4', download: '' }));
  }
  async function pollRender() {
    clearTimeout(S.renderPoll);
    if (!S.job || !S.render) return;
    try { S.render = await api('GET', `/api/jobs/${S.job.id}/renders/${S.render.id}`); } catch (_) { S.renderPoll = setTimeout(pollRender, 2000); return; }
    renderBox(S.render);
    if (S.render.state === 'queued' || S.render.state === 'running') S.renderPoll = setTimeout(pollRender, 700);
    else { $('#btnRender').disabled = false; loadRenders(); }
  }
  async function loadRenders() {
    if (!S.job) return;
    const list = await api('GET', `/api/jobs/${S.job.id}/renders`).catch(() => []);
    const box = $('#renderList'); if (!box) return;
    const done = list.filter((r) => r.state === 'done' && (!S.render || r.id !== S.render.id));
    box.replaceChildren(...(done.length ? [h('div', { class: 'lbl muted', text: 'Earlier exports' })] : []), ...done.slice(0, 5).map((r) =>
      h('div', { class: 'row check' }, h('span', { text: new Date(r.created * 1000).toLocaleString() + ` · ${(r.size / 1e6).toFixed(1)} MB` }), h('span', { style: 'display:flex;gap:10px;align-items:center' }, h('a', { href: `/api/jobs/${S.job.id}/renders/${r.id}/download`, text: 'Download', download: '' }),
        h('button', { class: 'btn small ghost danger', title: 'Delete this export to free disk space', text: '✕', onclick: async () => { if (confirm('Delete this exported video?')) { await api('DELETE', `/api/jobs/${S.job.id}/renders/${r.id}`); loadRenders(); } } })))));
  }

  // ------------------------------------------------------------------ boot
  route();
})();
