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
  const V = { media: [], clips: [], overlays: [], adj: { ...DEF }, ratio: "original", follow: false, frame: { x: 0.5, y: 0.5 }, muted: false, volume: 1, fadeIn: 0, fadeOut: 0, grade: 0, sel: null, selOv: null, sfx: { level: false, hum: false, voice: false, bass: false } };
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
  const snap = () => ({ clips: V.clips.map((c) => ({ ...c })), overlays: V.overlays.map((o) => ({ ...o })), adj: { ...V.adj }, ratio: V.ratio, follow: V.follow, frame: { ...V.frame }, muted: V.muted, volume: V.volume, fadeIn: V.fadeIn, fadeOut: V.fadeOut, grade: V.grade, sel: V.sel, selOv: V.selOv, sfx: { ...V.sfx } });
  function pushUndo() { undoS.push(snap()); if (undoS.length > 40) undoS.shift(); redoS.length = 0; updUndo(); }
  function restore(s) { Object.assign(V, s); applyVolume(); rebuildAll(); resize(); refreshAll(); seek(Math.min(P.t, total())); }
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
    const m = { id: uid++, kind: "synthetic", name: "Sample: alpine timelapse (generated)", w, h, duration: 10, canvas: mk(w, h) };
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
  async function addFiles(files) {
    const vids = [...files].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv|ogv)$/i.test(f.name));
    if (!vids.length) return FE.toast("Choose a video file (MP4, MOV or WebM)");
    busy(true, "Loading video…");
    pushUndo();
    const replaceSample = V.clips.length && V.clips.every((c) => mediaOf(c).kind === "synthetic");
    if (replaceSample) { V.clips = []; V.overlays = []; }
    let added = 0;
    for (const f of vids) {
      try { const m = await loadVideoFile(f); V.media.push(m); V.clips.push({ id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 }); added++; }
      catch (e) { FE.toast(e.message); }
    }
    busy(false);
    if (!added) { undoS.pop(); updUndo(); return; }
    resize(); refreshAll(); seek(replaceSample ? 0 : P.t);
    FE.toast(added === 1 ? "Added 1 video to the timeline" : `Added ${added} videos to the timeline`);
  }

  /* ================= audio ================= */
  let AC = null, monitor = null, recDest = null;
  function ensureAudio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); monitor = AC.createGain(); monitor.connect(AC.destination); recDest = AC.createMediaStreamDestination(); } catch { AC = null; return; } }
    if (AC.state === "suspended") AC.resume().catch(() => {});
    V.media.forEach(connectMedia); applyVolume();
  }
  function connectMedia(m) {
    if (m.kind !== "video" || m.node || !AC) return;
    try { m.node = AC.createMediaElementSource(m.el); m.gain = AC.createGain(); m.gain.connect(monitor); m.gain.connect(recDest); rebuildChain(m); } catch {}
  }
  // source -> [low cut] -> [hum notches] -> [voice EQ] -> [bass] -> [compressor + level gain] -> volume
  function rebuildChain(m) {
    if (!m.node || !AC) return;
    try { m.node.disconnect(); } catch {}
    for (const n of m.fx || []) { try { n.disconnect(); } catch {} }
    const fx = [], f = V.sfx, a = m.audio && !m.audio.none ? m.audio : null;
    const biquad = (type, freq, q, gain) => { const n = AC.createBiquadFilter(); n.type = type; n.frequency.value = freq; if (q != null) n.Q.value = q; if (gain != null) n.gain.value = gain; return n; };
    if (f.hum || f.voice) fx.push(biquad("highpass", f.hum ? 85 : 70, 0.7));
    if (f.hum) for (const hz of a && a.hum ? [a.hum, a.hum * 2, a.hum * 3] : [50, 60, 100, 120]) fx.push(biquad("notch", hz, 30));
    if (f.voice) { fx.push(biquad("lowshelf", 200, null, -3)); fx.push(biquad("peaking", 3000, 0.9, 5)); }
    if (f.bass) fx.push(biquad("lowshelf", 120, null, 7));
    if (f.level) {
      const c = AC.createDynamicsCompressor(); c.threshold.value = -26; c.knee.value = 12; c.ratio.value = 4; c.attack.value = 0.005; c.release.value = 0.25; fx.push(c);
      const g = AC.createGain(); g.gain.value = a ? a.norm : 1.5; fx.push(g);
    }
    let prev = m.node; for (const n of fx) { prev.connect(n); prev = n; } prev.connect(m.gain);
    m.fx = fx;
  }
  function rebuildAll() { for (const m of V.media) rebuildChain(m); }
  function applyVolume() { const v = V.muted ? 0 : V.volume; for (const m of V.media) { if (m.gain) m.gain.gain.value = v; else if (m.el) { m.el.muted = V.muted; m.el.volume = clamp(V.volume, 0, 1); } } }

  /* ================= sound analysis ================= */
  // Decodes a clip's soundtrack once and keeps only a loudness curve (20 per second),
  // the hum frequency if there is one, and the gain that brings speech to a steady level.
  async function analyzeAudio(m) {
    if (m.audio) return m.audio;
    if (m.kind !== "video") return (m.audio = { none: true });
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
  function drawOverlay(c, W, H, ov, lt) {
    const len = (ov.full ? total() : ov.end) - ov.start, edge = ov.full ? 1 : clamp(Math.min(lt, len - lt) / 0.3, 0, 1);
    c.save(); c.globalAlpha = edge;
    if (ov.type === "anim") { c.globalCompositeOperation = ANIM[ov.kind].blend; ANIM[ov.kind].draw(c, W, H, lt, ov); }
    else {
      const key = W + "x" + H; let r = ov.caches[key];
      if (!r) { r = AI.renderJob(ov.job, ov.A, mk(W, H), { fonts: FE.FONTS }); ov.caches = { ...ov.caches, [key]: r }; }
      c.globalCompositeOperation = r.blend; c.globalAlpha = edge * r.opacity; c.drawImage(r.canvas, 0, 0, W, H);
    }
    c.restore();
  }

  /* ================= frame rendering ================= */
  function trackAt(m, lt) {
    const tr = m.track; if (!tr || !tr.length) return V.frame;
    if (lt <= tr[0].t) return tr[0]; if (lt >= tr[tr.length - 1].t) return tr[tr.length - 1];
    let i = 1; while (tr[i].t < lt) i++;
    const a = tr[i - 1], b = tr[i], k = (lt - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
  function renderFrame(c, W, H, t, o = {}) {
    c.save(); c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    const at = clipAt(t); if (!at) { c.restore(); return; }
    const { clip, start } = at, m = mediaOf(clip), lt = clip.in + (t - start) * clip.speed;
    let src = m.el;
    if (m.kind === "synthetic") { m.draw(m.ctx, lt); src = m.canvas; }
    const ar = W / H, mar = m.w / m.h; let cw, ch; if (mar > ar) { ch = m.h; cw = ch * ar; } else { cw = m.w; ch = cw / ar; }
    const f = V.follow && m.track ? trackAt(m, lt) : V.frame;
    const sx = clamp(f.x * m.w - cw / 2, 0, m.w - cw), sy = clamp(f.y * m.h - ch / 2, 0, m.h - ch);
    if (!o.before && V.adj.blur > 0) c.filter = `blur(${((V.adj.blur / 100) * Math.max(W, H) * 0.015).toFixed(1)}px)`;
    try { c.drawImage(src, sx, sy, cw, ch, 0, 0, W, H); } catch {}
    c.filter = "none";
    if (!o.before && needsPixels()) { const img = c.getImageData(0, 0, W, H); processFrame(img, W, H, Math.round(t * FPS)); c.putImageData(img, 0, 0); }
    if (!o.before && !o.noOverlays) for (const ov of V.overlays) { const e = ov.full ? total() : ov.end; if (t >= ov.start && t <= e) drawOverlay(c, W, H, ov, t - ov.start); }
    if (!o.before && !o.noOverlays) { const T = total(); let a = 0; if (V.fadeIn > 0 && t < V.fadeIn) a = 1 - t / V.fadeIn; if (V.fadeOut > 0 && t > T - V.fadeOut) a = Math.max(a, 1 - (T - t) / V.fadeOut); if (a > 0) { c.fillStyle = `rgba(0,0,0,${clamp(a, 0, 1)})`; c.fillRect(0, 0, W, H); } }
    c.restore();
  }
  let before = false;
  function draw() {
    if (EXP) { renderFrame(EXP.ctx, EXP.W, EXP.H, P.t); pctx.drawImage(EXP.canvas, 0, 0, PW, PH); }
    else renderFrame(pctx, PW, PH, P.t, { before });
  }

  /* ================= playback ================= */
  const P = { t: 0, playing: false, raf: 0, clip: null, clipStart: 0, last: 0 };
  let seekToken = 0;
  async function seek(t) {
    const my = ++seekToken; P.t = clamp(t, 0, total());
    const at = clipAt(P.t);
    if (at) { const m = mediaOf(at.clip); if (m.kind === "video") { if (!m.el.paused) m.el.pause(); await seekEl(m.el, at.clip.in + (P.t - at.start) * at.clip.speed); } }
    if (my !== seekToken) return;
    draw(); updateTime();
  }
  async function startClipAt(t) {
    const at = clipAt(t); P.clip = at.clip; P.clipStart = at.start;
    const m = mediaOf(at.clip);
    for (const o of V.media) if (o !== m && o.el && !o.el.paused) o.el.pause();
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
  function pause() { P.playing = false; cancelAnimationFrame(P.raf); for (const m of V.media) if (m.el && !m.el.paused) m.el.pause(); setPlayBtn(); }
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
    P.t = Math.max(P.clipStart, t); draw(); updateTime(); if (EXP) updateExportProgress();
    P.raf = requestAnimationFrame(loop);
  }
  function setPlayBtn() { const b = $("#vPlay"); b.textContent = P.playing ? "Pause" : "Play"; b.setAttribute("aria-label", P.playing ? "Pause" : "Play"); }
  function updateTime() {
    const T = total(); $("#vTime").textContent = `${fmt(P.t)} / ${fmt(T)}`;
    const tl = $("#vTimeline"); $("#vHead").style.left = (T ? (P.t / T) * tl.clientWidth : 0) + "px";
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
  function renderTimeline() {
    const tl = $("#vTimeline"), T = total(), W = tl.clientWidth, pps = W / Math.max(T, 0.1);
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
      ch.append(el); s += L;
    }
    const oc = $("#vOvs"); oc.innerHTML = "";
    if (!V.overlays.length) { const e = document.createElement("span"); e.className = "ovempty"; e.textContent = "Text and effects appear here"; oc.append(e); }
    V.overlays.forEach((o, i) => {
      const e = o.full ? T : o.end, el = document.createElement("button");
      el.className = "vov" + (o.id === V.selOv ? " sel" : "") + (o.type === "anim" ? " anim" : ""); el.dataset.ov = o.id; el.type = "button";
      el.style.left = o.start * pps + "px"; el.style.width = Math.max(4, (e - o.start) * pps - 2) + "px"; el.style.top = (i % 2) * 13 + "px";
      el.textContent = o.name; el.title = `${o.name} · ${fmt(o.start)}–${fmt(e)}`;
      oc.append(el);
    });
    updateTime();
  }
  function syncEdit() {
    const c = V.clips.find((x) => x.id === V.sel), box = $("#vClipBox");
    box.hidden = !c; $("#vClipNone").hidden = !!c;
    if (c) {
      const m = mediaOf(c); $("#vClipName").textContent = m.name;
      $("#vIn").value = c.in.toFixed(2); $("#vOut").value = c.out.toFixed(2); $("#vIn").max = $("#vOut").max = m.duration.toFixed(2);
      $("#vSpeed").value = String(c.speed); if (!$("#vSpeed").value) { $("#vSpeed").add(new Option(c.speed + "×", String(c.speed))); $("#vSpeed").value = String(c.speed); }
      $("#vClipLen").textContent = `Plays for ${short(clipLen(c))} (source ${short(c.out - c.in)} of ${short(m.duration)})`;
    }
    const o = V.overlays.find((x) => x.id === V.selOv), ob = $("#vOvBox");
    ob.hidden = !o;
    if (o) { $("#vOvName").textContent = o.name; $("#vOvStart").value = o.start.toFixed(2); $("#vOvEnd").value = (o.full ? total() : o.end).toFixed(2); $("#vOvFull").checked = o.full; $("#vOvEnd").disabled = o.full; $("#vOvStart").disabled = o.full; }
    $("#vFollow").checked = V.follow; $("#vPosX").value = Math.round(V.frame.x * 100); $("#vPosY").value = Math.round(V.frame.y * 100);
    $("#vPosRow").hidden = V.follow;
    $("#vMute").checked = V.muted; $("#vVol").value = Math.round(V.volume * 100); $("#vVolV").textContent = Math.round(V.volume * 100) + "%";
    $("#vFadeIn").value = V.fadeIn; $("#vFadeOut").value = V.fadeOut;
    for (const k of ["level", "hum", "voice", "bass"]) $("#vSfx-" + k).checked = !!V.sfx[k];
    soundInfo();
  }
  function syncAdj() {
    for (const k of Object.keys(DEF)) { const inp = $("#vadj-" + k), out = $("#vadjv-" + k); if (!inp) continue; inp.value = V.adj[k] || 0; out.textContent = FE.fmtAdj(k, V.adj[k] || 0); out.classList.toggle("on", !!V.adj[k]); }
    $("#vGrade").checked = V.grade > 0;
  }
  function refreshAll() { renderTimeline(); syncEdit(); syncAdj(); updUndo(); $("#vEmpty").hidden = V.clips.length > 0; }
  function redrawSoon() { if (!P.playing) { draw(); updateTime(); } }

  /* ================= UI: controls ================= */
  function busy(on, text) { $("#vBusy").hidden = !on; if (text) $("#vBusyText").textContent = text; $("#vAIGo").disabled = on; }
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
  const tAtX = (x) => { const r = tlEl.getBoundingClientRect(); return clamp(((x - r.left) / r.width) * total(), 0, total()); };
  tlEl.addEventListener("pointerdown", (e) => {
    if (!V.clips.length) return;
    const clipEl = e.target.closest(".vclip"), ovEl = e.target.closest(".vov");
    if (clipEl) { V.sel = +clipEl.dataset.clip; V.selOv = null; switchTab("edit"); }
    else if (ovEl) { V.selOv = +ovEl.dataset.ov; switchTab("edit"); }
    pause(); scrubbing = true; tlEl.setPointerCapture(e.pointerId); seek(tAtX(e.clientX)); renderTimeline(); syncEdit();
  });
  tlEl.addEventListener("pointermove", (e) => { if (scrubbing) seek(tAtX(e.clientX)); });
  for (const ev of ["pointerup", "pointercancel"]) tlEl.addEventListener(ev, () => (scrubbing = false));

  // edit tab
  const selClip = () => V.clips.find((x) => x.id === V.sel);
  $("#vSplit").onclick = () => { pause(); pushUndo(); if (splitAt(P.t)) { V.sel = clipAt(P.t + 1e-4)?.clip.id ?? V.sel; refreshAll(); FE.toast("Split at " + fmt(P.t)); } else { undoS.pop(); updUndo(); } };
  $("#vIn").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.in = clamp(+$("#vIn").value || 0, 0, c.out - 0.05); refreshAll(); seek(startOf(c)); };
  $("#vOut").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.out = clamp(+$("#vOut").value || 0, c.in + 0.05, mediaOf(c).duration); refreshAll(); seek(Math.min(P.t, total())); };
  $("#vSetIn").onclick = () => { const at = clipAt(P.t); if (!at) return; pushUndo(); const c = at.clip; V.sel = c.id; c.in = clamp(c.in + (P.t - at.start) * c.speed, 0, c.out - 0.05); refreshAll(); seek(startOf(c)); };
  $("#vSetOut").onclick = () => { const at = clipAt(P.t); if (!at) return; pushUndo(); const c = at.clip; V.sel = c.id; c.out = clamp(c.in + (P.t - at.start) * c.speed, c.in + 0.05, mediaOf(c).duration); refreshAll(); seek(Math.min(P.t, total())); };
  $("#vSpeed").onchange = () => { const c = selClip(); if (!c) return; pushUndo(); c.speed = +$("#vSpeed").value; refreshAll(); seek(Math.min(P.t, total())); };
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
  function switchTab(name) { $$("#vTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.vtab === name))); for (const t of ["ai", "adjust", "edit", "export"]) $("#vpane-" + t).hidden = t !== name; }
  $$("#vTabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.vtab)));

  /* ================= export ================= */
  let EXP = null;
  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const t of ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
    return null;
  }
  function exportInfo() {
    const mime = pickMime(), [W, H] = dims(+$("#vRes").value);
    $("#vExpInfo").textContent = mime ? `${W} × ${H} · ${FPS} fps · ${mime.startsWith("video/mp4") ? "MP4" : "WebM"} · about ${fmt(total())} to export (it plays through in real time)` : "Video export isn't supported in this browser. Try a recent Chrome, Edge, Firefox or Safari on a computer.";
    $("#vExport").disabled = !mime || !V.clips.length;
  }
  $("#vRes").onchange = exportInfo;
  $("#vExportBtn").onclick = () => { switchTab("export"); exportInfo(); };
  $("#vExport").onclick = startExport;
  $("#vCancel").onclick = () => { if (!EXP) return; EXP.cancelled = true; pause(); try { EXP.rec.stop(); } catch {} };
  function startExport() {
    const mime = pickMime(); if (!mime || EXP) return;
    const [W, H] = dims(+$("#vRes").value), canvas = mk(W, H);
    if (!canvas.captureStream) { FE.toast("This browser can't record video from the editor"); return; }
    pause(); ensureAudio();
    const stream = canvas.captureStream(FPS);
    const hasVideoAudio = !V.muted && usedMedia().some((m) => m.kind === "video");
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

  /* ================= AI ================= */
  let vMode = "edit";
  const VCHIPS = {
    edit: ["Make it 15 seconds with the best parts", "Remove the silent parts", "Clean up the audio and even out the volume", "Cinematic and vertical for TikTok", "Trim the first 2 seconds", "Slow motion", "Speed up 2x", "Fade in and fade out", "Split at scene changes", "Make voices clearer", "Mute the audio"],
    art: ["Falling snow", "Rain", "Confetti", "Sparkles around the light", "Bokeh lights", "Floating hearts", "Add a caption", "Stars and a crescent moon", "Light leak"],
    critique: ["Critique this frame"],
  };
  function renderVChips() {
    const host = $("#vAIChips"); host.innerHTML = "";
    for (const c of VCHIPS[vMode]) { const b = document.createElement("button"); b.className = "chip"; b.textContent = c; b.onclick = () => { $("#vAIPrompt").value = c; runAI(); }; host.append(b); }
    $("#vAIGo").textContent = { edit: "Apply to video", art: "Add to video", critique: "Critique frame" }[vMode];
    $("#vAIPrompt").placeholder = { edit: "e.g. “trim the first 3 seconds, slow motion, cinematic and vertical for TikTok”", art: "e.g. falling snow and a caption that says “Winter”", critique: "Optional: what to focus on" }[vMode];
  }
  $$("#vAIModes button").forEach((b) => (b.onclick = () => { vMode = b.dataset.vmode; $$("#vAIModes button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderVChips(); }));
  $("#vAIGo").onclick = () => runAI();
  $("#vAIPrompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runAI(); } });
  function vlog(kind, text, extra) {
    const log = $("#vAILog"); log.querySelector(".empty-log")?.remove();
    const d = document.createElement("div"); d.className = "entry " + kind;
    if (kind === "ai") { const w = document.createElement("div"); w.className = "who"; w.textContent = "Fast Edit AI"; d.append(w); }
    const t = document.createElement("div"); t.textContent = text; t.style.whiteSpace = "pre-wrap"; d.append(t); if (extra) d.append(extra); log.prepend(d);
  }
  async function runAI() {
    if (!$("#vBusy").hidden) return;
    const req = $("#vAIPrompt").value.trim(), mode = vMode;
    if (!req && mode !== "critique") { $("#vAIPrompt").focus(); return FE.toast("Describe what you want first"); }
    if (!V.clips.length) return FE.toast("Add a video first");
    if (!AI.ready) { busy(true, "Fast Edit AI is training…"); await AI.train(); busy(false); }
    vlog("you", (mode === "art" ? "Add: " : mode === "critique" ? "Critique" + (req ? ": " : "") : "") + req);
    pause(); await seek(P.t);
    let plan;
    try {
      const frame = mk(PW, PH); renderFrame(frame.getContext("2d"), PW, PH, P.t, { noOverlays: true });
      plan = AI.plan(mode === "critique" && !req ? "critique" : req, { mode: mode === "critique" ? "critique" : mode === "art" ? "video-art" : "video", adj: { ...V.adj }, image: frame });
    } catch (e) { const msg = e?.code === "not_understood" ? "I didn't understand that. Try “trim the first 2 seconds”, “slow motion”, “add snow” or “vertical for TikTok”." : e?.message || "Something went wrong."; vlog("err", msg); return; }
    if (plan.critique) {
      const chips = document.createElement("div"); chips.className = "chips";
      for (const sg of plan.critique.suggestions) { const b = document.createElement("button"); b.className = "chip"; b.textContent = sg; b.onclick = () => { $$("#vAIModes button")[0].click(); $("#vAIPrompt").value = sg; runAI(); }; chips.append(b); }
      vlog("ai", `Frame at ${fmt(P.t)}. ` + plan.critique.text, chips); return;
    }
    pushUndo();
    const notes = [...plan.notes.filter((n) => !/cinematic grade|cropped|composition/.test(n))], extra = [];
    if (plan.resetAdjustments) { V.adj = { ...DEF }; V.grade = 0; }
    for (const k of Object.keys(DEF)) if (typeof plan.adjustments[k] === "number" && k !== "sharpen") V.adj[k] = plan.adjustments[k];
    if (plan.understood.some((u) => u.intent === "cinematic")) notes.push("applied a cinematic grade");
    const A = AI.analyze(frameCanvasNoOverlays());
    // timeline operations first, so overlays span the final length
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
      else if (op.op === "ratio") { V.ratio = Math.abs(op.ar - baseAspect()) < 0.01 ? "original" : op.ar; resize(); extra.push(`reframed to ${op.ar === 1 ? "square" : op.ar < 1 ? "vertical " + (Math.abs(op.ar - 9 / 16) < 0.01 ? "9:16" : op.ar.toFixed(2) + ":1") : Math.abs(op.ar - 16 / 9) < 0.01 ? "16:9" : op.ar.toFixed(2) + ":1"}`); }
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
          extra.push({ level: "evened out the loudness", hum: humHz ? `filtered out ${humHz} Hz hum and low rumble` : "cut low rumble (no mains hum found)", voice: "made voices clearer", bass: "boosted the bass" }[op.key]);
        }
        rebuildAll();
        if (!hasSound()) extra.push("this video has no sound yet, so you'll hear the change once you add one that does");
      }
      else if (op.op === "volume") { V.volume = clamp(Math.round((V.volume + op.d) * 100) / 100, 0, 2); V.muted = false; applyVolume(); extra.push(`set the volume to ${Math.round(V.volume * 100)}%`); }
    }
    for (const job of plan.jobs) {
      if (job.kind === "split_tone") { V.grade = 0.6; continue; }
      const msg = addOverlay(job, A); if (msg) extra.push(msg);
    }
    resize(); refreshAll(); await seek(Math.min(P.t, total()));
    let msg = AI.sentence([...notes, ...extra]) || "Done.";
    if (plan.missed.length) msg += ` I skipped “${plan.missed.join("”, “")}” because I didn't understand it.`;
    const tags = document.createElement("div"); tags.className = "understood";
    for (const u of plan.understood) { const t = document.createElement("span"); t.textContent = `${u.label} ${Math.round(u.p * 100)}%`; tags.append(t); }
    vlog("ai", msg, tags); $("#vAIPrompt").value = "";
  }
  function frameCanvasNoOverlays() { const c = mk(PW, PH); renderFrame(c.getContext("2d"), PW, PH, P.t, { noOverlays: true }); return c; }

  /* ================= mode switching & keys ================= */
  function setMode(mode) {
    const video = mode === "video";
    document.body.classList.toggle("mode-video", video);
    $$("[data-app-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.appMode === mode)));
    try { localStorage.setItem("fastedit.mode", mode); } catch {}
    if (video) {
      if (!started) { started = true; const m = makeSample(); V.media.push(m); V.clips.push({ id: uid++, mediaId: m.id, in: 0, out: m.duration, speed: 1 }); V.sel = V.clips[0].id; renderVChips(); }
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
  let saved = "photo"; try { saved = localStorage.getItem("fastedit.mode") || "photo"; } catch {}
  if (saved === "video") setMode("video");
  window.FEVideo = { V, seek, total, play, pause, addFiles, get exporting() { return !!EXP; },
    getAdj: () => ({ ...V.adj }),
    applyLook(adj) { pushUndo(); V.adj = { ...DEF }; for (const k of Object.keys(DEF)) if (typeof adj[k] === "number" && k !== "sharpen") { const [mn, mx] = k in FE.RANGE ? FE.RANGE[k] : [-100, 100]; V.adj[k] = Math.round(clamp(adj[k], mn, mx)); } syncAdj(); redrawSoon(); },
  };
})();
