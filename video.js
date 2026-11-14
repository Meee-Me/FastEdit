/*
 * Fast Edit — Video mode.
 * Timeline of clips (trim, split, reorder, speed), whole-video adjustments, framing with
 * smart subject-following, text + animated effect overlays, fades, audio, scene detection,
 * Fast Edit AI commands, and export through the browser's own recorder. Runs on-device.
 */
(function () {
  "use strict";
  const FE = window.FE, AI = window.FastAI;
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h)); return c; };
  const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`; };
  const short = (t) => (t >= 10 ? Math.round(t) : Math.round(t * 10) / 10) + " s";
  const FPS = 30, PREVIEW_SHORT = 540;
  const DEF = { ...FE.DEF };
  const VGROUPS = FE.GROUPS.map(([t, items]) => [t, items.filter(([k]) => k !== "sharpen")]);
  const NAMES = { text: "Text", frame: "Frame", light_leak: "Light leak", glow: "Glow", flare: "Lens flare", stars: "Stars", birds: "Birds", sparkles: "Sparkles", snow: "Snow", rain: "Rain", bokeh: "Bokeh", confetti: "Confetti", hearts: "Hearts", moon: "Moon", sunset_stripes: "Retro sun", clouds: "Clouds", abstract: "Abstract art" };

  /* ================= state ================= */
  const V = { media: [], clips: [], overlays: [], adj: { ...DEF }, ratio: "original", follow: false, frame: { x: 0.5, y: 0.5 }, muted: false, volume: 1, fadeIn: 0, fadeOut: 0, grade: 0, sel: null, selOv: null, sfx: { level: false, hum: false, voice: false, bass: false }, tone: Tone.defaultTone(), wheels: Tone.defaultWheels(), trans: {}, music: null, sounds: [] };
  let tlZoom = 1;
  let uid = 1, started = false, PW = 960, PH = 540;
  const view = $("#vCanvas"), pctx = view.getContext("2d", { willReadFrequently: true });

  const clipLen = (c) => (c.out - c.in) / c.speed;
  const total = () => V.clips.reduce((s, c) => s + clipLen(c), 0);
  const mediaOf = (c) => V.media.find((m) => m.id === c.mediaId);
  function clipAt(t) {
    let s = 0;
    for (let i = 0; i < V.clips.length; i++) { const c = V.clips[i], L = clipLen(c); if (t < s + L - 1e-6 || i === V.clips.length - 1) return { clip: c, start: s, index: i }; s += L; }
    return null;
  }
  const startOf = (clip) => { let s = 0; for (const c of V.clips) { if (c === clip) return s; s += clipLen(c); } return 0; };
  function baseAspect() { const c = V.clips[0], m = c && mediaOf(c); return m ? m.w / m.h : 16 / 9; }
  const outAspect = () => (V.ratio === "original" ? baseAspect() : +V.ratio);
  function dims(shortSide) { const ar = outAspect(); let W, H; if (ar >= 1) { H = shortSide; W = H * ar; } else { W = shortSide; H = W / ar; } const s = Math.min(1, 1920 / Math.max(W, H)); return [Math.round((W * s) / 2) * 2, Math.round((H * s) / 2) * 2]; }

  /* ================= undo ================= */
  const undoS = [], redoS = [];
  const snap = () => ({ clips: V.clips.map((c) => ({ ...c })), overlays: V.overlays.map((o) => ({ ...o })), adj: { ...V.adj }, ratio: V.ratio, follow: V.follow, frame: { ...V.frame }, muted: V.muted, volume: V.volume, fadeIn: V.fadeIn, fadeOut: V.fadeOut, grade: V.grade, sel: V.sel, selOv: V.selOv, sfx: { ...V.sfx }, tone: Tone.cloneTone(V.tone), wheels: JSON.parse(JSON.stringify(V.wheels)), trans: JSON.parse(JSON.stringify(V.trans)), music: V.music ? { ...V.music } : null, sounds: V.sounds.map((x) => ({ ...x })) });
  function pushUndo() { undoS.push(snap()); if (undoS.length > 40) undoS.shift(); redoS.length = 0; updUndo(); }
  function restore(s) { Object.assign(V, s); applyVolume(); rebuildAll(); syncMusic(P.t, false); syncSounds(P.t, false); resize(); refreshAll(); seek(Math.min(P.t, total())); }
  function undo() { if (!undoS.length) return; redoS.push(snap()); restore(undoS.pop()); updUndo(); }
  function redo() { if (!redoS.length) return; undoS.push(snap()); restore(redoS.pop()); updUndo(); }
  function updUndo() { $("#vUndo").disabled = !undoS.length; $("#vRedo").disabled = !redoS.length; }

  /* ================= media ================= */
  function thumbFrom(src, w, h) { const c = mk(160, Math.round((160 * h) / w)); c.getContext("2d").drawImage(src, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.6); }
  function seekEl(el, t) {
    t = Math.max(0, Math.min(t, (isFinite(el.duration) ? el.duration : t + 1) - 0.002));
    if (Math.abs(el.currentTime - t) < 0.0005 && el.readyState >= 2) return Promise.resolve();
    return new Promise((res) => { const done = () => { el.removeEventListener("seeked", done); clearTimeout(to); res(); }; const to = setTimeout(done, 2500); el.addEventListener("seeked", done); el.currentTime = t; });
  }
  function makeSample() {
    const w = 1280, h = 720, hz = h * 0.62, r = AI.rngFrom(7);
    const m = { id: uid++, kind: "synthetic", name: "Sample: alpine timelapse (generated)", w, h, duration: 10, canvas: mk(w, h), sample: true };
    m.ctx = m.canvas.getContext("2d");
    const mtn = mk(w, h), x = mtn.getContext("2d");
    const ridge = (base, amp, col, rough) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, hz); let yy = base; for (let px = 0; px <= w; px += w / 90) { yy += (r() - 0.5) * amp * rough; yy = Math.max(base - amp, Math.min(base + amp * 0.3, yy)); x.lineTo(px, yy); } x.lineTo(w, hz); x.closePath(); x.fill(); };
    ridge(hz - h * 0.2, h * 0.16, "#6b5a7e", 0.5); ridge(hz - h * 0.11, h * 0.11, "#463c5c", 0.6); ridge(hz - h * 0.04, h * 0.06, "#2a2638", 0.7);
    x.fillStyle = "#121019"; for (let px = -20; px < w * 0.42; px += 14 + r() * 18) { const th = h * (0.06 + r() * 0.12), tw = th * 0.32; x.beginPath(); x.moveTo(px, hz + 4); x.lineTo(px + tw / 2, hz - th); x.lineTo(px + tw, hz + 4); x.fill(); } x.fillRect(0, hz - 2, w * 0.45, 8);
    const stars = Array.from({ length: 170 }, () => [r() * w, r() * hz * 0.55, 0.3 + r() * 0.7, r() * 6.28]);
    const clouds = Array.from({ length: 6 }, () => ({ x: r(), y: 0.1 + r() * 0.25, s: 0.06 + r() * 0.08, v: 0.01 + r() * 0.015 }));
    const shim = Array.from({ length: 170 }, () => [r(), r(), 20 + r() * 80, r() * 6.28]);
    const lerp = (a, b, t) => a + (b - a) * t;
    const pick = (stops, p) => { const i = p < 0.5 ? 0 : 1, t = p < 0.5 ? p / 0.5 : (p - 0.5) / 0.5; return `rgb(${stops[i].map((v, k) => Math.round(lerp(v, stops[i + 1][k], t))).join(",")})`; };
    const TOP = [[70, 110, 170], [40, 40, 90], [8, 10, 28]], MID = [[150, 140, 190], [110, 80, 130], [25, 22, 50]], HOR = [[245, 200, 150], [233, 138, 91], [70, 40, 80]];
    m.draw = (c, t) => {
      const p = clamp(t / m.duration, 0, 1);
      const g = c.createLinearGradient(0, 0, 0, hz); g.addColorStop(0, pick(TOP, p)); g.addColorStop(0.55, pick(MID, p)); g.addColorStop(1, pick(HOR, p));
      c.globalAlpha = 1; c.fillStyle = g; c.fillRect(0, 0, w, hz);
      const sa = clamp((p - 0.4) / 0.5, 0, 1);
      if (sa > 0) for (const [sx, sy, a, ph] of stars) { c.globalAlpha = sa * a * (0.75 + 0.25 * Math.sin(t * 3 + ph)); c.fillStyle = "#fff"; c.fillRect(sx, sy, 1.6, 1.6); }
      c.globalAlpha = 1;
      const sx = w * 0.64, sy = lerp(hz - h * 0.34, hz + h * 0.03, p);
      const glow = c.createRadialGradient(sx, sy, 0, sx, sy, w * 0.35); glow.addColorStop(0, `rgba(255,226,160,${0.9 - p * 0.5})`); glow.addColorStop(0.1, `rgba(255,190,120,${0.55 - p * 0.3})`); glow.addColorStop(1, "rgba(255,160,100,0)");
      c.fillStyle = glow; c.fillRect(0, 0, w, hz); c.fillStyle = "#fff1cc"; c.beginPath(); c.arc(sx, sy, w * 0.028, 0, 7); c.fill();
      for (const cl of clouds) { const cx = ((cl.x + t * cl.v) % 1.3 - 0.15) * w, cy = cl.y * h, R = cl.s * w; const cg = c.createRadialGradient(cx, cy, 0, cx, cy, R); const tone = p < 0.5 ? "255,236,225" : "120,95,140"; cg.addColorStop(0, `rgba(${tone},.5)`); cg.addColorStop(1, `rgba(${tone},0)`); c.fillStyle = cg; c.beginPath(); c.ellipse(cx, cy, R, R * 0.35, 0, 0, 7); c.fill(); }
      c.drawImage(mtn, 0, 0);
      c.fillStyle = "#1b1a2e"; c.fillRect(0, hz, w, h - hz);
      c.save(); c.translate(0, hz * 2); c.scale(1, -1); c.globalAlpha = 0.55; c.drawImage(m.canvas, 0, 0, w, hz, 0, 0, w, hz); c.restore();
      const wg = c.createLinearGradient(0, hz, 0, h); wg.addColorStop(0, "rgba(40,50,90,.25)"); wg.addColorStop(1, "rgba(12,16,32,.95)"); c.fillStyle = wg; c.fillRect(0, hz, w, h - hz);
      for (const [x0, y0, len, ph] of shim) { c.fillStyle = `rgba(255,220,170,${(0.05 + 0.1 * (0.5 + 0.5 * Math.sin(t * 2 + ph))) * (1 - p * 0.6)})`; c.fillRect((x0 + Math.sin(t * 0.7 + ph) * 0.01) * w, hz + y0 * (h - hz), len, 1); }
    };
    m.draw(m.ctx, 2); m.thumb = thumbFrom(m.canvas, w, h);
    return m;
  }
  function fixDuration(el) { return new Promise((res) => { const on = () => { if (isFinite(el.duration)) { el.removeEventListener("durationchange", on); el.currentTime = 0; res(); } }; el.addEventListener("durationchange", on); el.currentTime = 1e9; setTimeout(res, 4000); }); }
  function loadVideoFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), el = document.createElement("video");
      el.preload = "auto"; el.playsInline = true; el.setAttribute("playsinline", ""); el.src = url;
      el.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`“${file.name}” can't be played in this browser.`)); };
      el.onloadedmetadata = async () => {
        if (!isFinite(el.duration)) await fixDuration(el);
        if (!el.videoWidth) { reject(new Error(`“${file.name}” has no video track.`)); return; }
        const m = { id: uid++, kind: "video", name: file.name.replace(/\.[^.]+$/, ""), url, el, w: el.videoWidth, h: el.videoHeight, duration: el.duration };
        await seekEl(el, Math.min(0.4, m.duration / 3));
        if (el.readyState < 2) await new Promise((r) => { el.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 2000); });
        try { m.thumb = thumbFrom(el, m.w, m.h); } catch { m.thumb = ""; }
        connectMedia(m); applyVolume();
        resolve(m);
      };
    });
  }
  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { const m = { id: uid++, kind: "image", name: file.name.replace(/\.[^.]+$/, ""), url, el: img, w: img.naturalWidth, h: img.naturalHeight, duration: 600 }; m.thumb = thumbFrom(img, m.w, m.h); resolve(m); };
      img.onerror = () => reject(new Error(`“${file.name}” isn't an image this browser can open.`));
      img.src = url;
    });
  }
  function loadAudioFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), el = document.createElement("audio");
      el.preload = "auto"; el.src = url;
      el.onloadedmetadata = () => resolve({ id: uid++, kind: "audio", name: file.name.replace(/\.[^.]+$/, ""), url, el, duration: el.duration, w: 1, h: 1 });
      el.onerror = () => reject(new Error(`“${file.name}” can't be played in this browser.`));
    });
  }
  async function addFiles(files) {
    const isVid = (f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv|ogv)$/i.test(f.name), isImg = (f) => f.type.startsWith("image/");
    const vids = [...files].filter((f) => isVid(f) || isImg(f));
    if (!vids.length) return FE.toast("Choose a video or photo (MP4, MOV, WebM, JPEG, PNG)");
    busy(true, "Loading video…");
    pushUndo();
    const replaceSample = V.clips.length && V.clips.every((c) => mediaOf(c).sample);
    if (replaceSample) { V.clips = []; V.overlays = []; }
    let added = 0;
    for (const f of vids) {
      try {
        if (isImg(f)) { const m = await loadImageFile(f); V.media.push(m); V.clips.push({ id: uid++, mediaId: m.id, in: 0, out: 4, speed: 1, kb: true }); }
        else { const m = await loadVideoFile(f); V.media.push(m); V.clips.push({ id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 }); analyzeAudio(m).then(() => renderTimeline()); }
        added++;
      }
      catch (e) { FE.toast(e.message); }
    }
    busy(false);
    if (!added) { undoS.pop(); updUndo(); return; }
    resize(); refreshAll(); seek(replaceSample ? 0 : P.t);
    FE.toast(added === 1 ? "Added 1 clip to the timeline" : `Added ${added} clips to the timeline`);
  }

  /* ================= audio ================= */
  let AC = null, monitor = null, recDest = null;
  function ensureAudio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); monitor = AC.createGain(); monitor.connect(AC.destination); recDest = AC.createMediaStreamDestination(); } catch { AC = null; return; } }
    if (AC.state === "suspended") AC.resume().catch(() => {});
    V.media.forEach(connectMedia); applyVolume();
  }
  function connectMusic(m) {
    if (!AC || m.mnode) return;
    try { m.mnode = AC.createMediaElementSource(m.el); m.mgain = AC.createGain(); m.mnode.connect(m.mgain); m.mgain.connect(monitor); m.mgain.connect(recDest); } catch {}
  }
  const musicMedia = () => (V.music ? V.media.find((m) => m.id === V.music.mediaId) : null);
  function speechAt(t) {
    const at = clipAt(t); if (!at) return false;
    const m = mediaOf(at.clip), a = m.audio; if (!a || a.none || !a.has || V.muted) return false;
    const lt = at.clip.in + (t - at.start) * at.clip.speed, w = Math.floor(lt * a.rate);
    let mx = -99; for (let k = w - 3; k <= w + 3; k++) if (k >= 0 && k < a.db.length) mx = Math.max(mx, a.db[k]);
    return mx > a.loud - 12;
  }
  function syncSounds(t, playing) {
    for (const sd of V.sounds) {
      const m = V.media.find((x) => x.id === sd.mediaId); if (!m) continue;
      if (AC) connectMusic(m);
      const local = t - sd.start, inRange = local >= 0 && local < m.duration - 0.03;
      if (playing && inRange) { if (m.el.paused) { m.el.currentTime = local; m.el.play().catch(() => {}); } else if (Math.abs(m.el.currentTime - local) > 0.3) m.el.currentTime = local; }
      else if (!m.el.paused) m.el.pause();
      if (m.mgain) m.mgain.gain.value = sd.vol; else m.el.volume = clamp(sd.vol, 0, 1);
    }
  }
  function syncMusic(t, playing) {
    const m = musicMedia();
    const soundIds = new Set(V.sounds.map((x) => x.mediaId));
    for (const o of V.media) if (o.kind === "audio" && o !== m && !soundIds.has(o.id) && !o.el.paused) o.el.pause();
    if (!m) return;
    if (AC) connectMusic(m);
    const local = t - V.music.start, inRange = local >= 0 && local < m.duration - 0.05 && t < total() - 0.02;
    if (playing && inRange) {
      if (m.el.paused) { m.el.currentTime = local; m.el.play().catch(() => {}); }
      else if (Math.abs(m.el.currentTime - local) > 0.3) m.el.currentTime = local;
    } else if (!m.el.paused) m.el.pause();
    let g = V.music.vol;
    const T = total(); if (T - t < 1.5) g *= clamp((T - t) / 1.5, 0, 1);
    if (V.music.duck && speechAt(t)) g *= 0.25;
    if (m.mgain) m.mgain.gain.setTargetAtTime(g, AC.currentTime, 0.12); else m.el.volume = clamp(g, 0, 1);
  }
  function connectMedia(m) {
    if (m.kind !== "video" || m.node || !AC) return;
    try { m.node = AC.createMediaElementSource(m.el); m.gain = AC.createGain(); m.gain.connect(monitor); m.gain.connect(recDest); rebuildChain(m); } catch {}
  }
  // source -> [low cut] -> [hum notches] -> [voice EQ] -> [bass] -> [compressor + level gain] -> volume
  function buildFx(ctx, m) {
    const fx = [], f = V.sfx, a = m.audio && !m.audio.none ? m.audio : null;
    const biquad = (type, freq, q, gain) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq; if (q != null) n.Q.value = q; if (gain != null) n.gain.value = gain; return n; };
    if (f.hum || f.voice) fx.push(biquad("highpass", f.hum ? 85 : 70, 0.7));
    if (f.hum) for (const hz of a && a.hum ? [a.hum, a.hum * 2, a.hum * 3] : [50, 60, 100, 120]) fx.push(biquad("notch", hz, 30));
    if (f.voice) { fx.push(biquad("lowshelf", 200, null, -3)); fx.push(biquad("peaking", 3000, 0.9, 5)); }
    if (f.bass) fx.push(biquad("lowshelf", 120, null, 7));
    if (f.level) {
      const c = ctx.createDynamicsCompressor(); c.threshold.value = -26; c.knee.value = 12; c.ratio.value = 4; c.attack.value = 0.005; c.release.value = 0.25; fx.push(c);
      const g = ctx.createGain(); g.gain.value = a ? a.norm : 1.5; fx.push(g);
    }
    return fx;
  }
  function rebuildChain(m) {
    if (!m.node || !AC) return;
    try { m.node.disconnect(); } catch {}
    for (const n of m.fx || []) { try { n.disconnect(); } catch {} }
    const fx = buildFx(AC, m);
    let prev = m.node; for (const n of fx) { prev.connect(n); prev = n; } prev.connect(m.gain);
    m.fx = fx;
  }
  function rebuildAll() { for (const m of V.media) rebuildChain(m); }
  function applyVolume() { const v = V.muted ? 0 : V.volume; for (const m of V.media) { if (m.kind !== "video") continue; if (m.gain) m.gain.gain.value = v; else if (m.el) { m.el.muted = V.muted; m.el.volume = clamp(V.volume, 0, 1); } } }

  /* ================= sound analysis ================= */
  // Decodes a clip's soundtrack once and keeps only a loudness curve (20 per second),
  // the hum frequency if there is one, and the gain that brings speech to a steady level.
  async function analyzeAudio(m) {
    if (m.audio) return m.audio;
    if (m.kind !== "video" && m.kind !== "audio") return (m.audio = { none: true });
    try {
      const buf = await (await fetch(m.url)).arrayBuffer();
      if (buf.byteLength > 500e6) return (m.audio = { none: true, tooBig: true });
      const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const RATE = 22050, ab = await new OC(1, 1, RATE).decodeAudioData(buf);
      const n = ab.length, ch = ab.numberOfChannels, mono = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
      const sr = ab.sampleRate, hop = Math.round(sr / 20), W = Math.ceil(n / hop), db = new Float32Array(W);
      for (let w = 0; w < W; w++) { let e = 0; const a = w * hop, b = Math.min(n, a + hop); for (let i = a; i < b; i++) e += mono[i] * mono[i]; db[w] = 10 * Math.log10(e / Math.max(1, b - a) + 1e-10); }
      // hum: Goertzel power at mains frequencies vs their neighbours
      const len = Math.min(n, sr * 20), power = (hz) => { const k = 2 * Math.cos((2 * Math.PI * hz) / sr); let s1 = 0, s2 = 0; for (let i = 0; i < len; i++) { const s0 = mono[i] + k * s1 - s2; s2 = s1; s1 = s0; } return s1 * s1 + s2 * s2 - k * s1 * s2; };
      const r50 = power(50) / ((power(42) + power(56)) / 2 + 1e-12), r60 = power(60) / ((power(54) + power(68)) / 2 + 1e-12);
      const hum = Math.max(r50, r60) > 6 ? (r50 > r60 ? 50 : 60) : null;
      const sorted = [...db].filter((v) => v > -70).sort((x, y) => x - y);
      const loud = sorted.length ? sorted[Math.floor(sorted.length * 0.8)] : -70;
      return (m.audio = { rate: 20, db, hum, loud, has: sorted.length > 0 && sorted[sorted.length - 1] > -50, norm: clamp(Math.pow(10, (-16 - loud) / 20), 0.6, 6) });
    } catch (e) { return (m.audio = { none: true }); }
  }
  async function analyzeAllAudio(progress) { const list = usedMedia(); let i = 0; for (const m of list) { await analyzeAudio(m); progress && progress(++i / list.length); } rebuildAll(); }
  const hasSound = () => usedMedia().some((m) => m.audio && !m.audio.none && m.audio.has);
  // Quiet stretches in a clip's own time, shrunk by a little padding so words aren't clipped.
  function silentRanges(m, minLen) {
    const a = m.audio; if (!a || a.none || !a.has) return [];
    const s = [...a.db].sort((x, y) => x - y), p10 = s[Math.floor(s.length * 0.1)], p90 = s[Math.floor(s.length * 0.9)];
    if (p90 - p10 < 10) return [];
    const thr = Math.max(-58, Math.min(p10 + (p90 - p10) * 0.3, p90 - 15)), pad = 0.12, out = [];
    let start = -1;
    for (let w = 0; w <= a.db.length; w++) {
      const quiet = w < a.db.length && a.db[w] < thr;
      if (quiet && start < 0) start = w;
      if (!quiet && start >= 0) { const t0 = start / a.rate, t1 = w / a.rate; if (t1 - t0 >= minLen) out.push({ a: t0 + pad, b: t1 - pad }); start = -1; }
    }
    return out;
  }
  async function removeSilence(long) {
    await analyzeAllAudio((p) => ($("#vBusyText").textContent = `Listening to the sound… ${Math.round(p * 100)}%`));
    if (!hasSound()) return { cut: 0, msg: "found no sound to listen to, so nothing was removed" };
    const cuts = []; let st = 0;
    for (const c of V.clips) {
      for (const r of silentRanges(mediaOf(c), long ? 1.0 : 0.55)) {
        const a = Math.max(r.a, c.in), b = Math.min(r.b, c.out);
        if (b - a >= 0.2) cuts.push([st + (a - c.in) / c.speed, st + (b - c.in) / c.speed]);
      }
      st += clipLen(c);
    }
    const T = total(), removed = cuts.reduce((x, [a, b]) => x + b - a, 0);
    if (!cuts.length) return { cut: 0, msg: "listened for silent parts and found none" };
    if (T - removed < 0.5) return { cut: 0, msg: "found almost nothing but silence, so I left it alone" };
    cuts.sort((x, y) => y[0] - x[0]).forEach(([a, b]) => cutRange(a, b));
    return { cut: removed, msg: `removed ${cuts.length} silent part${cuts.length > 1 ? "s" : ""} (${short(removed)}), now ${short(total())} long` };
  }

  /* ================= smart shortening ================= */
  // Scores short windows by movement, sound and colour and keeps the best ones in order.
  async function bestParts(target, progress) {
    const T = total();
    target = clamp(target || Math.min(15, T * 0.5), 1, T);
    if (target >= T - 0.3) return `it's already ${short(T)}, so nothing needed cutting`;
    await analyzeAllAudio();
    const win = clamp(target / 6, 0.75, 3), n = Math.ceil(T / win), rows = [];
    for (let i = 0; i < n; i++) {
      const t0 = i * win, t1 = Math.min(T, t0 + win), mid = (t0 + t1) / 2, at = clipAt(mid), m = mediaOf(at.clip);
      const lt = at.clip.in + (mid - at.start) * at.clip.speed, d = 0.15 * at.clip.speed;
      const fa = await frameOf(m, clamp(lt - d, 0, m.duration - 0.05), 64), fb = await frameOf(m, clamp(lt + d, 0, m.duration - 0.05), 64);
      const A = fa.getContext("2d").getImageData(0, 0, fa.width, fa.height).data, B = fb.getContext("2d").getImageData(0, 0, fb.width, fb.height).data;
      let motion = 0, lum = 0, sat = 0, lsq = 0; const px = B.length / 4;
      for (let k = 0; k < B.length; k += 4) { const la = 0.2126 * A[k] + 0.7152 * A[k + 1] + 0.0722 * A[k + 2], lb = 0.2126 * B[k] + 0.7152 * B[k + 1] + 0.0722 * B[k + 2]; motion += Math.abs(la - lb); lum += lb; lsq += lb * lb; const mx = Math.max(B[k], B[k + 1], B[k + 2]), mn = Math.min(B[k], B[k + 1], B[k + 2]); sat += mx ? (mx - mn) / mx : 0; }
      lum /= px; const contrast = Math.sqrt(Math.max(0, lsq / px - lum * lum));
      let sound = null; const a = m.audio;
      if (a && !a.none && a.has) { const la = at.clip.in + (t0 - at.start) * at.clip.speed, lb = at.clip.in + (t1 - at.start) * at.clip.speed; let e = 0, c = 0; for (let w = Math.floor(la * a.rate); w < Math.ceil(lb * a.rate) && w < a.db.length; w++) { e += a.db[w]; c++; } sound = c ? e / c : null; }
      rows.push({ t0, t1, motion: motion / px, look: sat / px + contrast / 128, sound, dark: lum < 20 });
      progress && progress((i + 1) / n);
    }
    const norm = (key) => { const v = rows.map((r) => r[key]).filter((x) => x != null), lo = Math.min(...v), hi = Math.max(...v); for (const r of rows) r[key + "N"] = r[key] == null || hi - lo < 1e-6 ? 0.5 : (r[key] - lo) / (hi - lo); };
    norm("motion"); norm("look"); norm("sound");
    const withSound = rows.some((r) => r.sound != null);
    for (const r of rows) r.score = (withSound ? 0.45 * r.motionN + 0.35 * r.soundN + 0.2 * r.lookN : 0.65 * r.motionN + 0.35 * r.lookN) - (r.dark ? 0.3 : 0);
    const pick = [...rows].sort((x, y) => y.score - x.score), keep = new Set(); let kept = 0;
    for (const r of pick) { if (kept >= target - 0.05) break; keep.add(r); kept += r.t1 - r.t0; }
    const drop = rows.filter((r) => !keep.has(r));
    drop.sort((x, y) => y.t0 - x.t0).forEach((r) => cutRange(r.t0, r.t1));
    let runs = 0, prev = false; for (const r of rows) { const k = keep.has(r); if (k && !prev) runs++; prev = k; }
    return `shortened it to the best ${short(total())} (${runs} moment${runs > 1 ? "s" : ""} with the most ${withSound ? "movement and sound" : "movement"})`;
  }

  /* ================= pixels ================= */
  const pixCache = { key: "", vig: null, noise: null };
  const needsPixels = () => V.grade > 0 || Object.keys(DEF).some((k) => k !== "blur" && k !== "sharpen" && V.adj[k]);
  function processFrame(img, W, H, frameNo) {
    const a = V.adj, d = img.data, key = W + "x" + H;
    if (pixCache.key !== key) { pixCache.key = key; pixCache.vig = null; pixCache.noise = null; }
    const ex = Math.pow(2, a.exposure / 50), c = a.contrast * 1.28, cf = (259 * (c + 255)) / (255 * (259 - c));
    const temp = a.temperature * 0.45, tint = a.tint * 0.35, sh = a.shadows / 100, hi = a.highlights / 100;
    const sat = 1 + a.saturation / 100, vib = a.vibrance / 100, fade = a.fade / 100, sep = a.sepia / 100, mono = a.mono / 100, grade = V.grade;
    // per-channel lookup for exposure + white balance
    const lr = new Float32Array(256), lg = new Float32Array(256), lb = new Float32Array(256);
    for (let v = 0; v < 256; v++) { const b = v * ex; lr[v] = b + temp + tint * 0.25; lg[v] = b - tint; lb[v] = b - temp + tint * 0.25; }
    let hm = null;
    if (a.hue) { const r = (a.hue * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r); hm = [0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928, 0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283, 0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072]; }
    let vig = null; if (a.vignette) { if (!pixCache.vig) { pixCache.vig = new Float32Array(W * H); const cx = W / 2, cy = H / 2, md = Math.hypot(cx, cy); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = Math.hypot(x - cx, y - cy) / md, s = t < 0.3 ? 0 : (t - 0.3) / 0.7; pixCache.vig[y * W + x] = s * s * (3 - 2 * s); } } vig = pixCache.vig; }
    let noise = null; if (a.grain) { if (!pixCache.noise) { pixCache.noise = new Int8Array(W * H + 4096); const r = AI.rngFrom(99); for (let i = 0; i < pixCache.noise.length; i++) pixCache.noise[i] = Math.round((r() - 0.5) * 254); } noise = pixCache.noise; }
    const vk = (a.vignette / 100) * 0.85, gk = (a.grain / 100) * 48 / 127, off = ((frameNo * 2477) % 4096) | 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
      if (sh || hi) { let L = (0.299 * r + 0.587 * g + 0.114 * b) / 255; L = L < 0 ? 0 : L > 1 ? 1 : L; const add = sh * (1 - L) * (1 - L) * 110 + hi * L * L * 110; r += add; g += add; b += add; }
      if (c) { r = (r - 128) * cf + 128; g = (g - 128) * cf + 128; b = (b - 128) * cf + 128; }
      if (hm) { const r0 = r, g0 = g, b0 = b; r = hm[0] * r0 + hm[1] * g0 + hm[2] * b0; g = hm[3] * r0 + hm[4] * g0 + hm[5] * b0; b = hm[6] * r0 + hm[7] * g0 + hm[8] * b0; }
      if (sat !== 1 || vib) { const gr = 0.299 * r + 0.587 * g + 0.114 * b; let s = sat; if (vib) { const mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b; let cur = (mx - mn) / 255; cur = cur > 1 ? 1 : cur < 0 ? 0 : cur; s *= 1 + vib * (1 - cur); } r = gr + (r - gr) * s; g = gr + (g - gr) * s; b = gr + (b - gr) * s; }
      if (sep) { const tr = 0.393 * r + 0.769 * g + 0.189 * b, tg = 0.349 * r + 0.686 * g + 0.168 * b, tb = 0.272 * r + 0.534 * g + 0.131 * b; r += (tr - r) * sep; g += (tg - g) * sep; b += (tb - b) * sep; }
      if (mono) { const gr = 0.299 * r + 0.587 * g + 0.114 * b; r += (gr - r) * mono; g += (gr - g) * mono; b += (gr - b) * mono; }
      if (grade) { const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, k = grade * 0.22; r += (20 + L * 235 - r) * k * 0.6; g += (120 + L * 20 - g) * k * 0.4; b += (135 - L * 95 - b) * k * 0.6; }
      if (fade) { const k = 1 - 0.25 * fade, add = 42 * fade; r = r * k + add; g = g * k + add; b = b * k + add; }
      if (vig) { const f = 1 - vk * vig[p]; r *= f; g *= f; b *= f; }
      if (noise) { const n = noise[p + off] * gk; r += n; g += n; b += n; }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  }

  /* ================= overlays ================= */
  function parts(ov, n, gen) { if (!ov.parts) { const r = AI.rngFrom(ov.job.seed >>> 0); ov.parts = Array.from({ length: n }, () => gen(r)); } return ov.parts; }
  const g2 = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283 * v); };
  const ANIM = {
    snow: { blend: "source-over", draw(c, W, H, t, ov) { const sc = Math.min(W, H) / 720; for (const p of parts(ov, Math.round(260 * ov.k), (r) => ({ x: r(), y: r(), s: r(), ph: r() * 6.28 }))) { const y = (((p.y + t * (0.035 + p.s * 0.08)) % 1.1) - 0.05) * H, x = (p.x + Math.sin(t * 0.8 + p.ph) * 0.012 * (1 + p.s)) * W, R = (1 + p.s * p.s * 4.5) * sc; const g = c.createRadialGradient(x, y, 0, x, y, R); g.addColorStop(0, "rgba(255,255,255,.95)"); g.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = g; c.fillRect(x - R, y - R, R * 2, R * 2); } }, msg: "let snow fall through the whole video" },
    rain: { blend: "source-over", draw(c, W, H, t, ov) { const sc = Math.min(W, H) / 720; c.lineCap = "round"; for (const p of parts(ov, Math.round(320 * ov.k), (r) => ({ x: r() * 1.2 - 0.1, y: r(), s: r() }))) { const y = (((p.y + t * (1.1 + p.s * 0.9)) % 1.2) - 0.1) * H, x = p.x * W - y * 0.12, L = (18 + p.s * 40) * sc; c.strokeStyle = `rgba(215,228,255,${0.15 + p.s * 0.35})`; c.lineWidth = (0.7 + p.s * 1.2) * sc; c.beginPath(); c.moveTo(x, y); c.lineTo(x - L * 0.22, y + L); c.stroke(); } }, msg: "added falling rain" },
    confetti: { blend: "source-over", draw(c, W, H, t, ov) { const sc = Math.min(W, H) / 720, cols = ["#ff4d6d", "#ffd23f", "#3ec1d3", "#7b5cff", "#4cd964", "#ff8a2b", "#ffffff"]; for (const p of parts(ov, Math.round(170 * ov.k), (r) => ({ x: r(), y: r(), v: r(), ph: r() * 6.28, c: (r() * 7) | 0 }))) { const y = (((p.y + t * (0.1 + p.v * 0.16)) % 1.15) - 0.08) * H, x = (p.x + Math.sin(t * 1.5 + p.ph) * 0.02) * W, rot = p.ph + t * (2 + p.v * 4), s = (5 + p.v * 6) * sc; c.save(); c.translate(x, y); c.rotate(rot); c.scale(1, Math.abs(Math.cos(rot * 1.3)) + 0.15); c.fillStyle = cols[p.c]; c.fillRect(-s, -s * 0.4, s * 2, s * 0.8); c.restore(); } }, msg: "added falling confetti" },
    sparkles: { blend: "screen", draw(c, W, H, t, ov) { const A = ov.A, sc = Math.min(W, H) / 720; for (const p of parts(ov, Math.round(28 * ov.k), (r) => { const near = r() < 0.7; return { x: near ? A.bright.x + g2(r) * 0.12 : r(), y: near ? A.bright.y + g2(r) * 0.1 : r(), v: r(), ph: r() * 6.28, s: r() }; })) { const a = Math.max(0, Math.sin(t * (2 + p.v * 3) + p.ph)); if (a < 0.05) continue; const x = p.x * W, y = p.y * H, R = (6 + p.s * p.s * 22) * sc * a; const g = c.createRadialGradient(x, y, 0, x, y, R * 1.6); g.addColorStop(0, `rgba(255,245,215,${0.5 * a})`); g.addColorStop(1, "rgba(255,245,215,0)"); c.fillStyle = g; c.fillRect(x - R * 2, y - R * 2, R * 4, R * 4); c.fillStyle = `rgba(255,250,235,${a})`; c.beginPath(); c.moveTo(x, y - R); c.quadraticCurveTo(x, y, x + R, y); c.quadraticCurveTo(x, y, x, y + R); c.quadraticCurveTo(x, y, x - R, y); c.quadraticCurveTo(x, y, x, y - R); c.fill(); } }, msg: "added twinkling sparkles around the main light" },
    bokeh: { blend: "screen", draw(c, W, H, t, ov) { const sc = Math.min(W, H) / 720, cols = ov.A.palette.map((p) => [Math.min(255, p.r + (255 - p.r) * 0.5), Math.min(255, p.g + (255 - p.g) * 0.5), Math.min(255, p.b + (255 - p.b) * 0.5)]).concat([[255, 200, 120], [255, 230, 180]]); for (const p of parts(ov, Math.round(32 * ov.k), (r) => ({ x: r(), y: r(), s: r(), ph: r() * 6.28, c: (r() * 7) | 0 }))) { const col = cols[p.c % cols.length], x = (p.x + Math.sin(t * 0.25 + p.ph) * 0.03) * W, y = (p.y + Math.cos(t * 0.2 + p.ph) * 0.03) * H, R = (12 + p.s * 50) * sc, a = 0.16 + 0.12 * Math.sin(t * 1.3 + p.ph); c.fillStyle = `rgba(${col.join(",")},${a})`; c.beginPath(); c.arc(x, y, R, 0, 7); c.fill(); c.strokeStyle = `rgba(${col.join(",")},${a + 0.15})`; c.lineWidth = R * 0.08; c.stroke(); } }, msg: "added drifting bokeh lights" },
    hearts: { blend: "source-over", draw(c, W, H, t, ov) { const sc = Math.min(W, H) / 720; for (const p of parts(ov, Math.round(18 * ov.k), (r) => ({ x: r(), y: r(), v: r(), ph: r() * 6.28, s: r() }))) { const y = (1.1 - ((p.y + t * (0.05 + p.v * 0.07)) % 1.25)) * H, x = (p.x + Math.sin(t * 1.2 + p.ph) * 0.03) * W, s = (12 + p.s * p.s * 36) * sc; c.save(); c.translate(x, y); c.rotate(Math.sin(t + p.ph) * 0.2); c.globalAlpha = 0.85; const g = c.createLinearGradient(0, -s, 0, s); g.addColorStop(0, "#ff8fb8"); g.addColorStop(1, "#e2245a"); c.fillStyle = g; c.beginPath(); c.moveTo(0, -s * 0.25); c.bezierCurveTo(-s * 0.5, -s * 0.75, -s * 1.1, -s * 0.05, 0, s * 0.6); c.bezierCurveTo(s * 1.1, -s * 0.05, s * 0.5, -s * 0.75, 0, -s * 0.25); c.fill(); c.restore(); } }, msg: "floated hearts up the frame" },
  };
  function addOverlay(job, A, opt = {}) {
    job = { ...job, seed: job.seed ?? ((Math.random() * 2 ** 31) | 0) };
    const anim = !!ANIM[job.kind];
    const T = total(), start = clamp(opt.start ?? 0, 0, T), end = opt.end != null ? clamp(opt.end, start + 0.1, T) : T;
    const ov = { id: uid++, type: anim ? "anim" : "still", kind: job.kind, name: job.kind === "text" ? "Text: " + job.text : NAMES[job.kind] || job.kind, job, A, k: job.k || 1, start, end, full: opt.end == null && !opt.start, caches: {} };
    let msg = anim ? ANIM[job.kind].msg : "";
    if (!anim) { const r = AI.renderJob(job, A, mk(PW, PH), { fonts: FE.FONTS }); ov.caches[PW + "x" + PH] = r; msg = r.msg; }
    V.overlays.push(ov);
    return msg;
  }
  /* keyframes: position (x, y as a fraction of the frame from centre), scale and opacity over the overlay's own time */
  const BASE_TF = { x: 0, y: 0, s: 1, o: 1 };
  const easeIO = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  function tfAt(ov, lt) {
    const kf = ov.kf || [], base = ov.tf || BASE_TF;
    if (!kf.length) return base;
    if (lt <= kf[0].t) return kf[0]; if (lt >= kf[kf.length - 1].t) return kf[kf.length - 1];
    let i = 1; while (kf[i].t < lt) i++;
    const a = kf[i - 1], b = kf[i], k = easeIO((lt - a.t) / Math.max(1e-6, b.t - a.t));
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, s: a.s + (b.s - a.s) * k, o: a.o + (b.o - a.o) * k };
  }
  function drawOverlay(c, W, H, ov, lt) {
    const len = (ov.full ? total() : ov.end) - ov.start, T = tfAt(ov, lt);
    const edge = (ov.full || (ov.kf && ov.kf.length) ? 1 : clamp(Math.min(lt, len - lt) / 0.3, 0, 1)) * clamp(T.o, 0, 1);
    c.save(); c.globalAlpha = edge;
    if (T.x || T.y || T.s !== 1) { c.translate(W / 2 + T.x * W, H / 2 + T.y * H); c.scale(T.s, T.s); c.translate(-W / 2, -H / 2); }
    if (ov.type === "media") drawMediaOverlay(c, W, H, ov, lt);
    else if (ov.type === "anim") { c.globalCompositeOperation = ANIM[ov.kind].blend; ANIM[ov.kind].draw(c, W, H, lt, ov); }
    else {
      const key = W + "x" + H; let r = ov.caches[key];
      if (!r) { r = AI.renderJob(ov.job, ov.A, mk(W, H), { fonts: FE.FONTS }); ov.caches = { ...ov.caches, [key]: r }; }
      c.globalCompositeOperation = r.blend; c.globalAlpha = edge * r.opacity; c.drawImage(r.canvas, 0, 0, W, H);
    }
    c.restore();
  }
  /* ---------- second track: videos and photos on top ---------- */
  function auxVideo(m, role) { // a separate player for the same file, so it can run alongside the main clip
    const key = "_aux_" + role; if (!m[key]) { const el = document.createElement("video"); el.muted = true; el.playsInline = true; el.preload = "auto"; el.src = m.url; m[key] = el; } return m[key];
  }
  function mediaOverlaySource(ov) { const m = V.media.find((x) => x.id === ov.mediaId); if (!m) return null; return { m, el: m.kind === "video" ? auxVideo(m, "ov" + ov.id) : m.el }; }
  function drawMediaOverlay(c, W, H, ov) {
    const src = mediaOverlaySource(ov); if (!src) return; const { m, el } = src;
    if (m.kind === "video" && el.readyState < 2) return;
    const sc = Math.min(W / m.w, H / m.h), w = m.w * sc, h = m.h * sc, x = (W - w) / 2, y = (H - h) / 2, r = Math.min(w, h) * 0.04;
    c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = Math.min(W, H) * 0.04;
    c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); c.fillStyle = "#000"; c.fill(); c.shadowBlur = 0;
    c.save(); c.clip(); try { c.drawImage(el, x, y, w, h); } catch {} c.restore();
  }

  function auxAt(t) {
    const out = [];
    for (const ov of V.overlays) {
      if (ov.type !== "media") continue; const src = mediaOverlaySource(ov); if (!src || src.m.kind !== "video") continue;
      const e = ov.full ? total() : ov.end; if (t >= ov.start && t <= e) out.push({ el: src.el, lt: clamp((ov.srcIn || 0) + (t - ov.start), 0, src.m.duration - 0.05) });
    }
    const at = clipAt(t);
    if (at && at.index > 0) {
      const tr = V.trans[at.clip.id], tin = t - at.start;
      if (tr && needsSnap(tr.type) && tin < tr.dur) { const prev = V.clips[at.index - 1], pm = mediaOf(prev), lt = prev.out + tin * prev.speed; if (pm.kind === "video" && lt < pm.duration - 0.05) out.push({ el: auxVideo(pm, "tail"), lt, rate: prev.speed }); }
    }
    return out;
  }
  const allAux = () => { const els = []; for (const m of V.media) for (const k in m) if (k.startsWith("_aux_")) els.push(m[k]); return els; };
  function syncAux(t, playing) {
    const want = auxAt(t), live = new Set(want.map((a) => a.el));
    for (const el of allAux()) if (!live.has(el) && !el.paused) el.pause();
    for (const a of want) {
      a.el.playbackRate = a.rate || 1;
      if (playing) { if (a.el.paused) { a.el.currentTime = a.lt; a.el.play().catch(() => {}); } else if (Math.abs(a.el.currentTime - a.lt) > 0.25) a.el.currentTime = a.lt; }
      else if (!a.el.paused) a.el.pause();
    }
  }
  async function seekAux(t) { const want = auxAt(t); for (const el of allAux()) if (!el.paused) el.pause(); await Promise.all(want.map(async (a) => { if (a.el.readyState < 1) await new Promise((r) => { a.el.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 3000); }); await seekEl(a.el, a.lt); if (a.el.readyState < 2) await new Promise((r) => { a.el.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 1500); }); })); }

  /* ================= frame rendering ================= */
  function trackAt(m, lt) {
    const tr = m.track; if (!tr || !tr.length) return V.frame;
    if (lt <= tr[0].t) return tr[0]; if (lt >= tr[tr.length - 1].t) return tr[tr.length - 1];
    let i = 1; while (tr[i].t < lt) i++;
    const a = tr[i - 1], b = tr[i], k = (lt - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
  // Draws a clip's source frame into W×H with the output shape, subject-following and slow zoom.
  function drawSrc(c, W, H, clip, m, src, lt) {
    const ar = W / H, mar = m.w / m.h; let cw, ch; if (mar > ar) { ch = m.h; cw = ch * ar; } else { cw = m.w; ch = cw / ar; }
    if (clip.kb) { const pz = clamp((lt - clip.in) / Math.max(0.1, clip.out - clip.in), 0, 1), z = 1 + 0.14 * pz; cw /= z; ch /= z; }
    const f = V.follow && m.track ? trackAt(m, lt) : V.frame;
    const sx = clamp(f.x * m.w - cw / 2, 0, m.w - cw), sy = clamp(f.y * m.h - ch / 2, 0, m.h - ch);
    try { c.drawImage(src, sx, sy, cw, ch, 0, 0, W, H); } catch {}
  }
  const TR_NAMES = { cross: "Crossfade", dipb: "Dip to black", dipw: "Dip to white", wipe: "Wipe", slide: "Slide", zoom: "Zoom" };
  const needsSnap = (type) => type === "cross" || type === "wipe" || type === "slide" || type === "zoom";
  const snaps = new Map();
  const snapKey = (prev, W, H) => `${prev.id}:${prev.mediaId}:${prev.out.toFixed(3)}:${prev.kb ? 1 : 0}:${W}x${H}:${V.follow ? 1 : 0}:${V.frame.x},${V.frame.y}`;
  async function buildSnap(prev, W, H) {
    const m = mediaOf(prev), lt = Math.max(prev.in, prev.out - 0.04), c = mk(W, H), x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
    let src;
    if (m.kind === "synthetic") { m.draw(m.ctx, lt); src = m.canvas; }
    else if (m.kind === "image") src = m.el;
    else src = await frameOf(m, lt, m.w);
    drawSrc(x, W, H, prev, m, src, lt);
    return c;
  }
  let snapBusy = false;
  async function ensureSnaps(W, H) {
    if (snapBusy) return; snapBusy = true;
    try {
      for (let i = 1; i < V.clips.length; i++) {
        const tr = V.trans[V.clips[i].id]; if (!tr || !needsSnap(tr.type)) continue;
        const key = snapKey(V.clips[i - 1], W, H); if (!snaps.has(key)) snaps.set(key, await buildSnap(V.clips[i - 1], W, H));
      }
    } finally { snapBusy = false; }
  }
  const outCv = document.createElement("canvas"), outCtx = outCv.getContext("2d");
  function outgoingFrame(W, H, clip, m, src, lt) { if (outCv.width !== W || outCv.height !== H) { outCv.width = W; outCv.height = H; } outCtx.fillStyle = "#000"; outCtx.fillRect(0, 0, W, H); drawSrc(outCtx, W, H, clip, m, src, lt); return outCv; }
  function colorLUTs() {
    const key = JSON.stringify([V.wheels, V.tone]);
    if (colorLUTs.key === key) return colorLUTs.val;
    const w = Tone.wheelLUTs(V.wheels), t = Tone.buildLUTs(V.tone); let val = null;
    if (w || t) { val = {}; for (const ch of ["r", "g", "b"]) { const o = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) { const a = w ? w[ch][v] : v; o[v] = t ? t[ch][a] : a; } val[ch] = o; } }
    colorLUTs.key = key; colorLUTs.val = val; return val;
  }
  function renderFrame(c, W, H, t, o = {}) {
    c.save(); c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    const at = clipAt(t); if (!at) { c.restore(); return; }
    const { clip, start, index } = at, m = mediaOf(clip), lt = clip.in + (t - start) * clip.speed;
    let src = m.el;
    if (m.kind === "synthetic") { m.draw(m.ctx, lt); src = m.canvas; }
    if (!o.before && V.adj.blur > 0) c.filter = `blur(${((V.adj.blur / 100) * Math.max(W, H) * 0.015).toFixed(1)}px)`;
    drawSrc(c, W, H, clip, m, src, lt);
    c.filter = "none";
    // transition into this clip (blends with the previous clip's last frame)
    const tr = index > 0 ? V.trans[clip.id] : null, tin = t - start;
    let dip = 0, dipCol = "0,0,0";
    if (tr && tin < tr.dur) {
      const pIn = clamp(tin / tr.dur, 0, 1);
      if (needsSnap(tr.type)) {
        const prev = V.clips[index - 1], pm = mediaOf(prev), tailLt = prev.out + tin * prev.speed;
        let snap = null;
        if (pm.kind === "synthetic" && tailLt < pm.duration) { pm.draw(pm.ctx, tailLt); snap = outgoingFrame(W, H, prev, pm, pm.canvas, tailLt); }
        else if (pm.kind === "image") snap = outgoingFrame(W, H, prev, pm, pm.el, Math.min(prev.out, tailLt));
        else if (pm.kind === "video" && tailLt < pm.duration - 0.05) { const el = auxVideo(pm, "tail"); if (el.readyState >= 2 && Math.abs(el.currentTime - tailLt) < 0.4) snap = outgoingFrame(W, H, prev, pm, el, tailLt); }
        if (!snap) snap = snaps.get(snapKey(prev, W, H));
        if (!snap) { ensureSnaps(W, H).then(() => { if (!P.playing) redrawSoon(); }); dip = 1 - pIn; }
        else if (tr.type === "cross") { c.globalAlpha = 1 - pIn; c.drawImage(snap, 0, 0, W, H); c.globalAlpha = 1; }
        else if (tr.type === "wipe") { c.save(); c.beginPath(); c.rect(pIn * W, 0, W, H); c.clip(); c.drawImage(snap, 0, 0, W, H); c.restore(); c.fillStyle = "rgba(255,255,255,.6)"; c.fillRect(pIn * W - 1, 0, 2, H); }
        else if (tr.type === "slide") { const e = 1 - Math.pow(1 - pIn, 3), cur = mk(W, H); cur.getContext("2d").drawImage(c.canvas, 0, 0, W, H, 0, 0, W, H); c.fillStyle = "#000"; c.fillRect(0, 0, W, H); c.drawImage(snap, -e * W, 0, W, H); c.drawImage(cur, (1 - e) * W, 0, W, H); }
        else if (tr.type === "zoom") { const z = 1 + pIn * 0.6; c.globalAlpha = 1 - pIn; c.drawImage(snap, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z); c.globalAlpha = 1; }
      } else { const half = tr.dur / 2; if (tin < half) { dip = 1 - tin / half; dipCol = tr.type === "dipw" ? "255,255,255" : "0,0,0"; } }
    }
    const nx = V.clips[index + 1], trOut = nx ? V.trans[nx.id] : null, toEnd = start + clipLen(clip) - t;
    if (trOut && (trOut.type === "dipb" || trOut.type === "dipw") && toEnd < trOut.dur / 2) { dip = Math.max(dip, 1 - toEnd / (trOut.dur / 2)); dipCol = trOut.type === "dipw" ? "255,255,255" : "0,0,0"; }
    const luts = o.before ? null : colorLUTs();
    if (!o.before && (needsPixels() || luts)) { const img = c.getImageData(0, 0, W, H); if (needsPixels()) processFrame(img, W, H, Math.round(t * FPS)); if (luts) Tone.applyLUTs(img.data, luts); c.putImageData(img, 0, 0); }
    if (dip > 0) { c.fillStyle = `rgba(${dipCol},${clamp(dip, 0, 1)})`; c.fillRect(0, 0, W, H); }
    if (!o.before && !o.noOverlays) for (const ov of V.overlays) { const e = ov.full ? total() : ov.end; if (t >= ov.start && t <= e) drawOverlay(c, W, H, ov, t - ov.start); }
    if (!o.before && !o.noOverlays) { const T = total(); let a = 0; if (V.fadeIn > 0 && t < V.fadeIn) a = 1 - t / V.fadeIn; if (V.fadeOut > 0 && t > T - V.fadeOut) a = Math.max(a, 1 - (T - t) / V.fadeOut); if (a > 0) { c.fillStyle = `rgba(0,0,0,${clamp(a, 0, 1)})`; c.fillRect(0, 0, W, H); } }
    c.restore();
  }
  let before = false;
  let lastScope = 0;
  function draw() {
    if (EXP) { renderFrame(EXP.ctx, EXP.W, EXP.H, P.t); pctx.drawImage(EXP.canvas, 0, 0, PW, PH); }
    else renderFrame(pctx, PW, PH, P.t, { before });
    if (!$("#vpane-color").hidden && performance.now() - lastScope > 180) { lastScope = performance.now(); Tone.drawScope($("#vScope"), view, $("#vScopeKind").value); }
  }

  /* ================= playback ================= */
  const P = { t: 0, playing: false, raf: 0, clip: null, clipStart: 0, last: 0 };
  let seekToken = 0;
  async function seek(t) {
    const my = ++seekToken; P.t = clamp(t, 0, total());
    const at = clipAt(P.t);
    if (at) { const m = mediaOf(at.clip); if (m.kind === "video") { if (!m.el.paused) m.el.pause(); await seekEl(m.el, at.clip.in + (P.t - at.start) * at.clip.speed); } }
    await seekAux(P.t);
    if (my !== seekToken) return;
    if (!P.playing) { syncMusic(P.t, false); syncSounds(P.t, false); }
    draw(); updateTime();
  }
  async function startClipAt(t) {
    const at = clipAt(t); P.clip = at.clip; P.clipStart = at.start;
    const m = mediaOf(at.clip);
    for (const o of V.media) if (o !== m && o.kind === "video" && !o.el.paused) o.el.pause();
    if (m.kind === "video") { m.el.playbackRate = at.clip.speed; m.el.preservesPitch = true; await seekEl(m.el, at.clip.in + (t - at.start) * at.clip.speed); if (P.playing) await m.el.play().catch(() => {}); }
    P.t = t; P.last = performance.now();
  }
  async function play() {
    if (!V.clips.length || P.playing) return;
    ensureAudio();
    if (P.t >= total() - 0.02) P.t = 0;
    P.playing = true; setPlayBtn();
    await startClipAt(P.t);
    P.raf = requestAnimationFrame(loop);
  }
  function pause() { P.playing = false; cancelAnimationFrame(P.raf); for (const m of V.media) if (m.el && m.el.pause && !m.el.paused) m.el.pause(); for (const el of allAux()) if (!el.paused) el.pause(); setPlayBtn(); }
  function loop(ts) {
    if (!P.playing) return;
    const clip = P.clip, m = mediaOf(clip), end = P.clipStart + clipLen(clip);
    let t = m.kind === "video" ? P.clipStart + (m.el.currentTime - clip.in) / clip.speed : P.t + ((ts - P.last) / 1000);
    P.last = ts;
    if (t >= end - 0.001 || (m.kind === "video" && (m.el.ended || m.el.currentTime >= clip.out - 0.001))) {
      if (m.kind === "video") m.el.pause();
      if (end >= total() - 0.001) { P.t = total(); draw(); updateTime(); pause(); if (EXP) finishExport(); return; }
      P.t = end; draw();
      if (EXP?.rec?.state === "recording") EXP.rec.pause();
      startClipAt(end + 1e-4).then(() => { if (!P.playing) return; draw(); if (EXP?.rec?.state === "paused") EXP.rec.resume(); P.raf = requestAnimationFrame(loop); });
      return;
    }
    P.t = Math.max(P.clipStart, t); syncMusic(P.t, true); syncSounds(P.t, true); syncAux(P.t, true); draw(); updateTime(); followHead(); if (EXP) updateExportProgress();
    P.raf = requestAnimationFrame(loop);
  }
  function setPlayBtn() { const b = $("#vPlay"); b.textContent = P.playing ? "Pause" : "Play"; b.setAttribute("aria-label", P.playing ? "Pause" : "Play"); }
  function updateTime() {
    const T = total(); $("#vTime").textContent = `${fmt(P.t)} / ${fmt(T)}`;
    $("#vHead").style.left = (T ? (P.t / T) * $("#vTlInner").clientWidth : 0) + "px";
  }
  function followHead() {
    if (tlZoom <= 1) return;
    const tl = $("#vTimeline"), x = (P.t / Math.max(0.01, total())) * $("#vTlInner").clientWidth;
    if (x < tl.scrollLeft + 20 || x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = x - tl.clientWidth * 0.3;
  }

  /* ================= timeline editing ================= */
  function splitAt(t, quiet) {
    const at = clipAt(t); if (!at) return false;
    const { clip, start, index } = at, local = clip.in + (t - start) * clip.speed;
    if (local - clip.in < 0.05 || clip.out - local < 0.05) { if (!quiet) FE.toast("Move the playhead away from the clip's edge to split"); return false; }
    const b = { ...clip, id: uid++, in: local }; clip.out = local;
    V.clips.splice(index + 1, 0, b); return true;
  }
  function shiftOverlaysForCut(t0, t1) {
    const d = t1 - t0;
    V.overlays = V.overlays.filter((o) => {
      if (o.full) return true;
      const m = (x) => (x >= t1 ? x - d : x > t0 ? t0 : x);
      o.start = m(o.start); o.end = m(o.end); return o.end - o.start >= 0.1;
    });
  }
  function cutRange(t0, t1) {
    const T = total(); t0 = clamp(t0, 0, T); t1 = clamp(t1, 0, T); if (t1 - t0 < 0.01) return 0;
    splitAt(t0, true); splitAt(t1, true);
    let s = 0; const keep = [];
    for (const c of V.clips) { const L = clipLen(c); if (!(s >= t0 - 1e-4 && s + L <= t1 + 1e-4)) keep.push(c); s += L; }
    if (!keep.length) return 0;
    V.clips = keep; shiftOverlaysForCut(t0, t1); return t1 - t0;
  }
  function setSpeedAll(v) {
    const before = total(); V.clips.forEach((c) => (c.speed = clamp(v, 0.25, 4))); const after = total(), k = after / (before || 1);
    V.overlays.forEach((o) => { if (!o.full) { o.start *= k; o.end *= k; } });
  }

  /* ================= analysis passes ================= */
  function probeFor(m) { if (!m.probe) { m.probe = document.createElement("video"); m.probe.muted = true; m.probe.preload = "auto"; m.probe.playsInline = true; m.probe.src = m.url; } return m.probe; }
  async function frameOf(m, t, w) {
    const h = Math.round((w * m.h) / m.w), c = mk(w, h), x = c.getContext("2d", { willReadFrequently: true });
    if (m.kind === "synthetic") { m.draw(m.ctx, t); x.drawImage(m.canvas, 0, 0, w, h); }
    else if (m.kind === "image") x.drawImage(m.el, 0, 0, w, h);
    else { const p = probeFor(m); if (p.readyState < 1) await new Promise((r) => { p.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 3000); }); await seekEl(p, t); x.drawImage(p, 0, 0, w, h); }
    return c;
  }
  const usedMedia = () => [...new Set(V.clips.map((c) => c.mediaId))].map((id) => V.media.find((m) => m.id === id));
  async function analyzeTracks(progress) {
    const list = usedMedia().filter((m) => !m.track); let done = 0;
    for (const m of list) {
      const step = Math.max(0.33, m.duration / 90), raw = [];
      for (let t = 0; t <= m.duration; t += step) { const A = AI.analyze(await frameOf(m, Math.min(t, m.duration - 0.05), 192)); raw.push({ t, x: A.salCenter.x, y: A.salCenter.y }); progress((done + t / m.duration) / list.length); }
      m.track = raw.map((p, i) => { let sx = 0, sy = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(raw.length - 1, i + 3); j++) { sx += raw[j].x; sy += raw[j].y; n++; } return { t: p.t, x: sx / n, y: sy / n }; });
      done++;
    }
  }
  async function detectScenes(progress) {
    const list = usedMedia(), cutsByMedia = new Map(); let done = 0;
    for (const m of list) {
      const step = Math.max(0.2, m.duration / 300), samples = [];
      let prev = null;
      for (let t = 0; t < m.duration - 0.05; t += step) {
        const c = await frameOf(m, t, 48), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const lum = new Float32Array(d.length / 4), hist = new Float32Array(48);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) { lum[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; hist[d[i] >> 4]++; hist[16 + (d[i + 1] >> 4)]++; hist[32 + (d[i + 2] >> 4)]++; }
        const n = lum.length; for (let k = 0; k < 48; k++) hist[k] /= n;
        if (prev) { let pd = 0, hd = 0; for (let p = 0; p < n; p++) pd += Math.abs(lum[p] - prev.lum[p]); for (let k = 0; k < 48; k++) hd += Math.abs(hist[k] - prev.hist[k]); samples.push({ t, d: (pd / n / 255 + hd / 6) / 2 }); }
        prev = { lum, hist };
        progress((done + t / m.duration) / list.length);
      }
      const ds = samples.map((s) => s.d), mean = ds.reduce((a, b) => a + b, 0) / (ds.length || 1), sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / (ds.length || 1));
      const thr = Math.max(0.12, mean + 3 * sd), cuts = [];
      for (const s of samples) if (s.d > thr && (!cuts.length || s.t - cuts[cuts.length - 1] > 0.6)) cuts.push(s.t);
      cutsByMedia.set(m.id, cuts); done++;
    }
    const times = []; let st = 0;
    for (const c of V.clips) { for (const cut of cutsByMedia.get(c.mediaId) || []) if (cut > c.in + 0.3 && cut < c.out - 0.3) times.push(st + (cut - c.in) / c.speed); st += clipLen(c); }
    times.sort((a, b) => b - a).forEach((t) => splitAt(t, true));
    return times.length;
  }

  /* ================= UI: layout ================= */
  function resize() {
    [PW, PH] = dims(PREVIEW_SHORT);
    if (view.width !== PW || view.height !== PH) { view.width = PW; view.height = PH; }
    const T = total(), first = V.clips[0] && mediaOf(V.clips[0]);
    $("#vInfo").textContent = V.clips.length ? `${V.clips.length} clip${V.clips.length > 1 ? "s" : ""} · ${fmt(T)} · ${first ? first.w + "×" + first.h : ""}` : "No clips";
    const sel = $("#vRatio"); const val = String(V.ratio === "original" ? "original" : +(+V.ratio).toFixed(4));
    if (![...sel.options].some((o) => o.value === val)) sel.add(new Option((+V.ratio).toFixed(2) + ":1", val));
    sel.value = val;
  }
  function waveCanvas(m, a, b, px) {
    const A = m.audio; if (!A || A.none || !A.has || px < 8) return null;
    const c = mk(Math.min(4000, px), 40), x = c.getContext("2d"); x.fillStyle = "rgba(255,255,255,.55)";
    for (let i = 0; i < c.width; i++) { const t = a + ((b - a) * i) / c.width, w = Math.floor(t * A.rate); if (w < 0 || w >= A.db.length) continue; const v = clamp((A.db[w] + 60) / 60, 0, 1), h = Math.max(1, v * 38); x.fillRect(i, 20 - h / 2, 1, h); }
    c.className = "wave"; return c;
  }
  function renderTimeline() {
    const tl = $("#vTimeline"), inner = $("#vTlInner"), T = total(), W = tl.clientWidth * tlZoom, pps = W / Math.max(T, 0.1);
    inner.style.width = W + "px"; $("#vZoomV").textContent = Math.round(tlZoom * 100) + "%";
    const ruler = $("#vRuler"); ruler.innerHTML = "";
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 56) || 600;
    for (let t = 0; t <= T + 1e-6; t += step) { const d = document.createElement("span"); d.style.left = t * pps + "px"; d.textContent = t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${+t.toFixed(1)}s`; ruler.append(d); }
    const ch = $("#vClips"); ch.innerHTML = ""; let s = 0;
    for (const c of V.clips) {
      const m = mediaOf(c), L = clipLen(c), el = document.createElement("button");
      el.className = "vclip" + (c.id === V.sel ? " sel" : ""); el.dataset.clip = c.id; el.type = "button";
      el.style.left = s * pps + "px"; el.style.width = Math.max(2, L * pps - 2) + "px";
      if (m.thumb) el.style.backgroundImage = `url(${m.thumb})`;
      el.title = `${m.name} · ${short(L)}${c.speed !== 1 ? " · " + c.speed + "×" : ""}`;
      const lab = document.createElement("span"); lab.textContent = `${m.name.replace(/^Sample: /, "")}${c.speed !== 1 ? " · " + c.speed + "×" : ""}`; el.append(lab);
      const wv = m.kind === "video" ? waveCanvas(m, c.in, c.out, Math.round(L * pps)) : null; if (wv) el.append(wv);
      const tr = V.trans[c.id]; if (tr && s > 0) { const tb = document.createElement("i"); tb.className = "trmark"; tb.title = `${TR_NAMES[tr.type]} · ${tr.dur} s`; tb.style.width = Math.max(6, tr.dur * pps) + "px"; el.append(tb); }
      for (const side of ["l", "r"]) { const h = document.createElement("span"); h.className = "trim " + side; h.dataset.trim = side; h.dataset.clip = c.id; h.title = side === "l" ? "Drag to trim the start" : "Drag to trim the end"; el.append(h); }
      ch.append(el); s += L;
    }
    const oc = $("#vOvs"); oc.innerHTML = "";
    if (!V.overlays.length) { const e = document.createElement("span"); e.className = "ovempty"; e.textContent = "Text and effects appear here"; oc.append(e); }
    V.overlays.forEach((o, i) => {
      const e = o.full ? T : o.end, el = document.createElement("button");
      el.className = "vov" + (o.id === V.selOv ? " sel" : "") + (o.type === "anim" ? " anim" : ""); el.dataset.ov = o.id; el.type = "button";
      el.style.left = o.start * pps + "px"; el.style.width = Math.max(4, (e - o.start) * pps - 2) + "px"; el.style.top = (i % 2) * 13 + "px";
      el.textContent = o.name; el.title = `${o.name} · ${fmt(o.start)}–${fmt(e)}`; if (o.type === "media") el.classList.add("media");
      for (const k of o.kf || []) { const d = document.createElement("i"); d.className = "kfd"; d.style.left = k.t * pps + "px"; el.append(d); }
      oc.append(el);
    });
    const mu = $("#vMus"); mu.innerHTML = "";
    const mm = musicMedia();
    if (mm) {
      const a = V.music.start, b = Math.min(T, a + mm.duration), el = document.createElement("div"); el.className = "vmus";
      el.style.left = a * pps + "px"; el.style.width = Math.max(4, (b - a) * pps - 2) + "px"; el.title = `${mm.name} · from ${fmt(a)}`;
      const wv = waveCanvas(mm, 0, b - a, Math.round((b - a) * pps)); if (wv) el.append(wv);
      const lab = document.createElement("span"); lab.textContent = "♪ " + mm.name + (V.music.duck ? " · ducks under speech" : ""); el.append(lab); mu.append(el);
    } else if (!V.sounds.length) { const e = document.createElement("span"); e.className = "ovempty"; e.textContent = "Music and sound effects appear here"; mu.append(e); }
    for (const sd of V.sounds) {
      const m = V.media.find((x) => x.id === sd.mediaId); if (!m) continue;
      const el = document.createElement("button"); el.type = "button"; el.className = "vsnd"; el.dataset.snd = sd.id;
      el.style.left = sd.start * pps + "px"; el.style.width = Math.max(10, Math.min(T - sd.start, m.duration) * pps - 1) + "px";
      el.title = `Sound effect: ${m.name} at ${fmt(sd.start)} (click to remove)`; el.textContent = "🔊 " + m.name; mu.append(el);
    }
    updateTime();
  }
  function syncEdit() {
    const c = V.clips.find((x) => x.id === V.sel), box = $("#vClipBox");
    box.hidden = !c; $("#vClipNone").hidden = !!c;
    if (c) {
      const m = mediaOf(c); $("#vClipName").textContent = m.name;
      $("#vIn").value = c.in.toFixed(2); $("#vOut").value = c.out.toFixed(2); $("#vIn").max = $("#vOut").max = m.duration.toFixed(2);
      $("#vSpeed").value = String(c.speed); if (!$("#vSpeed").value) { $("#vSpeed").add(new Option(c.speed + "×", String(c.speed))); $("#vSpeed").value = String(c.speed); }
      $("#vClipLen").textContent = m.kind === "image" ? `Photo shown for ${short(clipLen(c))}` : `Plays for ${short(clipLen(c))} (source ${short(c.out - c.in)} of ${short(m.duration)})`;
      $("#vKbRow").hidden = m.kind !== "image"; $("#vKb").checked = !!c.kb;
      const idx = V.clips.indexOf(c), tr = V.trans[c.id];
      $("#vTrRow").hidden = idx < 1; $("#vTrType").value = tr ? tr.type : "none"; $("#vTrDur").value = tr ? tr.dur : 0.8; $("#vTrDur").disabled = !tr;
    }
    const o = V.overlays.find((x) => x.id === V.selOv), ob = $("#vOvBox");
    ob.hidden = !o;
    if (o) { syncTf(o); }
    if (o) { $("#vOvName").textContent = o.name; $("#vOvStart").value = o.start.toFixed(2); $("#vOvEnd").value = (o.full ? total() : o.end).toFixed(2); $("#vOvFull").checked = o.full; $("#vOvEnd").disabled = o.full; $("#vOvStart").disabled = o.full; }
    $("#vFollow").checked = V.follow; $("#vPosX").value = Math.round(V.frame.x * 100); $("#vPosY").value = Math.round(V.frame.y * 100);
    $("#vPosRow").hidden = V.follow;
    $("#vMute").checked = V.muted; $("#vVol").value = Math.round(V.volume * 100); $("#vVolV").textContent = Math.round(V.volume * 100) + "%";
    $("#vFadeIn").value = V.fadeIn; $("#vFadeOut").value = V.fadeOut;
    for (const k of ["level", "hum", "voice", "bass"]) $("#vSfx-" + k).checked = !!V.sfx[k];
    soundInfo();
    const mm = musicMedia(); $("#vMusBox").hidden = !mm; $("#vMusAdd").textContent = mm ? "Replace music" : "Add music";
    if (mm) { $("#vMusName").textContent = mm.name + " · " + fmt(mm.duration); $("#vMusVol").value = Math.round(V.music.vol * 100); $("#vMusVolV").textContent = Math.round(V.music.vol * 100) + "%"; $("#vMusStart").value = V.music.start; $("#vMusDuck").checked = V.music.duck; }
  }
  function syncAdj() {
    for (const k of Object.keys(DEF)) { const inp = $("#vadj-" + k), out = $("#vadjv-" + k); if (!inp) continue; inp.value = V.adj[k] || 0; out.textContent = FE.fmtAdj(k, V.adj[k] || 0); out.classList.toggle("on", !!V.adj[k]); }
    $("#vGrade").checked = V.grade > 0;
  }
  function refreshAll() { renderTimeline(); syncEdit(); syncAdj(); updUndo(); $("#vEmpty").hidden = V.clips.length > 0; if (!$("#vpane-color").hidden) { wheelsUI.draw(); vToneUI.draw(); } }
  function redrawSoon() { if (!P.playing) { draw(); updateTime(); } }

  /* ================= UI: controls ================= */
  function busy(on, text) { $("#vBusy").hidden = !on; if (text) $("#vBusyText").textContent = text; }
  $("#vPlay").onclick = () => (P.playing ? pause() : play());
  $("#vPrev").onclick = () => { pause(); seek(P.t - 1 / FPS); };
  $("#vNext").onclick = () => { pause(); seek(P.t + 1 / FPS); };
  $("#vStart").onclick = () => { pause(); seek(0); };
  $("#vOpen").onclick = () => $("#vFile").click();
  $("#vEmptyOpen").onclick = () => $("#vFile").click();
  $("#vFile").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addFiles(f); };
  $("#vUndo").onclick = undo; $("#vRedo").onclick = redo;
  const vv = $("#vView");
  vv.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); $("#vDrop").hidden = false; } });
  vv.addEventListener("dragleave", (e) => { if (e.target === vv) $("#vDrop").hidden = true; });
  vv.addEventListener("drop", (e) => { e.preventDefault(); $("#vDrop").hidden = true; addFiles(e.dataTransfer.files); });
  const cmp = $("#vCompare");
  cmp.addEventListener("pointerdown", () => { before = true; cmp.classList.add("primary"); redrawSoon(); });
  for (const ev of ["pointerup", "pointerleave"]) cmp.addEventListener(ev, () => { if (!before) return; before = false; cmp.classList.remove("primary"); redrawSoon(); });

  // timeline pointer
  const tlEl = $("#vTimeline"); let scrubbing = false;
  const tAtX = (x) => { const r = $("#vTlInner").getBoundingClientRect(); return clamp(((x - r.left) / r.width) * total(), 0, total()); };
  let trimDrag = null;
  tlEl.addEventListener("pointerdown", (e) => {
    if (!V.clips.length) return;
    const sndEl = e.target.closest(".vsnd");
    if (sndEl) { e.preventDefault(); pushUndo(); V.sounds = V.sounds.filter((x) => x.id !== +sndEl.dataset.snd); syncSounds(P.t, false); refreshAll(); FE.toast("Removed the sound effect"); return; }
    const th = e.target.closest(".trim");
    if (th) {
      const c = V.clips.find((x) => x.id === +th.dataset.clip); if (!c) return;
      e.preventDefault(); pause(); pushUndo(); V.sel = c.id; V.selOv = null;
      trimDrag = { c, side: th.dataset.trim, x0: e.clientX, in0: c.in, out0: c.out, pps: $("#vTlInner").clientWidth / Math.max(0.1, total()) };
      tlEl.setPointerCapture(e.pointerId); return;
    }
    const clipEl = e.target.closest(".vclip"), ovEl = e.target.closest(".vov");
    if (clipEl) { V.sel = +clipEl.dataset.clip; V.selOv = null; switchTab("edit"); }
    else if (ovEl) { V.selOv = +ovEl.dataset.ov; switchTab("edit"); }
    pause(); scrubbing = true; tlEl.setPointerCapture(e.pointerId); seek(tAtX(e.clientX)); renderTimeline(); syncEdit();
  });
  tlEl.addEventListener("pointermove", (e) => {
    if (trimDrag) {
      const d = ((e.clientX - trimDrag.x0) / trimDrag.pps) * trimDrag.c.speed, c = trimDrag.c, m = mediaOf(c);
      if (trimDrag.side === "l") c.in = clamp(trimDrag.in0 + d, 0, c.out - 0.1); else c.out = clamp(trimDrag.out0 + d, c.in + 0.1, m.duration);
      renderTimeline(); seek(trimDrag.side === "l" ? startOf(c) : Math.max(0, startOf(c) + clipLen(c) - 0.02)); return;
    }
    if (scrubbing) seek(tAtX(e.clientX));
  });
  for (const ev of ["pointerup", "pointercancel"]) tlEl.addEventListener(ev, () => { scrubbing = false; if (trimDrag) { trimDrag = null; refreshAll(); } });
  function setTlZoom(z) { tlZoom = clamp(z, 1, 24); renderTimeline(); followHead(); }
  $("#vZoomIn").onclick = () => setTlZoom(tlZoom * 1.6); $("#vZoomOut").onclick = () => setTlZoom(tlZoom / 1.6);
  tlEl.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setTlZoom(tlZoom * (e.deltaY < 0 ? 1.25 : 0.8)); }, { passive: false });

  // edit tab
  const selClip = () => V.clips.find((x) => x.id === V.sel);
  $("#vSplit").onclick = () => { pause(); pushUndo(); if (splitAt(P.t)) { V.sel = clipAt(P.t + 1e-4)?.clip.id ?? V.sel; refreshAll(); FE.toast("Split at " + fmt(P.t)); } else { undoS.pop(); updUndo(); } };
  $("#vIn").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.in = clamp(+$("#vIn").value || 0, 0, c.out - 0.05); refreshAll(); seek(startOf(c)); };
  $("#vOut").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.out = clamp(+$("#vOut").value || 0, c.in + 0.05, mediaOf(c).duration); refreshAll(); seek(Math.min(P.t, total())); };
  $("#vSetIn").onclick = () => { const at = clipAt(P.t); if (!at) return; pushUndo(); const c = at.clip; V.sel = c.id; c.in = clamp(c.in + (P.t - at.start) * c.speed, 0, c.out - 0.05); refreshAll(); seek(startOf(c)); };
  $("#vSetOut").onclick = () => { const at = clipAt(P.t); if (!at) return; pushUndo(); const c = at.clip; V.sel = c.id; c.out = clamp(c.in + (P.t - at.start) * c.speed, c.in + 0.05, mediaOf(c).duration); refreshAll(); seek(Math.min(P.t, total())); };
  $("#vSpeed").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.speed = +$("#vSpeed").value; refreshAll(); seek(Math.min(P.t, total())); };
  $("#vKb").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.kb = $("#vKb").checked; redrawSoon(); };
  $("#vTrType").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); const v = $("#vTrType").value; if (v === "none") delete V.trans[c.id]; else V.trans[c.id] = { type: v, dur: clamp(+$("#vTrDur").value || 0.8, 0.2, Math.min(3, clipLen(c) - 0.05)) }; refreshAll(); seek(startOf(c) + 0.05); };
  $("#vTrDur").onchange = () => { const c = selClip(); if (!c || !V.trans[c.id]) return; pushUndo(); V.trans[c.id].dur = clamp(+$("#vTrDur").value || 0.8, 0.2, Math.min(3, clipLen(c) - 0.05)); refreshAll(); redrawSoon(); };
  $("#vTrAll").onclick = () => { if (V.clips.length < 2) return FE.toast("Add or split clips first: transitions go between clips"); pushUndo(); const type = $("#vTrType").value !== "none" ? $("#vTrType").value : "cross"; const n = setAllTransitions(type, +$("#vTrDur").value || 0.8); refreshAll(); redrawSoon(); FE.toast(`${TR_NAMES[type]} added to ${n} cut${n > 1 ? "s" : ""}`); };
  function setAllTransitions(type, dur) { let n = 0; V.clips.forEach((c, i) => { if (i > 0) { V.trans[c.id] = { type, dur: clamp(dur, 0.2, Math.min(3, clipLen(c) - 0.05, clipLen(V.clips[i - 1]) - 0.05)) }; n++; } }); return n; }
  $("#vMusAdd").onclick = () => $("#vMusFile").click();
  async function addMusicFile(f) {
    busy(true, "Loading music…");
    try { const m = await loadAudioFile(f); V.media.push(m); pushUndo(); V.music = { mediaId: m.id, start: 0, vol: 0.6, duck: true }; ensureAudio(); connectMusic(m); await analyzeAudio(m); await analyzeAllAudio(); FE.toast(`Added “${m.name}” as music`); return m; }
    catch (err) { FE.toast(err.message); return null; }
    finally { busy(false); refreshAll(); }
  }
  $("#vMusFile").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) await addMusicFile(f); };
  $("#vMusVol").addEventListener("input", () => { if (!V.music) return; V.music.vol = $("#vMusVol").value / 100; $("#vMusVolV").textContent = $("#vMusVol").value + "%"; syncMusic(P.t, P.playing); });
  $("#vMusStart").onchange = () => { if (!V.music) return; pushUndo(); V.music.start = clamp(+$("#vMusStart").value || 0, 0, total()); refreshAll(); syncMusic(P.t, P.playing); };
  $("#vMusDuck").onchange = async () => { if (!V.music) return; pushUndo(); V.music.duck = $("#vMusDuck").checked; if (V.music.duck) { busy(true, "Listening for speech…"); await analyzeAllAudio(); busy(false); } refreshAll(); };
  $("#vMusDel").onclick = () => { if (!V.music) return; pushUndo(); const m = musicMedia(); if (m) m.el.pause(); V.music = null; refreshAll(); };
  $("#vMoveL").onclick = () => moveClip(-1); $("#vMoveR").onclick = () => moveClip(1);
  function moveClip(dir) { const i = V.clips.findIndex((x) => x.id === V.sel), j = i + dir; if (i < 0 || j < 0 || j >= V.clips.length) return; pushUndo(); [V.clips[i], V.clips[j]] = [V.clips[j], V.clips[i]]; refreshAll(); seek(startOf(V.clips[j])); }
  $("#vDup").onclick = () => { const i = V.clips.findIndex((x) => x.id === V.sel); if (i < 0) return; pushUndo(); const c = { ...V.clips[i], id: uid++ }; V.clips.splice(i + 1, 0, c); V.sel = c.id; refreshAll(); redrawSoon(); };
  $("#vDel").onclick = () => deleteClip();
  function deleteClip() { const i = V.clips.findIndex((x) => x.id === V.sel); if (i < 0) return; if (V.clips.length === 1) return FE.toast("A video needs at least one clip"); pushUndo(); const st = startOf(V.clips[i]), L = clipLen(V.clips[i]); V.clips.splice(i, 1); shiftOverlaysForCut(st, st + L); V.sel = (V.clips[i] || V.clips[i - 1]).id; refreshAll(); seek(Math.min(st, total())); }
  $("#vScenes").onclick = () => runScenes();
  async function runScenes(silent) {
    pause(); pushUndo(); busy(true, "Finding scene changes… 0%");
    const n = await detectScenes((p) => ($("#vBusyText").textContent = `Finding scene changes… ${Math.round(p * 100)}%`));
    busy(false); if (!n) { undoS.pop(); updUndo(); } refreshAll(); seek(P.t);
    const msg = n ? `split the timeline into ${V.clips.length} clips at ${n} scene change${n > 1 ? "s" : ""}` : "looked for scene changes and found none";
    if (!silent) FE.toast(titleCase(msg)); return msg;
  }
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  $("#vRatio").onchange = () => { pushUndo(); V.ratio = $("#vRatio").value === "original" ? "original" : +$("#vRatio").value; resize(); refreshAll(); redrawSoon(); };
  $("#vFollow").onchange = async () => { pushUndo(); V.follow = $("#vFollow").checked; if (V.follow) await runTracks(); syncEdit(); redrawSoon(); };
  async function runTracks() { if (usedMedia().every((m) => m.track)) return; pause(); busy(true, "Finding the subject… 0%"); await analyzeTracks((p) => ($("#vBusyText").textContent = `Finding the subject… ${Math.round(p * 100)}%`)); busy(false); }
  let posUndo = 0;
  for (const id of ["#vPosX", "#vPosY"]) $(id).addEventListener("input", () => { if (Date.now() - posUndo > 800) pushUndo(); posUndo = Date.now(); V.frame = { x: $("#vPosX").value / 100, y: $("#vPosY").value / 100 }; redrawSoon(); });
  $("#vMute").onchange = () => { pushUndo(); V.muted = $("#vMute").checked; applyVolume(); };
  $("#vVol").addEventListener("input", () => { V.volume = $("#vVol").value / 100; $("#vVolV").textContent = $("#vVol").value + "%"; applyVolume(); });
  for (const k of ["level", "hum", "voice", "bass"]) $("#vSfx-" + k).onchange = async (e) => {
    pushUndo(); ensureAudio(); V.sfx = { ...V.sfx, [k]: e.target.checked };
    if (e.target.checked) { busy(true, "Listening to the sound…"); await analyzeAllAudio(); busy(false); }
    rebuildAll(); soundInfo();
  };
  function soundInfo() {
    const list = usedMedia(), heard = list.filter((m) => m.audio);
    let t = "Play to hear the changes. They're included when you export.";
    if (heard.length && !hasSound()) t = "This video has no sound.";
    else { const hum = heard.map((m) => m.audio.hum).find(Boolean); if (V.sfx.hum && hum) t = `Found ${hum} Hz hum and filtered it out. ` + t; }
    $("#vSoundInfo").textContent = t;
  }
  $("#vSilence").onclick = async () => {
    pause(); ensureAudio(); pushUndo(); busy(true, "Listening to the sound…");
    const r = await removeSilence($("#vSilenceLong").checked); busy(false);
    if (!r.cut) { undoS.pop(); updUndo(); }
    refreshAll(); seek(Math.min(P.t, total())); soundInfo(); FE.toast(titleCase(r.msg));
  };
  $("#vBest").onclick = async () => {
    const target = +$("#vBestLen").value; if (!(target > 0)) return FE.toast("Enter how many seconds to keep");
    pause(); pushUndo(); busy(true, "Finding the best moments… 0%");
    const msg = await bestParts(target, (p) => ($("#vBusyText").textContent = `Finding the best moments… ${Math.round(p * 100)}%`)); busy(false);
    refreshAll(); seek(0); FE.toast(titleCase(msg));
  };
  $("#vFadeIn").onchange = () => { pushUndo(); V.fadeIn = clamp(+$("#vFadeIn").value || 0, 0, total() / 2); syncEdit(); redrawSoon(); };
  $("#vFadeOut").onchange = () => { pushUndo(); V.fadeOut = clamp(+$("#vFadeOut").value || 0, 0, total() / 2); syncEdit(); redrawSoon(); };
  function frameAnalysis() { const c = mk(PW, PH); renderFrame(c.getContext("2d"), PW, PH, P.t, { noOverlays: true }); return AI.analyze(c); }
  $("#vAddText").onclick = () => {
    const text = $("#vText").value.trim(); if (!text) return FE.toast("Type the text first");
    pushUndo(); const T = total(), st = Math.min(P.t, Math.max(0, T - 0.5));
    addOverlay({ kind: "text", text, clause: $("#vTextPos").value + " " + $("#vTextStyle").value, k: 1, color: null }, frameAnalysis(), { start: st, end: Math.min(T, st + (+$("#vTextDur").value || 3)) });
    V.selOv = V.overlays[V.overlays.length - 1].id; refreshAll(); redrawSoon();
  };
  $("#vAddFx").onclick = () => {
    const [kind, clause] = $("#vFx").value.split("|");
    pushUndo(); const msg = addOverlay({ kind, clause: clause || "", k: 1 }, frameAnalysis());
    V.selOv = V.overlays[V.overlays.length - 1].id; refreshAll(); redrawSoon(); FE.toast(titleCase(msg || "Added"));
  };
  const selOv = () => V.overlays.find((x) => x.id === V.selOv);
  const ovLocal = (o) => clamp(P.t - o.start, 0, (o.full ? total() : o.end) - o.start);
  function syncTf(o) {
    const T = tfAt(o, ovLocal(o)), kf = o.kf || [];
    const set = (id, v, txt) => { if (document.activeElement !== $(id)) $(id).value = v; $(id + "V").textContent = txt; };
    set("#vTfX", Math.round(T.x * 100), Math.round(T.x * 100) + "%"); set("#vTfY", Math.round(T.y * 100), Math.round(T.y * 100) + "%");
    set("#vTfS", Math.round(T.s * 100), Math.round(T.s * 100) + "%"); set("#vTfO", Math.round(T.o * 100), Math.round(T.o * 100) + "%");
    const here = kf.find((k) => Math.abs(k.t - ovLocal(o)) < 0.06);
    $("#vKfInfo").textContent = kf.length ? `${kf.length} keyframe${kf.length > 1 ? "s" : ""} at ${kf.map((k) => k.t.toFixed(1) + " s").join(", ")}. Moving a slider sets a keyframe at the playhead.` : "No animation. Sliders set its position; add a keyframe to animate it.";
    $("#vKfDel").disabled = !here; $("#vKfClear").disabled = !kf.length;
  }
  let tfUndo = 0;
  function setTfFromSliders() {
    const o = selOv(); if (!o) return;
    if (Date.now() - tfUndo > 900) pushUndo(); tfUndo = Date.now();
    const v = { x: $("#vTfX").value / 100, y: $("#vTfY").value / 100, s: $("#vTfS").value / 100, o: $("#vTfO").value / 100 };
    if (o.kf && o.kf.length) { const t = ovLocal(o), i = o.kf.findIndex((k) => Math.abs(k.t - t) < 0.06); const k = { t: i >= 0 ? o.kf[i].t : t, ...v }; if (i >= 0) o.kf[i] = k; else { o.kf = [...o.kf, k].sort((a, b) => a.t - b.t); } }
    else o.tf = v;
    syncTf(o); renderTimeline(); redrawSoon();
  }
  for (const id of ["#vTfX", "#vTfY", "#vTfS", "#vTfO"]) $(id).addEventListener("input", setTfFromSliders);
  $("#vKfAdd").onclick = () => { const o = selOv(); if (!o) return; pushUndo(); const t = ovLocal(o), T = tfAt(o, t); o.kf = [...(o.kf || []).filter((k) => Math.abs(k.t - t) >= 0.06), { t, x: T.x, y: T.y, s: T.s, o: T.o }].sort((a, b) => a.t - b.t); syncTf(o); renderTimeline(); FE.toast(`Keyframe at ${t.toFixed(1)} s. Move the playhead and change the sliders to animate.`); };
  $("#vKfDel").onclick = () => { const o = selOv(); if (!o) return; pushUndo(); const t = ovLocal(o); o.kf = (o.kf || []).filter((k) => Math.abs(k.t - t) >= 0.06); syncTf(o); renderTimeline(); redrawSoon(); };
  $("#vKfClear").onclick = () => { const o = selOv(); if (!o) return; pushUndo(); o.tf = tfAt(o, ovLocal(o)); o.kf = []; syncTf(o); renderTimeline(); redrawSoon(); };
  function animPreset(o, style) {
    const len = Math.max(0.5, (o.full ? total() : o.end) - o.start), base = o.tf || BASE_TF, d = Math.min(0.8, len / 3);
    const k = (t, p) => ({ t: clamp(t, 0, len), x: base.x, y: base.y, s: base.s, o: 1, ...p });
    if (style === "fly") o.kf = [k(0, { y: base.y + 0.35, o: 0 }), k(d, {}), k(len - d, {}), k(len, { y: base.y - 0.1, o: 0 })];
    else if (style === "pop") o.kf = [k(0, { s: base.s * 0.4, o: 0 }), k(d * 0.6, { s: base.s * 1.08 }), k(d, {}), k(len - 0.3, {}), k(len, { s: base.s * 0.8, o: 0 })];
    else if (style === "push") o.kf = [k(0, { s: base.s }), k(len, { s: base.s * 1.18 })];
    else if (style === "slide") o.kf = [k(0, { x: base.x - 0.6, o: 0 }), k(d, {}), k(len - d, {}), k(len, { x: base.x + 0.6, o: 0 })];
    else o.kf = [k(0, { o: 0 }), k(d, {}), k(len - d, {}), k(len, { o: 0 })];
    if (o.full) { o.full = false; o.end = total(); }
  }
  $$("[data-anim]").forEach((b) => (b.onclick = () => { const o = selOv(); if (!o) return; pushUndo(); animPreset(o, b.dataset.anim); refreshAll(); redrawSoon(); FE.toast(`${b.textContent} animation added`); }));
  $("#vPipAdd").onclick = () => $("#vPipFile").click();
  $("#vPipFile").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    busy(true, "Loading…");
    try {
      const m = f.type.startsWith("image/") ? await loadImageFile(f) : await loadVideoFile(f); V.media.push(m); pushUndo();
      const T = total(), st = Math.min(P.t, Math.max(0, T - 0.5)), len = m.kind === "image" ? 4 : m.duration;
      const ov = { id: uid++, type: "media", kind: "media", name: "On top: " + m.name, mediaId: m.id, srcIn: 0, start: st, end: Math.min(T, st + len), full: false, tf: { x: 0.28, y: 0.27, s: 0.36, o: 1 }, kf: [], caches: {}, job: { seed: 0 } };
      V.overlays.push(ov); V.selOv = ov.id; await seekAux(P.t); FE.toast(`Added “${m.name}” on top. Use the sliders to place it`);
    } catch (err) { FE.toast(err.message || "Couldn't add that file"); }
    busy(false); refreshAll(); redrawSoon();
  };
  $("#vOvStart").onchange = () => { const o = selOv(); if (!o) return; pushUndo(); o.start = clamp(+$("#vOvStart").value || 0, 0, o.end - 0.1); refreshAll(); redrawSoon(); };
  $("#vOvEnd").onchange = () => { const o = selOv(); if (!o) return; pushUndo(); o.end = clamp(+$("#vOvEnd").value || 0, o.start + 0.1, total()); refreshAll(); redrawSoon(); };
  $("#vOvFull").onchange = () => { const o = selOv(); if (!o) return; pushUndo(); o.full = $("#vOvFull").checked; if (o.full) o.start = 0; else o.end = total(); refreshAll(); redrawSoon(); };
  $("#vOvDel").onclick = () => { const o = selOv(); if (!o) return; pushUndo(); V.overlays = V.overlays.filter((x) => x !== o); V.selOv = null; refreshAll(); redrawSoon(); };

  // adjust tab
  (function buildAdjust() {
    const host = $("#vAdjGroups");
    for (const [title, items] of VGROUPS) {
      const g = document.createElement("div"); g.className = "adj-group"; g.innerHTML = `<div class="label">${title}</div>`;
      for (const [k, label] of items) { const [mn, mx] = k in FE.RANGE ? FE.RANGE[k] : [-100, 100]; const row = document.createElement("div"); row.className = "adj"; row.innerHTML = `<label for="vadj-${k}">${label}</label><output id="vadjv-${k}"></output><input type="range" id="vadj-${k}" min="${mn}" max="${mx}" step="1" value="0">`; g.append(row); }
      host.append(g);
    }
    let last = 0;
    host.addEventListener("input", (e) => { if (!e.target.id?.startsWith("vadj-")) return; if (Date.now() - last > 800) pushUndo(); last = Date.now(); const k = e.target.id.slice(5); V.adj[k] = +e.target.value; syncAdj(); redrawSoon(); });
    host.addEventListener("dblclick", (e) => { if (!e.target.id?.startsWith("vadj-")) return; pushUndo(); V.adj[e.target.id.slice(5)] = 0; syncAdj(); redrawSoon(); });
    const pc = $("#vPresets");
    for (const name of Object.keys(FE.PRESETS)) { const b = document.createElement("button"); b.className = "chip"; b.textContent = name; b.onclick = () => { pushUndo(); V.adj = { ...DEF, ...FE.PRESETS[name], sharpen: 0 }; syncAdj(); redrawSoon(); FE.toast(name + " applied to the whole video"); }; pc.append(b); }
    $("#vAdjReset").onclick = () => { pushUndo(); V.adj = { ...DEF }; V.grade = 0; syncAdj(); redrawSoon(); };
    $("#vGrade").onchange = () => { pushUndo(); V.grade = $("#vGrade").checked ? 0.6 : 0; redrawSoon(); };
  })();

  // tabs
  function switchTab(name) { $$("#vTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.vtab === name))); for (const t of ["ai", "color", "adjust", "edit", "export"]) $("#vpane-" + t).hidden = t !== name; if (name === "color") { wheelsUI.draw(); vToneUI.draw(); lastScope = 0; redrawSoon(); } }
  let colorEdit = 0;
  const colorBegin = () => { if (Date.now() - colorEdit > 900) pushUndo(); colorEdit = Date.now(); };
  const wheelsUI = Tone.mountWheels($("#vWheels"), { get: () => JSON.parse(JSON.stringify(V.wheels)), set: (w) => { V.wheels = w; redrawSoon(); }, begin: colorBegin });
  const vToneUI = Tone.mountToneEditor($("#vCurves"), { get: () => Tone.cloneTone(V.tone), set: (t) => { colorBegin(); V.tone = t; redrawSoon(); }, histogram: () => Tone.histogram(view) });
  $("#vScopeKind").onchange = () => { lastScope = 0; redrawSoon(); };
  $("#vColorReset").onclick = () => { pushUndo(); V.wheels = Tone.defaultWheels(); V.tone = Tone.defaultTone(); wheelsUI.draw(); vToneUI.draw(); redrawSoon(); };
  $$("#vTabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.vtab)));

  /* ================= export ================= */
  let EXP = null;
  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const t of ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
    return null;
  }
  const canExact = () => !!(window.VideoEncoder && window.VideoFrame && window.Mp4Muxer);
  function exportInfo() {
    const mime = pickMime(), [W, H] = dims(+$("#vRes").value), exact = canExact() && $("#vExpMode").value === "exact";
    $("#vExpMode").disabled = !canExact(); if (!canExact()) $("#vExpMode").value = "live";
    $("#vExpInfo").textContent = exact ? `${W} × ${H} · ${FPS} fps · MP4 · rendered frame by frame, so every frame is exact and you can switch tabs while it works`
      : mime ? `${W} × ${H} · ${FPS} fps · ${mime.startsWith("video/mp4") ? "MP4" : "WebM"} · plays through once in real time (about ${fmt(total())}); keep this tab visible`
      : "Video export isn't supported in this browser. Try a recent Chrome, Edge, Firefox or Safari on a computer.";
    $("#vExport").disabled = (!exact && !mime) || !V.clips.length;
  }
  $("#vExpMode").onchange = exportInfo;
  let OFF = null;
  async function decodedBuffer(m) {
    if (m._buf !== undefined) return m._buf;
    try { const ab = await (await fetch(m.url)).arrayBuffer(); m._buf = await new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 48000).decodeAudioData(ab); }
    catch { m._buf = null; }
    return m._buf;
  }
  // Mixes every sound in the edit (clips at their speed with the sound effects, music with fades and ducking) into one track.
  async function renderAudioMix(T) {
    const sr = 48000, oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.max(1, Math.ceil(T * sr)), sr);
    let any = false;
    if (!V.muted && V.volume > 0) {
      const bus = oc.createGain(); bus.gain.value = V.volume; bus.connect(oc.destination);
      if (Object.values(V.sfx).some(Boolean)) await analyzeAllAudio();
      let st = 0;
      for (const clip of V.clips) {
        const m = mediaOf(clip), L = clipLen(clip);
        if (m.kind === "video") {
          const buf = await decodedBuffer(m);
          if (buf && clip.in < buf.duration) {
            const src = oc.createBufferSource(); src.buffer = buf; src.playbackRate.value = clip.speed;
            const fx = buildFx(oc, m); let prev = src; for (const n of fx) { prev.connect(n); prev = n; } prev.connect(bus);
            src.start(st, clip.in, Math.min(clip.out, buf.duration) - clip.in); any = true;
          }
        }
        st += L;
      }
    }
    const mm = musicMedia();
    if (mm) {
      const buf = await decodedBuffer(mm);
      if (buf) {
        if (V.music.duck) await analyzeAllAudio();
        const src = oc.createBufferSource(), g = oc.createGain(); src.buffer = buf; src.connect(g); g.connect(oc.destination);
        const a = V.music.start, b = Math.min(T, a + buf.duration);
        for (let t = a; t <= b; t += 0.1) { let v = V.music.vol; if (T - t < 1.5) v *= clamp((T - t) / 1.5, 0, 1); if (V.music.duck && speechAt(t)) v *= 0.25; g.gain.linearRampToValueAtTime(v, t); }
        src.start(a, 0, b - a); any = true;
      }
    }
    for (const sd of V.sounds) {
      const m = V.media.find((x) => x.id === sd.mediaId), buf = m && (await decodedBuffer(m)); if (!buf || sd.start >= T) continue;
      const src = oc.createBufferSource(), g = oc.createGain(); src.buffer = buf; g.gain.value = sd.vol; src.connect(g); g.connect(oc.destination);
      src.start(sd.start, 0, Math.min(buf.duration, T - sd.start)); any = true;
    }
    return any ? await oc.startRendering() : null;
  }
  async function pickVideoCodec(W, H) {
    for (const [codec, muxer] of [["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["avc1.42e028", "avc"], ["vp09.00.40.08", "vp9"], ["av01.0.08M.08", "av1"]]) {
      try { const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: Math.round(W * H * FPS * 0.12), framerate: FPS }); if (r.supported) return { codec, muxer }; } catch {}
    }
    return null;
  }
  async function pickAudioCodec() {
    if (!window.AudioEncoder) return null;
    for (const [codec, muxer] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
      try { const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }); if (r.supported) return { codec, muxer }; } catch {}
    }
    return null;
  }
  async function prepareFrame(t) {
    const at = clipAt(t); if (!at) return;
    const m = mediaOf(at.clip);
    if (m.kind === "video") { await seekEl(m.el, at.clip.in + (t - at.start) * at.clip.speed); if (m.el.readyState < 2) await new Promise((r) => { m.el.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 1500); }); }
    await seekAux(t);
  }
  async function exactExport(W, H) {
    const T = total(), N = Math.max(1, Math.round(T * FPS));
    const vc = await pickVideoCodec(W, H); if (!vc) throw new Error("This browser can't encode video frame by frame. Choose Real time instead.");
    pause();
    OFF = { cancelled: false };
    $("#vExporting").hidden = false; $("#vExport").hidden = true; $("#vCancel").hidden = false; $("#vExpResult").textContent = ""; document.body.classList.add("v-exporting");
    const prog = (p, text) => { $("#vExpBar").style.width = Math.round(p * 100) + "%"; $("#vExpPct").textContent = text; };
    try {
      prog(0, "Mixing the sound…");
      const mix = await renderAudioMix(T), ac = mix ? await pickAudioCodec() : null;
      const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: vc.muxer, width: W, height: H, frameRate: FPS }, ...(ac ? { audio: { codec: ac.muxer, numberOfChannels: 2, sampleRate: 48000 } } : {}), fastStart: "in-memory", firstTimestampBehavior: "offset" });
      let encErr = null;
      if (ac) {
        const ae = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (encErr = e) });
        ae.configure({ codec: ac.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
        const L = mix.length, c0 = mix.getChannelData(0), c1 = mix.numberOfChannels > 1 ? mix.getChannelData(1) : c0, step = 4800;
        for (let off = 0; off < L; off += step) { const n = Math.min(step, L - off), data = new Float32Array(n * 2); data.set(c0.subarray(off, off + n), 0); data.set(c1.subarray(off, off + n), n); const ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / 48000) * 1e6), data }); ae.encode(ad); ad.close(); }
        await ae.flush(); ae.close();
      }
      const ve = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (encErr = e) });
      ve.configure({ codec: vc.codec, width: W, height: H, bitrate: Math.round(W * H * FPS * 0.12), framerate: FPS, ...(vc.muxer === "avc" ? { avc: { format: "avc" } } : {}) });
      const canvas = mk(W, H), ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (Object.keys(V.trans).length) await ensureSnaps(W, H);
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        if (OFF.cancelled) throw new Error("cancelled");
        if (encErr) throw encErr;
        const t = Math.min(i / FPS, T - 0.001);
        await prepareFrame(t);
        renderFrame(ctx, W, H, t);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        ve.encode(frame, { keyFrame: i % (FPS * 2) === 0 }); frame.close();
        while (ve.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
        if (i % 6 === 0) { P.t = t; pctx.drawImage(canvas, 0, 0, PW, PH); updateTime(); const fps = (i + 1) / ((performance.now() - t0) / 1000); prog((i + 1) / N, `${Math.round(((i + 1) / N) * 100)}% · frame ${i + 1} of ${N} · ${fps.toFixed(0)} frames a second (${(fps / FPS).toFixed(1)}× real time)`); }
      }
      await ve.flush(); ve.close(); if (encErr) throw encErr;
      muxer.finalize();
      const blob = new Blob([muxer.target.buffer], { type: "video/mp4" }), name = `fastedit-${W}x${H}.mp4`, url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      const secs = (performance.now() - t0) / 1000;
      $("#vExpResult").textContent = `Downloaded ${name} (${(blob.size / 1048576).toFixed(1)} MB) in ${secs.toFixed(1)} s${ac ? "" : mix ? " (this browser can't encode audio, so it has no sound)" : ""}.`;
      FE.toast("Exported " + name); window.__lastExport = { size: blob.size, type: blob.type, name, secs };
    } catch (e) {
      $("#vExpResult").textContent = e.message === "cancelled" ? "Export cancelled." : `Export stopped: ${e.message || e}. Try again, or choose Real time.`;
    } finally {
      OFF = null; $("#vExporting").hidden = true; $("#vExport").hidden = false; $("#vCancel").hidden = true; document.body.classList.remove("v-exporting");
      seek(0);
    }
  }
  $("#vRes").onchange = exportInfo;
  $("#vExportBtn").onclick = () => { switchTab("export"); exportInfo(); };
  $("#vExport").onclick = () => { if (canExact() && $("#vExpMode").value === "exact") { const [W, H] = dims(+$("#vRes").value); exactExport(W, H); } else startExport(); };
  $("#vCancel").onclick = () => { if (OFF) { OFF.cancelled = true; return; } if (!EXP) return; EXP.cancelled = true; pause(); try { EXP.rec.stop(); } catch {} };
  async function startExport() {
    const mime = pickMime(); if (!mime || EXP) return;
    const [W, H] = dims(+$("#vRes").value), canvas = mk(W, H);
    if (Object.keys(V.trans).length) { busy(true, "Preparing transitions…"); await ensureSnaps(W, H); busy(false); }
    if (!canvas.captureStream) { FE.toast("This browser can't record video from the editor"); return; }
    pause(); ensureAudio();
    const stream = canvas.captureStream(FPS);
    const hasVideoAudio = (!V.muted && usedMedia().some((m) => m.kind === "video")) || !!musicMedia() || V.sounds.length > 0;
    if (hasVideoAudio && recDest) recDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(W * H * FPS * 0.12) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    EXP = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), W, H, rec, mime, chunks, cancelled: false, t0: performance.now() };
    if (monitor) monitor.gain.value = 0;
    rec.onstop = () => {
      const exp = EXP; EXP = null; if (monitor) monitor.gain.value = 1;
      $("#vExporting").hidden = true; $("#vExport").hidden = false; $("#vCancel").hidden = true; document.body.classList.remove("v-exporting");
      if (exp.cancelled) { $("#vExpResult").textContent = "Export cancelled."; return; }
      const blob = new Blob(exp.chunks, { type: exp.mime.split(";")[0] }), ext = exp.mime.startsWith("video/mp4") ? "mp4" : "webm";
      const name = `fastedit-${exp.W}x${exp.H}.${ext}`, url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $("#vExpResult").textContent = `Downloaded ${name} (${(blob.size / 1048576).toFixed(1)} MB).`;
      FE.toast("Exported " + name);
      window.__lastExport = { size: blob.size, type: blob.type, name };
    };
    $("#vExporting").hidden = false; $("#vExport").hidden = true; $("#vCancel").hidden = false; $("#vExpResult").textContent = ""; document.body.classList.add("v-exporting");
    P.t = 0; draw(); rec.start(500); play();
  }
  function updateExportProgress() { const T = total(), p = T ? P.t / T : 0; $("#vExpBar").style.width = Math.round(p * 100) + "%"; $("#vExpPct").textContent = `${Math.round(p * 100)}% · ${fmt(P.t)} of ${fmt(T)} · keep this tab open and visible`; }
  function finishExport() { if (!EXP) return; updateExportProgress(); draw(); setTimeout(() => { try { EXP && EXP.rec.state !== "inactive" && EXP.rec.stop(); } catch {} }, 250); }

  /* ================= AI (chat) ================= */
  async function videoEdit(req) {
    if (!V.clips.length) return { text: "Add a video first (tap **Add video**), then tell me what to do with it.", critique: true };
    if (!AI.ready) { busy(true, "Fast Edit AI is learning…"); await AI.train(); busy(false); }
    pause(); await seek(P.t);
    const artish = /\b(draw|paint|generate|illustrat\w*|sketch|art|artwork)\b/i.test(req);
    const frame = mk(PW, PH); renderFrame(frame.getContext("2d"), PW, PH, P.t, { noOverlays: true });
    const plan = AI.plan(req, { mode: artish ? "video-art" : "video", adj: { ...V.adj }, image: frame });
    if (plan.critique) return { text: `Looking at the frame at ${fmt(P.t)}: ` + plan.critique.text, chips: plan.critique.suggestions, critique: true };
    pushUndo();
    const notes = [...plan.notes.filter((n) => !/cinematic grade|cropped|composition/.test(n))], extra = [];
    if (plan.resetAdjustments) { V.adj = { ...DEF }; V.grade = 0; }
    for (const k of Object.keys(DEF)) if (typeof plan.adjustments[k] === "number" && k !== "sharpen") V.adj[k] = plan.adjustments[k];
    if (plan.understood.some((u) => u.intent === "cinematic")) notes.push("applied a cinematic grade");
    const A = AI.analyze(frameCanvasNoOverlays());
    let soundNote = false;
    const ops = plan.video.filter((op, i, all) => op.op !== "best" || all.findIndex((o) => o.op === "best") === i);
    for (const op of ops) {
      const T = total();
      if (op.op === "trim_start") { const s = Math.min(op.s, T - 0.2); if (s > 0) { cutRange(0, s); extra.push(`trimmed the first ${short(s)}`); } }
      else if (op.op === "trim_end") { const s = Math.min(op.s, T - 0.2); if (s > 0) { cutRange(T - s, T); extra.push(`trimmed the last ${short(s)}`); } }
      else if (op.op === "keep") { const a = clamp(op.a, 0, T - 0.2), b = clamp(op.b, a + 0.2, T); cutRange(b, T); cutRange(0, a); extra.push(a > 0 ? `kept ${short(a)} to ${short(b)}` : `shortened it to ${short(b - a)}`); }
      else if (op.op === "keep_share") { const b = T * op.share; cutRange(b, T); extra.push(`shortened it to ${short(b)}`); }
      else if (op.op === "speed") { setSpeedAll(op.v); extra.push(op.v === 1 ? "set playback to normal speed" : op.v < 1 ? `slowed it to ${op.v}× (slow motion)` : `sped it up to ${op.v}×`); }
      else if (op.op === "mute") { V.muted = op.v; applyVolume(); extra.push(op.v ? "muted the audio" : "turned the audio back on"); }
      else if (op.op === "fade_in") { V.fadeIn = clamp(op.s, 0.2, T / 2); extra.push(`added a ${short(V.fadeIn)} fade in`); }
      else if (op.op === "fade_out") { V.fadeOut = clamp(op.s, 0.2, T / 2); extra.push(`added a ${short(V.fadeOut)} fade out`); }
      else if (op.op === "ratio") { V.ratio = Math.abs(op.ar - baseAspect()) < 0.01 ? "original" : op.ar; resize(); extra.push(`reframed it to ${op.ar === 1 ? "square" : op.ar < 1 ? "vertical " + (Math.abs(op.ar - 9 / 16) < 0.01 ? "9:16" : op.ar.toFixed(2) + ":1") : Math.abs(op.ar - 16 / 9) < 0.01 ? "16:9" : op.ar.toFixed(2) + ":1"}`); }
      else if (op.op === "follow") { V.follow = true; await runTracks(); extra.push("set the frame to follow the subject"); }
      else if (op.op === "scenes") extra.push(await runScenes(true));
      else if (op.op === "keep_last") { const s = Math.min(op.s, T - 0.2); cutRange(0, T - s); extra.push(`kept the last ${short(s)}`); }
      else if (op.op === "best") { busy(true, "Finding the best moments… 0%"); extra.push(await bestParts(op.target, (p) => ($("#vBusyText").textContent = `Finding the best moments… ${Math.round(p * 100)}%`))); busy(false); }
      else if (op.op === "silence") { busy(true, "Listening to the sound…"); const r = await removeSilence(op.long); busy(false); extra.push(r.msg); }
      else if (op.op === "sfx" || op.op === "sfx_reset") {
        ensureAudio(); await analyzeAllAudio();
        if (op.op === "sfx_reset") { V.sfx = { level: false, hum: false, voice: false, bass: false }; extra.push("removed the sound effects"); }
        else {
          V.sfx = { ...V.sfx, [op.key]: true };
          const humHz = usedMedia().map((m) => m.audio && m.audio.hum).find(Boolean);
          extra.push({ level: "evened out the loudness", hum: humHz ? `filtered out ${humHz} Hz hum and low rumble` : "cut low rumble (there was no electrical hum to remove)", voice: "made voices clearer", bass: "boosted the bass" }[op.key]);
        }
        rebuildAll();
        if (!hasSound()) soundNote = true;
      }
      else if (op.op === "transitions") { if (V.clips.length < 2) extra.push("didn't add transitions because there's only one clip (split it or add more clips first)"); else { const n = setAllTransitions(op.type, op.dur || 0.8); extra.push(`added a ${TR_NAMES[op.type].toLowerCase()} to ${n === 1 ? "the cut" : `all ${n} cuts`}`); } }
      else if (op.op === "duck") { if (!musicMedia()) extra.push("couldn't duck the music because there's no music yet (Edit › Music › Add music)"); else { V.music.duck = true; await analyzeAllAudio(); extra.push("set the music to dip whenever someone speaks"); } }
      else if (op.op === "kenburns") { const imgs = V.clips.filter((c) => mediaOf(c).kind === "image"); imgs.forEach((c) => (c.kb = true)); extra.push(imgs.length ? `added a slow zoom to ${imgs.length} photo${imgs.length > 1 ? "s" : ""}` : "found no photos on the timeline to zoom (add photos with Add video)"); }
      else if (op.op === "animate") { const targets = V.overlays.filter((o) => o.kind === "text" || o.type === "media"); targets.forEach((o) => animPreset(o, op.style)); extra.push(targets.length ? `animated ${targets.length === 1 ? "the " + (targets[0].kind === "text" ? "caption" : "overlay") : targets.length + " overlays"} (${{ fly: "flying in and out", pop: "popping in", push: "slowly pushing in", slide: "sliding across", fade: "fading in and out" }[op.style]})` : "found no captions or overlays to animate (add one first)"); }
      else if (op.op === "volume") { V.volume = clamp(Math.round((V.volume + op.d) * 100) / 100, 0, 2); V.muted = false; applyVolume(); extra.push(`set the volume to ${Math.round(V.volume * 100)}%`); }
    }
    for (const job of plan.jobs) {
      if (job.kind === "split_tone") { V.grade = 0.6; continue; }
      const msg = addOverlay(job, A); if (msg) extra.push(msg);
    }
    resize(); refreshAll(); await seek(Math.min(P.t, total()));
    let msg = AI.sentence([...new Set([...notes, ...extra])]) || "Done.";
    if (soundNote) msg += " This video has no sound, so you'll hear the audio changes once you add a video that does.";
    if (plan.missed.length) msg += ` I skipped “${plan.missed.join("”, “")}” because I didn't understand it.`;
    const ids = new Set(plan.understood.map((u) => u.intent)), chips = [];
    if (!ids.has("fade_in") && !ids.has("fade_out")) chips.push("Fade in and fade out");
    if (!ids.has("crop_ratio")) chips.push("Vertical for TikTok");
    return { text: msg, tags: plan.understood.map((u) => `${u.label} ${Math.round(u.p * 100)}%`), chips };
  }

  /* ---------- "make a video about …": animated title cards ---------- */
  function scriptFor(topic) {
    if (/fast\s*edit/i.test(topic)) return ["Fast Edit", "Photo and video editing, right in your browser", "With its own AI, built from scratch", "Color · Cuts · Captions · Sound", "Your files never leave your device", "Try it at fast-edit-nine.vercel.app"];
    const T = topic.replace(/\b\w/g, (c) => c.toUpperCase());
    return [T, `A short film about ${topic}`, "Made with Fast Edit"];
  }
  function makeCardMedia(topic, maxLines) {
    const lines = scriptFor(topic).slice(0, maxLines || 99), per = 2.6, ar = V.ratio === "original" && !V.clips.some((c) => !mediaOf(c).sample) ? 16 / 9 : outAspect();
    const w = ar >= 1 ? 1280 : 720, h = ar >= 1 ? Math.round(1280 / ar) : 1280;
    const r = AI.rngFrom(AI.hashStr(topic)), hue = Math.round(r() * 360), font = FE.FONTS.display || "system-ui, sans-serif", body = FE.FONTS.sans || "system-ui, sans-serif";
    const blobs = Array.from({ length: 7 }, () => ({ x: r(), y: r(), s: 0.25 + r() * 0.35, v: 0.02 + r() * 0.04, h: hue + (r() - 0.5) * 90 }));
    const m = { id: uid++, kind: "synthetic", name: `Video: ${topic}`, w, h, duration: lines.length * per, canvas: mk(w, h), generated: true };
    m.ctx = m.canvas.getContext("2d");
    const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
    m.draw = (c, t) => {
      const i = Math.min(lines.length - 1, Math.floor(t / per)), lt = t - i * per, minS = Math.min(w, h);
      const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, `hsl(${hue},45%,12%)`); g.addColorStop(1, `hsl(${(hue + 50) % 360},55%,22%)`);
      c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = "screen";
      for (const b of blobs) { const x = ((b.x + t * b.v) % 1.4 - 0.2) * w, y = (b.y + Math.sin(t * 0.6 + b.x * 6) * 0.05) * h, R = b.s * Math.max(w, h); const gg = c.createRadialGradient(x, y, 0, x, y, R); gg.addColorStop(0, `hsla(${b.h},80%,55%,.35)`); gg.addColorStop(1, `hsla(${b.h},80%,55%,0)`); c.fillStyle = gg; c.fillRect(0, 0, w, h); }
      c.globalCompositeOperation = "source-over";
      const inP = ease(lt / 0.6), outP = clamp((lt - (per - 0.45)) / 0.45, 0, 1), alpha = inP * (1 - outP);
      const big = i === 0, size = big ? minS * 0.16 : minS * 0.075, text = lines[i];
      c.save(); c.globalAlpha = alpha; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#fff";
      c.font = `${big ? 800 : 600} ${size}px ${big ? font : body}`;
      // wrap
      const maxW = w * 0.82, words = text.split(" "), rows = []; let cur = "";
      for (const wd of words) { const tt = cur ? cur + " " + wd : wd; if (c.measureText(tt).width > maxW && cur) { rows.push(cur); cur = wd; } else cur = tt; } rows.push(cur);
      const lh = size * 1.18, y0 = h / 2 - ((rows.length - 1) * lh) / 2 + (1 - inP) * minS * 0.04;
      c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = size * 0.4;
      rows.forEach((row, k) => c.fillText(row, w / 2, y0 + k * lh));
      c.shadowBlur = 0; c.fillStyle = "#f0a43a"; const barW = minS * 0.12 * inP; c.fillRect(w / 2 - barW / 2, y0 + (rows.length - 1) * lh + size * 0.9, barW, Math.max(3, minS * 0.008));
      c.restore();
    };
    m.draw(m.ctx, 0.8); m.thumb = thumbFrom(m.canvas, w, h);
    return { m, lines };
  }
  const realClips = () => V.clips.filter((c) => { const m = mediaOf(c); return !m.sample && !m.generated; });
  async function makeVideo(topic) {
    if (topic && realClips().length) return autoEdit(topic, null);
    if (!topic) return { text: "I'd love to! What should the video be about? For example: “make a video about Fast Edit” or “make a video about my trip to Rome”.", chips: ["Make a video about Fast Edit", "Make a video about summer"] };
    try { await document.fonts.load(`800 60px ${FE.FONTS.display}`); } catch {}
    pause(); pushUndo();
    const { m, lines } = makeCardMedia(topic); V.media.push(m);
    const onlySample = V.clips.every((c) => mediaOf(c).sample);
    if (onlySample) { V.clips = [{ id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 }]; V.overlays = []; }
    else V.clips.unshift({ id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 });
    V.sel = V.clips[0].id; V.fadeIn = Math.max(V.fadeIn, 0.5); V.fadeOut = Math.max(V.fadeOut, 0.8);
    resize(); refreshAll();
    addOverlay({ kind: "bokeh", clause: "", k: 0.7 }, AI.analyze(frameCanvasNoOverlays()), { start: 0, end: m.duration });
    refreshAll(); await seek(0);
    const len = short(m.duration);
    const th = await makeThumbnail(topic, { quiet: true });
    return {
      image: th.image, actions: th.actions,
      text: onlySample
        ? `Here's a ${len} video about **${topic}**: ${lines.length} animated title cards (“${lines.slice(0, 2).join("”, “")}”…) over a moving color background with drifting bokeh lights, a fade in and a fade out. Press **Play** to watch, or **Export video** to save it.`
        : `I added a ${len} animated intro about **${topic}** (${lines.length} title cards) at the start of your timeline, with drifting bokeh lights and fades. Press **Play** to watch it.`,
      chips: ["Vertical for TikTok", "Add falling snow", "Make another thumbnail"],
    };
  }

  /* ---------- thumbnail ---------- */
  const cleanName = (n) => String(n || "").replace(/^(Sample|Video): /, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  let thumbTimes = [], lastTopic = null;
  async function makeThumbnail(topic, opts = {}) {
    if (!V.clips.length) return { text: "Add a video first, then ask me for a thumbnail." };
    pause(); busy(true, "Looking for the best frame…");
    try {
      const T = total(), n = Math.min(24, Math.max(6, Math.round(T * 2))), real = realClips().length > 0, titleVideo = !real && mediaOf(V.clips[0]).generated;
      if (!opts.again) thumbTimes = [];
      let best;
      if (titleVideo) best = { t: Math.min(1.2, T / 2) };
      else {
        const cands = [];
        for (let i = 0; i < n; i++) {
          const t = T * (0.05 + (0.9 * (i + 0.5)) / n);
          if (thumbTimes.some((u) => Math.abs(u - t) < Math.max(1, T / 12))) continue;
          await prepareFrame(t); const [w, h] = dims(240), c = mk(w, h); renderFrame(c.getContext("2d"), w, h, t, { noOverlays: true }); cands.push({ t, canvas: c });
        }
        best = FastThumb.pickBest(cands) || { t: T / 2 };
      }
      thumbTimes.push(best.t);
      await prepareFrame(best.t);
      const [W, H] = dims(1080), big = mk(W, H); renderFrame(big.getContext("2d"), W, H, best.t, { noOverlays: !titleVideo });
      const textOv = V.overlays.find((o) => o.kind === "text"), fileName = cleanName((realClips()[0] && mediaOf(realClips()[0]).name) || "");
      const looksLikeFile = !fileName || /^(img|vid|mov|dsc|pxl|video|clip|test|screen|untitled)?[\s\d]*$/i.test(fileName) || /\d{4,}/.test(fileName);
      if (topic) lastTopic = topic;
      const title = topic || lastTopic || (textOv && textOv.job.text) || (!looksLikeFile && realClips().length ? fileName : AI.caption(AI.analyze(big), String(best.t)));
      busy(true, "Designing the thumbnail…");
      const th = await FastThumb.make({ frame: big, title, hasTitle: titleVideo });
      await seek(P.t);
      const actions = [{ label: "Download thumbnail", primary: true, run: () => { FastThumb.download(th.canvas, "fastedit-thumbnail.png"); FE.toast("Downloaded fastedit-thumbnail.png"); } },
        { label: "Edit in Photo mode", run: () => openThumbInPhoto(th) }];
      return {
        text: opts.quiet ? "" : `Here's a thumbnail made from the frame at ${fmt(best.t)}: ${titleVideo ? "the opening title card with punchier color" : `the most eye-catching moment with punchier color${th.outlined ? ", the subject outlined" : ""} and a big title, “${title}”`}. It's 1280 × 720, the size YouTube uses.`,
        image: th.canvas, imageAlt: `Thumbnail: ${title}`, actions, chips: ["Make another thumbnail", "Edit it for me"],
      };
    } finally { busy(false); }
  }
  function openThumbInPhoto(th) {
    document.querySelector('[data-app-mode="photo"]').click();
    FE.newDocument(FastThumb.W, FastThumb.H, FE.clone(th.layers.background), "Thumbnail background");
    FE.addLayer(FE.makeLayer("Thumbnail title", FE.clone(th.layers.title)));
    FE.toast("Opened the thumbnail in Photo mode. The title is its own layer");
  }

  /* ---------- "edit it for me": the whole edit, done automatically ---------- */
  async function autoEdit(topic, secs) {
    if (topic) lastTopic = topic;
    if (!realClips().length) {
      const r = await makeVideo(topic || "Fast Edit");
      return { ...r, text: "You haven't added any footage yet, so I made a video from scratch. " + r.text + " Add your own clips with **Add video** and say “edit it for me” to have me edit them." };
    }
    pause();
    const before = snap(), undoLen = undoS.length, steps = [], t0 = performance.now();
    const say = (t) => busy(true, t);
    try {
      V.clips = V.clips.filter((c) => !mediaOf(c).sample);
      if (V.clips.length < 6) { say("Finding the scenes…"); const n = await detectScenes(() => {}); if (n) steps.push(`split it at ${n} scene change${n > 1 ? "s" : ""}`); }
      const T0 = total(), target = secs || (T0 > 45 ? 30 : null);
      if (target && target < T0 - 1) { say("Finding the best moments…"); steps.push(await bestParts(target, (p) => ($("#vBusyText").textContent = `Finding the best moments… ${Math.round(p * 100)}%`))); }
      say("Listening to the sound…"); ensureAudio(); await analyzeAllAudio();
      if (hasSound()) {
        const r = await removeSilence(false); if (r.cut) steps.push(r.msg);
        V.sfx = { ...V.sfx, level: true, hum: true }; rebuildAll(); steps.push("cleaned up the sound and evened out the loudness");
      }
      say("Grading the color…");
      const tm = Math.min(total() * 0.4, total() - 0.1); await prepareFrame(tm);
      const frame = mk(PW, PH); renderFrame(frame.getContext("2d"), PW, PH, tm, { noOverlays: true, before: true });
      const plan = AI.plan("auto enhance", { mode: "video", adj: { ...DEF }, image: frame });
      for (const k of Object.keys(DEF)) if (typeof plan.adjustments[k] === "number" && k !== "sharpen") V.adj[k] = plan.adjustments[k];
      steps.push("balanced the color and exposure");
      const imgs = V.clips.filter((c) => mediaOf(c).kind === "image"); imgs.forEach((c) => (c.kb = true)); if (imgs.length) steps.push(`added a slow zoom to ${imgs.length} photo${imgs.length > 1 ? "s" : ""}`);
      if (V.clips.length > 1) { const n = setAllTransitions("cross", 0.5); steps.push(`added crossfades on ${n} cut${n > 1 ? "s" : ""}`); }
      if (topic) {
        try { await document.fonts.load(`800 60px ${FE.FONTS.display}`); } catch {}
        const { m } = makeCardMedia(topic, 2); V.media.push(m); const intro = { id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 };
        V.overlays.forEach((o) => { if (!o.full) { o.start += m.duration; o.end += m.duration; } });
        if (V.music) V.music.start += m.duration;
        V.clips.unshift(intro); if (V.clips[1]) V.trans[V.clips[1].id] = { type: "cross", dur: 0.6 };
        steps.push(`added a ${short(m.duration)} title intro about “${topic}”`);
      }
      V.fadeIn = Math.max(V.fadeIn, 0.6); V.fadeOut = Math.max(V.fadeOut, 1); steps.push("added a fade in and a fade out");
      if (musicMedia()) { V.music.duck = true; steps.push("set the music to dip whenever someone talks"); }
      undoS.length = undoLen; undoS.push(before); redoS.length = 0; updUndo();
      V.sel = V.clips[0].id; resize(); refreshAll(); await seek(Math.min(1, total() / 2));
      const th = await makeThumbnail(topic, { quiet: true });
      const secsTaken = ((performance.now() - t0) / 1000).toFixed(1);
      return {
        text: `Done! I edited it by myself in ${secsTaken} s: I ${AI.sentence(steps).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}. It's now **${short(total())}** long. I also made the thumbnail below. Press **Play** to watch, or **Export video** to save it. One **Undo** puts everything back.`,
        image: th.image, imageAlt: th.imageAlt, actions: th.actions,
        chips: ["Vertical for TikTok", "Make another thumbnail", "Undo that"],
      };
    } catch (e) {
      undoS.length = undoLen; restore(before); undoS.length = undoLen; updUndo();
      throw e;
    } finally { busy(false); }
  }
  let videoChat = null;
  function mountVideoChat() {
    videoChat = window.FEChat.mount($("#videoChat"), {
      mode: "video",
      placeholder: "Message Fast Edit AI, or attach videos…",
      welcome: "Hi! I'm **Fast Edit AI**. Attach your videos, photos and music with 📎 (or drop them here) and I'll edit them into a finished video by myself, with a thumbnail. I can also edit your video step by step: trim and shorten it, add transitions and captions, grade the color, clean up the sound, or make a whole video from a topic. What should we make?",
      starters: ["Edit it for me", "Make a video about Fast Edit", "Make a thumbnail", "Vertical for TikTok", "What can you do?"],
      edit: videoEdit,
      undo: () => { const had = undoS.length > 0; if (had) undo(); return had; },
      makeVideo: (topic) => makeVideo(topic),
      attach: {
        accept: "video/*,image/*,audio/*,.mp4,.mov,.webm,.m4v,.mp3,.wav,.m4a",
        title: "Attach videos, photos or music",
        reject: "Only videos, photos and music can be attached here",
        ok: (f) => /^(video|image|audio)\//.test(f.type) || /\.(mp4|mov|webm|m4v|mkv|mp3|wav|m4a|aac|ogg|jpe?g|png|webp|heic)$/i.test(f.name),
        send: async (files, text) => {
          const isAudio = (f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg)$/i.test(f.name);
          const visual = files.filter((f) => !isAudio(f)), audio = files.filter(isAudio);
          const before = realClips().length;
          if (visual.length) await addFiles(visual);
          const added = realClips().length - before;
          let song = null; if (audio.length) song = await addMusicFile(audio[0]);
          const got = [added ? `${added} clip${added > 1 ? "s" : ""}` : "", song ? `“${song.name}” as music` : ""].filter(Boolean).join(" and ");
          if (!added && !song) return { text: "I couldn't open those files. Try MP4, MOV or WebM videos, JPEG or PNG photos, and MP3, WAV or M4A music." };
          if (!realClips().length) return { text: `Added ${got}. Now attach some videos or photos and I'll edit everything together.`, chips: ["What can you do?"] };
          const r = text ? AI.converse(text, "video") : { kind: "auto_edit" };
          let res;
          if (r.kind === "auto_edit" || r.kind === "make_video") res = await autoEdit(r.topic, r.secs);
          else if (r.kind === "edit") { try { const e = await videoEdit(text); res = { ...e, text: e.text }; } catch { res = await autoEdit(null, null); } }
          else if (r.kind === "make_thumbnail") res = await makeThumbnail(r.topic);
          else res = await autoEdit(AI.topicOf(text) || null, null);
          return { ...res, text: `Got ${got}. ` + (res.text || "") };
        },
      },
      makeThumbnail: (topic, text) => makeThumbnail(topic, { again: /another|again|different|new one/i.test(text || "") }),
      autoEdit: (topic, secs) => autoEdit(topic, secs),
      makePoster: async () => ({ text: "Posters are made in Photo mode. Switch to **Photo** at the top and ask me there.", chips: ["Make a video about Fast Edit"] }),
    });
    if (window.__feAIStatus) videoChat.setStatus(window.__feAIStatus, AI.ready ? "ok" : "");
  }
  $$("#vTabs button").forEach((b) => b.addEventListener("click", () => { if (b.dataset.vtab === "export") exportInfo(); }));
  function frameCanvasNoOverlays() { const c = mk(PW, PH); renderFrame(c.getContext("2d"), PW, PH, P.t, { noOverlays: true }); return c; }

  /* ================= mode switching & keys ================= */
  function setMode(mode) {
    const video = mode === "video";
    document.body.classList.toggle("mode-video", video);
    $$("[data-app-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.appMode === mode)));
    try { localStorage.setItem("fastedit.mode", mode); } catch {}
    if (video) {
      if (!started) { started = true; const m = makeSample(); V.media.push(m); V.clips.push({ id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 }); V.sel = V.clips[0].id; }
      requestAnimationFrame(() => { resize(); refreshAll(); seek(P.t); exportInfo(); });
    } else { pause(); }
    window.dispatchEvent(new Event("resize"));
  }
  $$("[data-app-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.appMode)));
  window.addEventListener("resize", () => { if (document.body.classList.contains("mode-video")) renderTimeline(); });
  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("mode-video") || e.target.closest("input, textarea, select, button")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === " ") { e.preventDefault(); P.playing ? pause() : play(); }
    else if (k === "arrowleft") { pause(); seek(P.t - (e.shiftKey ? 1 : 1 / FPS)); }
    else if (k === "arrowright") { pause(); seek(P.t + (e.shiftKey ? 1 : 1 / FPS)); }
    else if (k === "s") $("#vSplit").click();
    else if (k === "delete" || k === "backspace") { if (V.selOv) $("#vOvDel").click(); else deleteClip(); }
  });
  mountVideoChat();
  let saved = "photo"; try { saved = localStorage.getItem("fastedit.mode") || "photo"; } catch {}
  if (saved === "video") setMode("video");
  async function addSoundFile(file, at) {
    const m = await loadAudioFile(file); V.media.push(m); pushUndo();
    const sd = { id: uid++, mediaId: m.id, start: clamp(at ?? P.t, 0, Math.max(0, total() - 0.1)), vol: 0.9 };
    V.sounds.push(sd); ensureAudio(); connectMusic(m); refreshAll(); return { m, sd };
  }
  function frameAnalysis() { if (!V.clips.length) return null; const c = mk(PW, PH); renderFrame(c.getContext("2d"), PW, PH, Math.min(P.t, total() - 0.05), { noOverlays: true }); return AI.analyze(c); }
  function addCreditsOverlay(text) { if (!V.clips.length) return; pushUndo(); const T = total(), st = Math.max(0, T - 4); addOverlay({ kind: "text", text, clause: "bottom sans", k: 0.55, color: null }, frameAnalysis(), { start: st, end: T }); refreshAll(); redrawSoon(); }
  window.FEVideo = { V, seek, total, play, pause, addFiles, makeVideo, makeThumbnail, autoEdit, addMusicFile, addSoundFile, frameAnalysis, addCreditsOverlay, realClips, switchTab, get time() { return P.t; }, get exporting() { return !!EXP; },
    getAdj: () => ({ ...V.adj }),
    applyLook(adj) { pushUndo(); V.adj = { ...DEF }; for (const k of Object.keys(DEF)) if (typeof adj[k] === "number" && k !== "sharpen") { const [mn, mx] = k in FE.RANGE ? FE.RANGE[k] : [-100, 100]; V.adj[k] = Math.round(clamp(adj[k], mn, mx)); } syncAdj(); redrawSoon(); },
  };
})();
