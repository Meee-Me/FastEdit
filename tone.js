/*
 * Fast Edit — tone engine shared by Photo and Video.
 * Curves (master + red/green/blue, monotone cubic through your points),
 * Levels (input black / gamma / white, output black / white),
 * Lift / Gamma / Gain colour wheels, histograms, and the editors for them.
 */
(function () {
  "use strict";
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ID = [[0, 0], [255, 255]];

  function defaultTone() {
    return { curves: { rgb: ID.map((p) => p.slice()), r: ID.map((p) => p.slice()), g: ID.map((p) => p.slice()), b: ID.map((p) => p.slice()) }, levels: { inB: 0, gamma: 1, inW: 255, outB: 0, outW: 255 } };
  }
  const cloneTone = (t) => JSON.parse(JSON.stringify(t || defaultTone()));
  const isIdCurve = (pts) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255;
  function toneIsDefault(t) {
    if (!t) return true;
    const L = t.levels;
    return ["rgb", "r", "g", "b"].every((k) => isIdCurve(t.curves[k])) && L.inB === 0 && L.inW === 255 && L.gamma === 1 && L.outB === 0 && L.outW === 255;
  }

  // Monotone cubic (Fritsch–Carlson) through the points -> 256-entry table.
  function curveTable(points) {
    const p = [...points].sort((a, b) => a[0] - b[0]), n = p.length, out = new Float32Array(256);
    if (n < 2) { for (let i = 0; i < 256; i++) out[i] = i; return out; }
    const dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, p[i + 1][0] - p[i][0]); m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) { if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; } const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b; if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; } }
    let seg = 0;
    for (let x = 0; x < 256; x++) {
      if (x <= p[0][0]) { out[x] = p[0][1]; continue; }
      if (x >= p[n - 1][0]) { out[x] = p[n - 1][1]; continue; }
      while (seg < n - 2 && x > p[seg + 1][0]) seg++;
      const h = dx[seg], u = (x - p[seg][0]) / h, u2 = u * u, u3 = u2 * u;
      out[x] = (2 * u3 - 3 * u2 + 1) * p[seg][1] + (u3 - 2 * u2 + u) * h * t[seg] + (-2 * u3 + 3 * u2) * p[seg + 1][1] + (u3 - u2) * h * t[seg + 1];
    }
    for (let x = 0; x < 256; x++) out[x] = clamp(out[x], 0, 255);
    return out;
  }
  // Final per-channel lookup tables (Uint8) for a tone setting, or null when it does nothing.
  function buildLUTs(t) {
    if (toneIsDefault(t)) return null;
    const L = t.levels, lv = new Float32Array(256);
    for (let v = 0; v < 256; v++) { let x = clamp((v - L.inB) / Math.max(1, L.inW - L.inB), 0, 1); x = Math.pow(x, 1 / Math.max(0.1, L.gamma)); lv[v] = L.outB + x * (L.outW - L.outB); }
    const m = curveTable(t.curves.rgb), luts = {};
    for (const ch of ["r", "g", "b"]) { const c = curveTable(t.curves[ch]), o = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) o[v] = c[Math.round(m[Math.round(lv[v])])]; luts[ch] = o; }
    return luts;
  }
  function applyLUTs(data, luts) { if (!luts) return; const { r, g, b } = luts; for (let i = 0; i < data.length; i += 4) { data[i] = r[data[i]]; data[i + 1] = g[data[i + 1]]; data[i + 2] = b[data[i + 2]]; } }

  // Lift / Gamma / Gain wheels: {lift:{x,y,m}, gamma:{...}, gain:{...}}; x,y in -1..1 (colour), m in -1..1 (master)
  const defaultWheels = () => ({ lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 0 }, gain: { x: 0, y: 0, m: 0 } });
  const wheelsDefault = (w) => !w || ["lift", "gamma", "gain"].every((k) => !w[k].x && !w[k].y && !w[k].m);
  function wheelRGB(wh) { // colour offset per channel from a wheel position (hue = angle)
    const ang = Math.atan2(wh.y, wh.x), mag = Math.min(1, Math.hypot(wh.x, wh.y));
    return [0, 1, 2].map((k) => Math.cos(ang - (k * 2 * Math.PI) / 3) * mag);
  }
  function wheelLUTs(w) {
    if (wheelsDefault(w)) return null;
    const L = wheelRGB(w.lift), G = wheelRGB(w.gamma), N = wheelRGB(w.gain), out = {};
    ["r", "g", "b"].forEach((ch, k) => {
      const lift = w.lift.m * 0.25 + L[k] * 0.12, gam = Math.max(0.2, 1 + w.gamma.m * 0.6 + G[k] * 0.25), gain = Math.max(0, 1 + w.gain.m * 0.6 + N[k] * 0.25), o = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) { let c = v / 255; c = c + lift * (1 - c); c = Math.pow(clamp(c, 0, 1), 1 / gam); o[v] = Math.round(c * gain * 255); }
      out[ch] = o;
    });
    return out;
  }

  function histogram(canvasOrData, w, h) {
    let d = canvasOrData;
    if (canvasOrData.getContext) { const c = canvasOrData, s = Math.min(1, 256 / Math.max(c.width, c.height)), t = document.createElement("canvas"); t.width = Math.max(1, c.width * s); t.height = Math.max(1, c.height * s); t.getContext("2d").drawImage(c, 0, 0, t.width, t.height); d = t.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, t.width, t.height).data; }
    const H = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 8) continue; H.r[d[i]]++; H.g[d[i + 1]]++; H.b[d[i + 2]]++; H.l[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++; }
    return H;
  }
  const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);
  function drawHist(ctx, W, H, hist, chans) {
    let mx = 1; for (const ch of chans) for (let i = 2; i < 254; i++) mx = Math.max(mx, hist[ch][i]);
    const col = { r: "rgba(255,80,80,.45)", g: "rgba(80,220,120,.45)", b: "rgba(90,140,255,.45)", l: "rgba(200,205,215,.35)" };
    ctx.globalCompositeOperation = "lighter";
    for (const ch of chans) { ctx.fillStyle = col[ch]; ctx.beginPath(); ctx.moveTo(0, H); for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(hist[ch][i] / mx)) * H); ctx.lineTo(W, H); ctx.fill(); }
    ctx.globalCompositeOperation = "source-over";
  }

  /* ---------- Curves + Levels editor ---------- */
  // opts: { get(): tone, set(tone, final), histogram(): hist|null }
  function mountToneEditor(host, opts) {
    host.innerHTML = `
      <div class="tone-head"><div class="label">Curves</div><select class="tone-ch" aria-label="Curve channel"><option value="rgb">RGB</option><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select><button class="btn sm tone-reset" type="button">Reset</button></div>
      <canvas class="tone-curve" width="512" height="512" aria-label="Curve: click to add a point, drag to move, double-click to remove"></canvas>
      <div class="label">Levels</div>
      <canvas class="tone-lv" width="512" height="120" aria-hidden="true"></canvas>
      <div class="lv-row"><label>Input</label><input type="number" class="lv inB" min="0" max="253" step="1"><input type="number" class="lv gamma" min="0.1" max="9.9" step="0.05"><input type="number" class="lv inW" min="2" max="255" step="1"></div>
      <div class="lv-row"><label>Output</label><input type="number" class="lv outB" min="0" max="255" step="1"><span></span><input type="number" class="lv outW" min="0" max="255" step="1"></div>
      <div class="hint">Click the curve to add a point, drag to move it, double-click to remove it.</div>`;
    const cv = host.querySelector(".tone-curve"), cx = cv.getContext("2d"), lvc = host.querySelector(".tone-lv"), lx = lvc.getContext("2d"), chSel = host.querySelector(".tone-ch");
    let ch = "rgb", drag = null, histCache = null;
    const S = 512, toX = (v) => (v / 255) * S, toY = (v) => S - (v / 255) * S;
    function draw() {
      const t = opts.get(); histCache = opts.histogram ? opts.histogram() : null;
      cx.clearRect(0, 0, S, S); cx.fillStyle = css("--bg", "#15171b"); cx.fillRect(0, 0, S, S);
      if (histCache) drawHist(cx, S, S, histCache, ch === "rgb" ? ["l"] : [ch]);
      cx.strokeStyle = css("--line", "#333843"); cx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { cx.beginPath(); cx.moveTo((i * S) / 4, 0); cx.lineTo((i * S) / 4, S); cx.moveTo(0, (i * S) / 4); cx.lineTo(S, (i * S) / 4); cx.stroke(); }
      cx.setLineDash([6, 6]); cx.beginPath(); cx.moveTo(0, S); cx.lineTo(S, 0); cx.stroke(); cx.setLineDash([]);
      const tab = curveTable(t.curves[ch]), color = { rgb: css("--fg", "#e7e9ee"), r: "#ff6b6b", g: "#4cd98a", b: "#6b9bff" }[ch];
      cx.strokeStyle = color; cx.lineWidth = 3; cx.beginPath(); for (let x = 0; x < 256; x++) { const X = toX(x), Y = toY(tab[x]); x ? cx.lineTo(X, Y) : cx.moveTo(X, Y); } cx.stroke();
      for (const p of t.curves[ch]) { cx.fillStyle = css("--bg", "#15171b"); cx.strokeStyle = color; cx.lineWidth = 3; cx.beginPath(); cx.arc(toX(p[0]), toY(p[1]), 9, 0, 7); cx.fill(); cx.stroke(); }
      // levels
      lx.clearRect(0, 0, S, 120); lx.fillStyle = css("--bg", "#15171b"); lx.fillRect(0, 0, S, 120);
      if (histCache) drawHist(lx, S, 120, histCache, ["l"]);
      const L = t.levels; lx.fillStyle = css("--accent", "#f0a43a");
      const tri = (v, c) => { const X = toX(v); lx.fillStyle = c; lx.beginPath(); lx.moveTo(X, 96); lx.lineTo(X - 10, 118); lx.lineTo(X + 10, 118); lx.fill(); };
      tri(L.inB, "#111"); tri(L.inB + (L.inW - L.inB) * Math.pow(0.5, L.gamma), "#888"); tri(L.inW, "#fff");
      for (const k of ["inB", "gamma", "inW", "outB", "outW"]) { const el = host.querySelector(".lv." + k); if (document.activeElement !== el) el.value = k === "gamma" ? L.gamma.toFixed(2) : L[k]; }
    }
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [clamp(((e.clientX - r.left) / r.width) * 255, 0, 255), clamp(255 - ((e.clientY - r.top) / r.height) * 255, 0, 255)]; };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      const t = opts.get(), pts = t.curves[ch], [x, y] = pos(e);
      let idx = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 14);
      if (idx < 0) { pts.push([Math.round(x), Math.round(y)]); pts.sort((a, b) => a[0] - b[0]); idx = pts.findIndex((p) => p[0] === Math.round(x) && p[1] === Math.round(y)); }
      drag = { idx, t }; opts.set(t, false); draw();
    });
    cv.addEventListener("pointermove", (e) => {
      if (!drag) return; const pts = drag.t.curves[ch], [x, y] = pos(e), i = drag.idx;
      const lo = i === 0 ? 0 : pts[i - 1][0] + 1, hi = i === pts.length - 1 ? 255 : pts[i + 1][0] - 1;
      pts[i] = [Math.round(clamp(x, lo, hi)), Math.round(y)]; opts.set(drag.t, false); draw();
    });
    const end = () => { if (drag) { opts.set(drag.t, true); drag = null; } };
    cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
    cv.addEventListener("dblclick", (e) => { const t = opts.get(), pts = t.curves[ch], [x, y] = pos(e), i = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 14); if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); opts.set(t, true); draw(); } });
    chSel.onchange = () => { ch = chSel.value; draw(); };
    host.querySelector(".tone-reset").onclick = () => { opts.set(defaultTone(), true); draw(); };
    host.querySelectorAll(".lv").forEach((el) => el.addEventListener("change", () => {
      const t = opts.get(), L = t.levels, k = [...el.classList].find((c) => c !== "lv"), v = +el.value;
      if (k === "gamma") L.gamma = clamp(v || 1, 0.1, 9.9); else L[k] = Math.round(clamp(v || 0, 0, 255));
      if (L.inW - L.inB < 2) { if (k === "inB") L.inB = L.inW - 2; else L.inW = L.inB + 2; }
      opts.set(t, true); draw();
    }));
    return { draw };
  }

  /* ---------- Lift / Gamma / Gain wheels ---------- */
  function mountWheels(host, opts) {
    host.innerHTML = `<div class="wheels">${["lift", "gamma", "gain"].map((k) => `<div class="wheel" data-w="${k}"><canvas width="200" height="200" aria-label="${k} colour: drag to tint"></canvas><b>${{ lift: "Lift (shadows)", gamma: "Gamma (midtones)", gain: "Gain (highlights)" }[k]}</b><input type="range" min="-100" max="100" value="0" aria-label="${k} master"><button class="btn sm" type="button">Reset</button></div>`).join("")}</div>`;
    const draws = [];
    for (const box of host.querySelectorAll(".wheel")) {
      const k = box.dataset.w, cv = box.querySelector("canvas"), c = cv.getContext("2d"), range = box.querySelector("input");
      const draw = () => {
        const w = opts.get()[k]; c.clearRect(0, 0, 200, 200);
        for (let a = 0; a < 360; a += 3) { c.fillStyle = `hsl(${a},70%,55%)`; c.beginPath(); c.moveTo(100, 100); c.arc(100, 100, 92, ((a - 1.5) * Math.PI) / 180, ((a + 3) * Math.PI) / 180); c.fill(); }
        const g = c.createRadialGradient(100, 100, 0, 100, 100, 92); g.addColorStop(0, "rgba(40,42,48,1)"); g.addColorStop(1, "rgba(40,42,48,0.1)"); c.fillStyle = g; c.beginPath(); c.arc(100, 100, 92, 0, 7); c.fill();
        c.strokeStyle = "rgba(255,255,255,.25)"; c.beginPath(); c.moveTo(100, 20); c.lineTo(100, 180); c.moveTo(20, 100); c.lineTo(180, 100); c.stroke();
        // our hue convention: angle 0 = red; screen y up
        const X = 100 + w.x * 84, Y = 100 - w.y * 84; c.fillStyle = "#fff"; c.strokeStyle = "#000"; c.lineWidth = 2; c.beginPath(); c.arc(X, Y, 8, 0, 7); c.fill(); c.stroke();
        if (document.activeElement !== range) range.value = Math.round(w.m * 100);
      };
      draws.push(draw);
      let dragging = false;
      const at = (e) => { const r = cv.getBoundingClientRect(); let x = (((e.clientX - r.left) / r.width) * 200 - 100) / 84, y = -(((e.clientY - r.top) / r.height) * 200 - 100) / 84; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; } return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }; };
      cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); dragging = true; opts.begin && opts.begin(); const s = opts.get(); Object.assign(s[k], at(e)); opts.set(s, false); draw(); });
      cv.addEventListener("pointermove", (e) => { if (!dragging) return; const s = opts.get(); Object.assign(s[k], at(e)); opts.set(s, false); draw(); });
      const end = () => { if (dragging) { dragging = false; opts.set(opts.get(), true); } };
      cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
      cv.addEventListener("dblclick", () => { opts.begin && opts.begin(); const s = opts.get(); s[k].x = s[k].y = 0; opts.set(s, true); draw(); });
      range.addEventListener("pointerdown", () => opts.begin && opts.begin());
      range.addEventListener("input", () => { const s = opts.get(); s[k].m = range.value / 100; opts.set(s, false); });
      range.addEventListener("change", () => opts.set(opts.get(), true));
      box.querySelector("button").onclick = () => { opts.begin && opts.begin(); const s = opts.get(); s[k] = { x: 0, y: 0, m: 0 }; opts.set(s, true); draw(); };
    }
    return { draw: () => draws.forEach((d) => d()) };
  }

  /* ---------- Scopes ---------- */
  function drawScope(canvas, src, kind) {
    const W = canvas.width, H = canvas.height, c = canvas.getContext("2d");
    c.fillStyle = "#0b0c0e"; c.fillRect(0, 0, W, H);
    const s = Math.min(1, 200 / Math.max(src.width, src.height)), t = document.createElement("canvas"); t.width = Math.max(1, Math.round(src.width * s)); t.height = Math.max(1, Math.round(src.height * s));
    t.getContext("2d").drawImage(src, 0, 0, t.width, t.height);
    const d = t.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, t.width, t.height).data, tw = t.width;
    c.strokeStyle = "rgba(255,255,255,.12)"; c.lineWidth = 1;
    if (kind === "histogram") { drawHist(c, W, H, histogram(d), ["r", "g", "b"]); return; }
    const img = c.getImageData(0, 0, W, H), o = img.data;
    const plot = (x, y, r, g, b) => { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; o[i] = Math.min(255, o[i] + r); o[i + 1] = Math.min(255, o[i + 1] + g); o[i + 2] = Math.min(255, o[i + 2] + b); };
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      if (kind === "waveform") { const x = ((p % tw) / tw) * W, l = 0.2126 * R + 0.7152 * G + 0.0722 * B; plot(x, H - 4 - (l / 255) * (H - 8), 30, 60, 30); }
      else { const cb = -0.1687 * R - 0.3313 * G + 0.5 * B, cr = 0.5 * R - 0.4187 * G - 0.0813 * B, r0 = Math.min(W, H) / 2 - 6; plot(W / 2 + (cb / 128) * r0, H / 2 - (cr / 128) * r0, R / 6 + 10, G / 6 + 10, B / 6 + 10); }
    }
    c.putImageData(img, 0, 0);
    c.strokeStyle = "rgba(255,255,255,.18)";
    if (kind === "waveform") { for (const v of [0, 0.25, 0.5, 0.75, 1]) { const y = H - 4 - v * (H - 8); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); } }
    else { const r0 = Math.min(W, H) / 2 - 6; c.beginPath(); c.arc(W / 2, H / 2, r0, 0, 7); c.moveTo(W / 2 - r0, H / 2); c.lineTo(W / 2 + r0, H / 2); c.moveTo(W / 2, H / 2 - r0); c.lineTo(W / 2, H / 2 + r0); c.stroke(); }
  }

  window.Tone = { defaultTone, cloneTone, toneIsDefault, buildLUTs, applyLUTs, curveTable, histogram, mountToneEditor, defaultWheels, wheelsDefault, wheelLUTs, mountWheels, drawScope };
})();
