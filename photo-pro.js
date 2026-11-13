/*
 * Fast Edit — pro photo tools.
 * Menu bar, selections (rectangle, ellipse, lasso, magic wand, AI subject),
 * shape / gradient / paint bucket / clone stamp tools, filters with live preview,
 * Curves & Levels, image size, and .fedit project files.
 */
(function () {
  "use strict";
  const FE = window.FE, S = FE.S;
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mk = FE.mk;
  const toast = FE.toast;
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ================= overlays (selection edges + tool previews) ================= */
  const wrap = $("#wrap");
  const selCv = document.createElement("canvas"), prevCv = document.createElement("canvas");
  for (const c of [selCv, prevCv]) { c.className = "doc-overlay"; c.setAttribute("aria-hidden", "true"); wrap.append(c); }
  const pctx = prevCv.getContext("2d");
  let edges = null, antOffset = 0, antTimer = 0;
  function sizeOverlays() { for (const c of [selCv, prevCv]) { if (c.width !== S.w || c.height !== S.h) { c.width = S.w; c.height = S.h; } } selectionChanged(); }
  function selectionChanged() {
    edges = null;
    if (S.sel) {
      const d = S.sel.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, S.w, S.h).data, w = S.w, h = S.h, pts = [];
      const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y) && (!on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1))) pts.push(x, y);
      edges = new Int32Array(pts);
    }
    drawAnts();
    clearInterval(antTimer);
    if (edges && edges.length) antTimer = setInterval(() => { antOffset = (antOffset + 1) % 8; drawAnts(); }, 140);
    updateSelUI();
  }
  function drawAnts() {
    const c = selCv.getContext("2d"); c.clearRect(0, 0, selCv.width, selCv.height);
    if (!edges) return;
    const t = Math.max(1, Math.ceil(1 / S.zoom));
    for (let i = 0; i < edges.length; i += 2) { const x = edges[i], y = edges[i + 1]; c.fillStyle = ((x + y + antOffset) >> 2) & 1 ? "#000" : "#fff"; c.fillRect(x, y, t, t); }
  }
  FE.hooks.size.push(sizeOverlays);
  FE.hooks.changed.push(selectionChanged);
  function updateSelUI() { const has = !!S.sel; $$("[data-needs-sel]").forEach((b) => (b.disabled = !has)); const info = $("#selInfo"); if (info) info.textContent = has ? "Selection active · tools work inside it" : ""; }

  /* ================= selection helpers ================= */
  function newMask(fill) { const m = mk(S.w, S.h), x = m.getContext("2d"); if (fill) { x.fillStyle = "#fff"; x.fillRect(0, 0, S.w, S.h); } return m; }
  function combine(shapeMask, mode) {
    if (mode === "replace" || !S.sel) { S.sel = mode === "subtract" ? null : shapeMask; return; }
    const x = S.sel.getContext("2d");
    x.globalCompositeOperation = mode === "add" ? "source-over" : "destination-out"; x.drawImage(shapeMask, 0, 0); x.globalCompositeOperation = "source-over";
  }
  function maskBounds(m) {
    const d = m.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, m.width, m.height).data; let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (d[(y * m.width + x) * 4 + 3] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  // Keeps `after` only inside the selection; outside it the layer stays as `before`.
  function mergeSel(layer, before, after) {
    if (!S.sel) return after;
    const r = mk(before.width, before.height), x = r.getContext("2d");
    x.drawImage(before, 0, 0); x.globalCompositeOperation = "destination-out"; x.drawImage(S.sel, -layer.x, -layer.y);
    const m = mk(before.width, before.height), mx = m.getContext("2d"); mx.drawImage(after, 0, 0); mx.globalCompositeOperation = "destination-in"; mx.drawImage(S.sel, -layer.x, -layer.y);
    x.globalCompositeOperation = "source-over"; x.drawImage(m, 0, 0); return r;
  }
  function needLayer() { const a = FE.activeLayer(); if (!a) toast("Add a layer first"); else if (!a.visible) { toast("The active layer is hidden"); return null; } return a; }
  const sel = {
    all() { FE.pushUndo(); S.sel = newMask(true); selectionChanged(); },
    none() { if (!S.sel) return; FE.pushUndo(); S.sel = null; selectionChanged(); },
    invert() { FE.pushUndo(); const m = newMask(true), x = m.getContext("2d"); if (S.sel) { x.globalCompositeOperation = "destination-out"; x.drawImage(S.sel, 0, 0); } S.sel = m; selectionChanged(); },
    feather(px) { if (!S.sel) return; FE.pushUndo(); const m = newMask(false); m.getContext("2d").drawImage(blurCanvas(S.sel, px), 0, 0); S.sel = m; selectionChanged(); },
    grow(px) { if (!S.sel) return; FE.pushUndo(); const m = newMask(false), x = m.getContext("2d"); for (let a = 0; a < 16; a++) x.drawImage(S.sel, Math.cos(a / 16 * 6.283) * px, Math.sin(a / 16 * 6.283) * px); S.sel = m; selectionChanged(); },
    async subject(opts = {}) {
      FE.doRender(); toast("Finding the subject…");
      await new Promise((r) => setTimeout(r, 30));
      const res = window.FastAI.removeBackground(FE.view);
      if (!res.ok) { toast(res.reason); return false; }
      if (!opts.noUndo) FE.pushUndo(); const m = newMask(false), x = m.getContext("2d"); x.drawImage(res.canvas, 0, 0); x.globalCompositeOperation = "source-in"; x.fillStyle = "#fff"; x.fillRect(0, 0, S.w, S.h);
      S.sel = m; selectionChanged(); toast(`Selected the subject (${Math.round(res.subjectShare * 100)}% of the picture)`); return true;
    },
  };

  /* ================= opts bar entries for the new tools ================= */
  const opts = $("#opts");
  opts.insertAdjacentHTML("beforeend", `
    <div class="opt" data-for="select"><span>Mode</span><select id="selMode"><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option><option value="lasso">Lasso</option><option value="wand">Magic wand</option></select></div>
    <div class="opt" data-for="select bucket"><span>Tolerance</span><input type="range" id="optTol" min="0" max="120" value="32"><output id="optTolV">32</output></div>
    <div class="grp" data-for="select"><button class="btn sm" id="selSubject">Select subject</button><button class="btn sm" id="selAll">All</button><button class="btn sm" id="selNone" data-needs-sel>Deselect</button><button class="btn sm" id="selInv" data-needs-sel>Invert</button></div>
    <div class="hint" data-for="select">Shift adds, Alt subtracts. <span id="selInfo"></span></div>
    <div class="opt" data-for="shape"><span>Shape</span><select id="shapeKind"><option value="rect">Rectangle</option><option value="round">Rounded</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="arrow">Arrow</option></select></div>
    <div class="opt" data-for="shape"><span>Fill</span><input type="checkbox" id="shapeFill" checked></div>
    <div class="opt" data-for="shape"><span>Stroke</span><input type="range" id="shapeStroke" min="0" max="60" value="0"><output id="shapeStrokeV">0px</output></div>
    <div class="opt" data-for="gradient"><span>Type</span><select id="gradKind"><option value="linear">Linear</option><option value="radial">Radial</option></select></div>
    <div class="opt" data-for="gradient shape"><span>2nd color</span><input type="color" id="color2" value="#1b2546" aria-label="Second color"></div>
    <div class="opt" data-for="gradient"><span>To transparent</span><input type="checkbox" id="gradClear"></div>
    <div class="hint" data-for="bucket">Click to fill an area of similar color on the active layer.</div>
    <div class="hint" data-for="clone"><span id="cloneHint">Alt-click to pick the spot to copy from, then paint.</span> <button class="btn sm" id="cloneSet">Pick source</button></div>
    <div class="opt" data-for="clone"><span>Size</span><input type="range" id="cloneSize" min="4" max="300" value="60"><output id="cloneSizeV">60px</output></div>`);
  const bindOut = (id, unit) => { const i = $(id), o = $(id + "V"); const f = () => (o.textContent = i.value + unit); i.addEventListener("input", f); f(); };
  bindOut("#optTol", ""); bindOut("#shapeStroke", "px"); bindOut("#cloneSize", "px");
  $("#selSubject").onclick = () => sel.subject(); $("#selAll").onclick = sel.all; $("#selNone").onclick = sel.none; $("#selInv").onclick = sel.invert;

  /* ================= rail buttons ================= */
  const ICON = {
    select: '<path d="M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8" />',
    shape: '<rect x="3" y="3" width="11" height="11" rx="1.5"/><circle cx="15.5" cy="15.5" r="5.5"/>',
    gradient: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 21 21 3" opacity=".5"/><path d="M8 3 3 8M14 3 3 14M21 10 10 21M21 16 16 21"/>',
    bucket: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M5 11h14"/><path d="M20 15s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z"/>',
    clone: '<path d="M9 14v6h6M9 14l6-6M15 8V4M12 4h6"/><circle cx="7" cy="7" r="3"/>',
  };
  const NAMES = { select: "Select (M)", shape: "Shape (U)", gradient: "Gradient (G)", bucket: "Paint bucket (K)", clone: "Clone stamp (S)" };
  const sep = $("#rail .sep");
  for (const k of ["select", "shape", "gradient", "bucket", "clone"]) {
    const b = document.createElement("button"); b.className = "tool"; b.dataset.tool = k; b.title = NAMES[k]; b.setAttribute("aria-label", NAMES[k].replace(/ \(.\)$/, ""));
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
    b.onclick = () => FE.setTool(k); sep.before(b);
  }

  /* ================= tools ================= */
  let st = null;
  const clearPrev = () => pctx.clearRect(0, 0, prevCv.width, prevCv.height);
  const modeOf = (e) => (e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");

  FE.EXT.select = {
    cursor: "crosshair",
    down(p, e) {
      const mode = $("#selMode").value;
      if (mode === "wand") { wand(p, modeOf(e)); return; }
      st = { mode, op: modeOf(e), x0: p.x, y0: p.y, pts: [p] };
    },
    move(p, e) {
      if (!st) return; clearPrev(); st.x1 = p.x; st.y1 = p.y; if (st.mode === "lasso") st.pts.push(p);
      pctx.save(); pctx.setLineDash([6, 4]); pctx.lineWidth = Math.max(1, 1.5 / S.zoom); pctx.strokeStyle = "#fff"; pctx.beginPath(); shapePath(pctx, st, e.shiftKey); pctx.stroke(); pctx.strokeStyle = "#000"; pctx.lineDashOffset = 5; pctx.stroke(); pctx.restore();
    },
    up() {
      if (!st) return; clearPrev();
      const tiny = st.mode !== "lasso" ? Math.abs((st.x1 ?? st.x0) - st.x0) < 2 || Math.abs((st.y1 ?? st.y0) - st.y0) < 2 : st.pts.length < 3;
      if (tiny) { if (st.op === "replace" && S.sel) sel.none(); st = null; return; }
      FE.pushUndo(); const m = newMask(false), x = m.getContext("2d"); x.fillStyle = "#fff"; x.beginPath(); shapePath(x, st, false); x.fill();
      combine(m, st.op); st = null; selectionChanged();
    },
    leave() { clearPrev(); st = null; },
  };
  function shapePath(c, s, square) {
    let x1 = s.x1 ?? s.x0, y1 = s.y1 ?? s.y0;
    if (square) { const d = Math.max(Math.abs(x1 - s.x0), Math.abs(y1 - s.y0)); x1 = s.x0 + Math.sign(x1 - s.x0 || 1) * d; y1 = s.y0 + Math.sign(y1 - s.y0 || 1) * d; }
    if (s.mode === "rect") c.rect(Math.min(s.x0, x1), Math.min(s.y0, y1), Math.abs(x1 - s.x0), Math.abs(y1 - s.y0));
    else if (s.mode === "ellipse") c.ellipse((s.x0 + x1) / 2, (s.y0 + y1) / 2, Math.abs(x1 - s.x0) / 2, Math.abs(y1 - s.y0) / 2, 0, 0, 7);
    else { s.pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.closePath(); }
  }
  function floodMask(srcData, w, h, sx, sy, tol) {
    sx = Math.round(sx); sy = Math.round(sy); const out = new Uint8Array(w * h); if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
    const i0 = (sy * w + sx) * 4, r0 = srcData[i0], g0 = srcData[i0 + 1], b0 = srcData[i0 + 2], a0 = srcData[i0 + 3], t2 = tol * tol * 3;
    const close = (p) => { const i = p * 4, dr = srcData[i] - r0, dg = srcData[i + 1] - g0, db = srcData[i + 2] - b0, da = srcData[i + 3] - a0; return dr * dr + dg * dg + db * db + da * da <= t2; };
    const stack = [sy * w + sx]; out[sy * w + sx] = 1;
    while (stack.length) { const p = stack.pop(), x = p % w, y = (p / w) | 0;
      if (x > 0 && !out[p - 1] && close(p - 1)) { out[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !out[p + 1] && close(p + 1)) { out[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !out[p - w] && close(p - w)) { out[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !out[p + w] && close(p + w)) { out[p + w] = 1; stack.push(p + w); } }
    return out;
  }
  function maskFromBits(bits, w, h) { const m = mk(w, h), x = m.getContext("2d"), img = x.createImageData(w, h); for (let i = 0; i < bits.length; i++) if (bits[i]) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255; } x.putImageData(img, 0, 0); return m; }
  function wand(p, op) {
    FE.doRender(); const d = FE.view.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, S.w, S.h).data;
    const bits = floodMask(d, S.w, S.h, p.x, p.y, +$("#optTol").value);
    FE.pushUndo(); combine(maskFromBits(bits, S.w, S.h), op); selectionChanged();
  }

  FE.EXT.shape = {
    cursor: "crosshair",
    down(p) { st = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; },
    move(p, e) { if (!st) return; st.x1 = p.x; st.y1 = p.y; st.shift = e.shiftKey; clearPrev(); drawShape(pctx, st); },
    up() {
      if (!st) return; clearPrev();
      if (Math.hypot(st.x1 - st.x0, st.y1 - st.y0) < 3) { st = null; return; }
      FE.pushUndo(); const l = FE.makeLayer("Shape"); drawShape(l.canvas.getContext("2d"), st); st = null; FE.addLayer(l);
    },
    leave() { clearPrev(); st = null; },
  };
  function drawShape(c, s) {
    const kind = $("#shapeKind").value, fill = $("#shapeFill").checked, sw = +$("#shapeStroke").value, col = FE.color(), col2 = $("#color2").value;
    let { x0, y0, x1, y1 } = s;
    if (s.shift) { if (kind === "line" || kind === "arrow") { const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(x1 - x0, y1 - y0); x1 = x0 + Math.cos(a) * r; y1 = y0 + Math.sin(a) * r; } else { const d = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); x1 = x0 + Math.sign(x1 - x0 || 1) * d; y1 = y0 + Math.sign(y1 - y0 || 1) * d; } }
    c.save(); c.lineJoin = c.lineCap = "round"; c.fillStyle = col; c.strokeStyle = fill ? col2 : col; c.lineWidth = sw || (kind === "line" || kind === "arrow" ? 8 : 0);
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    c.beginPath();
    if (kind === "rect") c.rect(x, y, w, h);
    else if (kind === "round") { const r = Math.min(w, h) * 0.18; if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); }
    else if (kind === "ellipse") c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7);
    if (kind === "line" || kind === "arrow") {
      c.strokeStyle = col; c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      if (kind === "arrow") { const a = Math.atan2(y1 - y0, x1 - x0), L = Math.max(14, c.lineWidth * 3.5); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 - L * Math.cos(a - 0.45), y1 - L * Math.sin(a - 0.45)); c.lineTo(x1 - L * Math.cos(a + 0.45), y1 - L * Math.sin(a + 0.45)); c.closePath(); c.fill(); }
    } else { if (fill) c.fill(); if (sw || !fill) { if (!sw) c.lineWidth = 4; c.stroke(); } }
    c.restore();
  }

  FE.EXT.gradient = {
    cursor: "crosshair",
    down(p) { st = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; },
    move(p) { if (!st) return; st.x1 = p.x; st.y1 = p.y; clearPrev(); pctx.save(); pctx.strokeStyle = "#fff"; pctx.lineWidth = Math.max(1, 2 / S.zoom); pctx.setLineDash([8, 6]); pctx.beginPath(); pctx.moveTo(st.x0, st.y0); pctx.lineTo(st.x1, st.y1); pctx.stroke(); pctx.restore(); },
    up() {
      if (!st) return; clearPrev(); const s = st; st = null;
      if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 3) return;
      const a = needLayer(); if (!a) return;
      FE.pushUndo();
      const before = FE.clone(a.canvas), after = FE.clone(a.canvas), x = after.getContext("2d");
      const x0 = s.x0 - a.x, y0 = s.y0 - a.y, x1 = s.x1 - a.x, y1 = s.y1 - a.y;
      const g = $("#gradKind").value === "radial" ? x.createRadialGradient(x0, y0, 0, x0, y0, Math.hypot(x1 - x0, y1 - y0)) : x.createLinearGradient(x0, y0, x1, y1);
      const c1 = FE.color(), c2 = $("#gradClear").checked ? c1 + "00" : $("#color2").value;
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      x.globalAlpha = FE.optOpacity(); x.fillStyle = g; x.fillRect(0, 0, after.width, after.height);
      a.canvas = mergeSel(a, before, after); FE.renderLayers(); FE.render();
    },
    leave() { clearPrev(); st = null; },
  };

  FE.EXT.bucket = {
    cursor: "crosshair",
    down(p) {
      const a = needLayer(); if (!a) return;
      const w = a.canvas.width, h = a.canvas.height, d = a.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      const bits = floodMask(d, w, h, p.x - a.x, p.y - a.y, +$("#optTol").value);
      FE.pushUndo();
      const fillC = mk(w, h), fx = fillC.getContext("2d"); fx.drawImage(maskFromBits(bits, w, h), 0, 0); fx.globalCompositeOperation = "source-in"; fx.fillStyle = FE.color(); fx.fillRect(0, 0, w, h);
      const before = FE.clone(a.canvas), after = FE.clone(a.canvas), ax = after.getContext("2d"); ax.globalAlpha = FE.optOpacity(); ax.drawImage(fillC, 0, 0);
      a.canvas = mergeSel(a, before, after); FE.renderLayers(); FE.render();
    },
  };

  let cloneSrc = null, pickSrc = false;
  FE.EXT.clone = {
    cursor: "crosshair",
    down(p, e) {
      if (e.altKey || pickSrc) { cloneSrc = p; pickSrc = false; $("#cloneHint").textContent = `Copying from ${Math.round(p.x)}, ${Math.round(p.y)}. Now paint where you want the copy.`; return; }
      if (!cloneSrc) { toast("Alt-click (or tap Pick source) to choose where to copy from first"); return; }
      const a = needLayer(); if (!a) return;
      FE.pushUndo();
      st = { layer: a, before: FE.clone(a.canvas), snap: FE.clone(a.canvas), dx: cloneSrc.x - p.x, dy: cloneSrc.y - p.y, last: null };
      dab(p);
    },
    move(p) { if (!st) return; const l = st.last, r = +$("#cloneSize").value / 2, step = Math.max(1, r * 0.25); if (l) { const d = Math.hypot(p.x - l.x, p.y - l.y); for (let t = step; t < d; t += step) dab({ x: l.x + ((p.x - l.x) * t) / d, y: l.y + ((p.y - l.y) * t) / d }); } dab(p); },
    up() {
      if (!st) return; const a = st.layer;
      a.canvas = mergeSel(a, st.before, a.canvas);
      if (cloneSrc) cloneSrc = { x: cloneSrc.x, y: cloneSrc.y };
      st = null; FE.renderLayers(); FE.render();
    },
    leave() { st = null; },
  };
  $("#cloneSet").onclick = () => { pickSrc = true; FE.setTool("clone"); $("#cloneHint").textContent = "Tap the spot to copy from."; };
  function dab(p) {
    const a = st.layer, r = Math.max(2, +$("#cloneSize").value / 2), soft = FE.optSoft(), size = Math.ceil(r * 2), stamp = mk(size, size), sx = stamp.getContext("2d");
    sx.drawImage(st.snap, -(p.x + st.dx - a.x - r), -(p.y + st.dy - a.y - r));
    const g = sx.createRadialGradient(r, r, 0, r, r, r); g.addColorStop(0, "#000"); g.addColorStop(clamp(1 - soft, 0.05, 0.98), "#000"); g.addColorStop(1, "rgba(0,0,0,0)");
    sx.globalCompositeOperation = "destination-in"; sx.fillStyle = g; sx.fillRect(0, 0, size, size);
    const x = a.canvas.getContext("2d"); x.save(); x.globalAlpha = FE.optOpacity(); x.drawImage(stamp, p.x - a.x - r, p.y - a.y - r); x.restore();
    st.last = p; FE.render();
  }

  /* ================= filters ================= */
  function blurCanvas(src, radius) {
    const w = src.width, h = src.height, out = mk(w, h);
    if (radius <= 0) { out.getContext("2d").drawImage(src, 0, 0); return out; }
    const d = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h), a = d.data, b = new Uint8ClampedArray(a.length);
    const r = Math.max(1, Math.round(radius / 2)); // three box passes approximate a gaussian
    const pass = (s, t, horiz) => {
      const len = horiz ? w : h, lines = horiz ? h : w, stride = horiz ? 4 : w * 4;
      for (let L = 0; L < lines; L++) {
        const base = horiz ? L * w * 4 : L * 4;
        for (let c = 0; c < 4; c++) {
          let acc = 0; for (let k = -r; k <= r; k++) acc += s[base + clamp(k, 0, len - 1) * stride + c];
          for (let i = 0; i < len; i++) { t[base + i * stride + c] = acc / (2 * r + 1); acc += s[base + Math.min(len - 1, i + r + 1) * stride + c] - s[base + Math.max(0, i - r) * stride + c]; }
        }
      }
    };
    for (let k = 0; k < 3; k++) { pass(a, b, true); pass(b, a, false); }
    out.getContext("2d").putImageData(d, 0, 0); return out;
  }
  function pixelOp(src, fn) { const w = src.width, h = src.height, out = mk(w, h), x = out.getContext("2d"), d = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h); fn(d.data, w, h); x.putImageData(d, 0, 0); return out; }
  function convolve(src, k, mix = 1, bias = 0, gray = false) {
    return pixelOp(src, (d, w, h) => {
      const s = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) { let acc = 0, n = 0; for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) { const yy = clamp(y + ky, 0, h - 1), xx = clamp(x + kx, 0, w - 1); acc += s[(yy * w + xx) * 4 + c] * k[n++]; } d[i + c] = s[i + c] * (1 - mix) + (acc + bias) * mix; }
        if (gray) { const g = (d[i] + d[i + 1] + d[i + 2]) / 3; d[i] = d[i + 1] = d[i + 2] = g; }
      }
    });
  }
  const FILTERS = {
    blur: { name: "Gaussian blur", params: [{ k: "r", label: "Radius", min: 1, max: 80, v: 8, unit: "px" }], run: (c, p) => blurCanvas(c, p.r) },
    motion: { name: "Motion blur", params: [{ k: "a", label: "Angle", min: -90, max: 90, v: 0, unit: "°" }, { k: "d", label: "Distance", min: 2, max: 200, v: 30, unit: "px" }], run: (c, p) => { const o = mk(c.width, c.height), x = o.getContext("2d"), n = Math.min(40, Math.max(4, Math.round(p.d / 3))), a = (p.a * Math.PI) / 180; for (let i = 0; i < n; i++) { const t = (i / (n - 1) - 0.5) * p.d; x.globalAlpha = 1 / (i + 1); x.drawImage(c, Math.cos(a) * t, Math.sin(a) * t); } return o; } },
    unsharp: { name: "Unsharp mask", params: [{ k: "amt", label: "Amount", min: 10, max: 300, v: 80, unit: "%" }, { k: "r", label: "Radius", min: 1, max: 20, v: 2, unit: "px" }, { k: "th", label: "Threshold", min: 0, max: 60, v: 2, unit: "" }], run: (c, p) => { const b = blurCanvas(c, p.r).getContext("2d").getImageData(0, 0, c.width, c.height).data, k = p.amt / 100; return pixelOp(c, (d) => { for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < 3; ch++) { const diff = d[i + ch] - b[i + ch]; if (Math.abs(diff) >= p.th) d[i + ch] += diff * k; } }); } },
    noise: { name: "Add noise", params: [{ k: "amt", label: "Amount", min: 1, max: 100, v: 18, unit: "%" }, { k: "mono", label: "Monochrome", min: 0, max: 1, v: 1, unit: "", step: 1 }], run: (c, p) => pixelOp(c, (d) => { const A = p.amt * 1.6; for (let i = 0; i < d.length; i += 4) { if (p.mono) { const n = (Math.random() - 0.5) * A; d[i] += n; d[i + 1] += n; d[i + 2] += n; } else { d[i] += (Math.random() - 0.5) * A; d[i + 1] += (Math.random() - 0.5) * A; d[i + 2] += (Math.random() - 0.5) * A; } } }) },
    pixelate: { name: "Pixelate", params: [{ k: "s", label: "Cell size", min: 2, max: 120, v: 16, unit: "px" }], run: (c, p) => { const sw = Math.max(1, Math.round(c.width / p.s)), sh = Math.max(1, Math.round(c.height / p.s)), t = mk(sw, sh), o = mk(c.width, c.height), tx = t.getContext("2d"), ox = o.getContext("2d"); tx.drawImage(c, 0, 0, sw, sh); ox.imageSmoothingEnabled = false; ox.drawImage(t, 0, 0, c.width, c.height); return o; } },
    emboss: { name: "Emboss", params: [{ k: "mix", label: "Strength", min: 10, max: 100, v: 100, unit: "%" }], run: (c, p) => convolve(c, [-2, -1, 0, -1, 1, 1, 0, 1, 2], p.mix / 100, 0, p.mix >= 100) },
    edges: { name: "Find edges", params: [], run: (c) => pixelOp(c, (d, w, h) => { const s = new Uint8ClampedArray(d); const L = (x, y) => { const i = (clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) * 4; return 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2]; }; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const gx = -L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1) + L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1), gy = -L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1) + L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1), v = 255 - Math.min(255, Math.hypot(gx, gy)), i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; } }) },
    posterize: { name: "Posterize", params: [{ k: "n", label: "Levels", min: 2, max: 16, v: 5, unit: "", step: 1 }], run: (c, p) => pixelOp(c, (d) => { const n = p.n - 1; for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.round((d[i + ch] / 255) * n) * (255 / n); }) },
    threshold: { name: "Threshold", params: [{ k: "t", label: "Level", min: 1, max: 254, v: 128, unit: "", step: 1 }], run: (c, p) => pixelOp(c, (d) => { for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] >= p.t ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } }) },
    invert: { name: "Invert", params: [], run: (c) => pixelOp(c, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } }) },
  };

  /* modal dialog */
  document.body.insertAdjacentHTML("beforeend", `<div class="fe-modal" id="feModal" hidden><div class="fe-dialog" role="dialog" aria-modal="true" aria-labelledby="feModalTitle"><h3 id="feModalTitle"></h3><div id="feModalBody"></div><div class="fe-modal-foot"><label class="check" id="fePrevWrap"><input type="checkbox" id="fePreview" checked> Preview</label><span class="spacer"></span><button class="btn" id="feCancel" type="button">Cancel</button><button class="btn primary" id="feOk" type="button">Apply</button></div></div></div>`);
  let modal = null;
  function openDialog({ title, fields, preview, apply, cancel, okLabel }) {
    $("#feModalTitle").textContent = title; $("#feOk").textContent = okLabel || "Apply";
    const body = $("#feModalBody"); body.innerHTML = "";
    const vals = {};
    for (const f of fields) {
      vals[f.k] = f.v; const row = document.createElement("div"); row.className = "fe-field";
      if (f.type === "number") row.innerHTML = `<label for="fe-${f.k}">${f.label}</label><input type="number" id="fe-${f.k}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${f.v}"><span>${f.unit || ""}</span>`;
      else if (f.type === "check") row.innerHTML = `<label class="check"><input type="checkbox" id="fe-${f.k}" ${f.v ? "checked" : ""}> ${f.label}</label>`;
      else row.innerHTML = `<label for="fe-${f.k}">${f.label}</label><input type="range" id="fe-${f.k}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${f.v}"><output>${f.v}${f.unit || ""}</output>`;
      body.append(row);
      const inp = row.querySelector("input"), out = row.querySelector("output");
      inp.addEventListener("input", () => { vals[f.k] = f.type === "check" ? inp.checked : +inp.value; if (out) out.textContent = inp.value + (f.unit || ""); if (f.onInput) f.onInput(vals, body); schedule(); });
    }
    let tmr = 0; const schedule = () => { if (!preview) return; clearTimeout(tmr); tmr = setTimeout(() => { if ($("#fePreview").checked) preview(vals); else cancel && cancel(true); }, 120); };
    $("#fePrevWrap").hidden = !preview;
    $("#fePreview").onchange = () => schedule();
    modal = { apply: () => apply(vals), cancel };
    $("#feModal").hidden = false; setTimeout(() => body.querySelector("input")?.focus(), 30);
    if (preview) schedule();
  }
  function closeDialog(ok) { if (!modal) return; const m = modal; modal = null; $("#feModal").hidden = true; ok ? m.apply() : m.cancel && m.cancel(false); }
  $("#feOk").onclick = () => closeDialog(true); $("#feCancel").onclick = () => closeDialog(false);
  $("#feModal").addEventListener("keydown", (e) => { if (e.key === "Escape") closeDialog(false); if (e.key === "Enter" && e.target.tagName === "INPUT") closeDialog(true); });

  function runFilter(id) {
    const F = FILTERS[id], a = needLayer(); if (!a) return;
    const before = FE.clone(a.canvas);
    const compute = (p) => mergeSel(a, before, F.run(before, p));
    if (!F.params.length) { FE.pushUndo(); a.canvas = compute({}); FE.renderLayers(); FE.render(); toast(F.name + " applied"); return; }
    FE.pushUndo();
    openDialog({
      title: F.name, fields: F.params.map((q) => ({ ...q, type: q.min === 0 && q.max === 1 ? "check" : "range" })),
      preview: (p) => { a.canvas = compute(p); FE.render(); },
      cancel: (keep) => { a.canvas = before; FE.render(); if (!keep) FE.dropUndo(); },
      apply: (p) => { a.canvas = compute(p); FE.renderLayers(); FE.render(); toast(F.name + " applied"); },
    });
  }

  /* ================= image, layer & file commands ================= */
  function imageSize() {
    const ratio = S.w / S.h;
    openDialog({
      title: "Image size", okLabel: "Resize",
      fields: [{ k: "w", label: "Width", type: "number", min: 16, max: 8000, v: S.w, unit: "px", onInput: (v, b) => { if (v.keep) { v.h = Math.round(v.w / ratio); b.querySelector("#fe-h").value = v.h; } } },
        { k: "h", label: "Height", type: "number", min: 16, max: 8000, v: S.h, unit: "px", onInput: (v, b) => { if (v.keep) { v.w = Math.round(v.h * ratio); b.querySelector("#fe-w").value = v.w; } } },
        { k: "keep", label: "Keep proportions", type: "check", v: true }],
      apply: (v) => {
        const W = clamp(Math.round(v.w), 16, 8000), H = clamp(Math.round(v.h), 16, 8000), kx = W / S.w, ky = H / S.h; if (W === S.w && H === S.h) return;
        FE.pushUndo();
        for (const l of S.layers) { const c = mk(Math.max(1, l.canvas.width * kx), Math.max(1, l.canvas.height * ky)), x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(l.canvas, 0, 0, c.width, c.height); l.canvas = c; l.x = Math.round(l.x * kx); l.y = Math.round(l.y * ky); }
        S.w = W; S.h = H; S.sel = null; FE.sizeDoc(); FE.zoomFit(); FE.renderLayers(); FE.render(); toast(`Resized to ${W} × ${H}`);
      },
    });
  }
  function cropToSel() { if (!S.sel) return toast("Make a selection first"); const b = maskBounds(S.sel); if (!b) return; FE.pushUndo(); S.sel = null; FE.cropDoc(b.x, b.y, b.w, b.h); selectionChanged(); toast(`Cropped to ${S.w} × ${S.h}`); }
  function fillSel() { const a = needLayer(); if (!a) return; FE.pushUndo(); const before = FE.clone(a.canvas), after = FE.clone(a.canvas), x = after.getContext("2d"); x.globalAlpha = FE.optOpacity(); x.fillStyle = FE.color(); x.fillRect(0, 0, after.width, after.height); a.canvas = mergeSel(a, before, after); FE.renderLayers(); FE.render(); }
  function clearSel() { const a = needLayer(); if (!a) return; if (!S.sel) return toast("Make a selection first, or use Layer › Clear"); FE.pushUndo(); const x = a.canvas.getContext("2d"); x.globalCompositeOperation = "destination-out"; x.drawImage(S.sel, -a.x, -a.y); x.globalCompositeOperation = "source-over"; FE.renderLayers(); FE.render(); }
  function viaCopy(cut) {
    const a = needLayer(); if (!a) return; if (!S.sel) return toast("Make a selection first");
    FE.pushUndo(); const c = FE.clone(a.canvas), x = c.getContext("2d"); x.globalCompositeOperation = "destination-in"; x.drawImage(S.sel, -a.x, -a.y);
    if (cut) { const ax = a.canvas.getContext("2d"); ax.globalCompositeOperation = "destination-out"; ax.drawImage(S.sel, -a.x, -a.y); ax.globalCompositeOperation = "source-over"; }
    FE.addLayer(FE.makeLayer(a.name + (cut ? " (cut)" : " (copy)"), c, { x: a.x, y: a.y }));
  }
  function flatten() {
    if (S.layers.length < 2) return toast("There's only one layer");
    FE.pushUndo(); const c = mk(S.w, S.h), x = c.getContext("2d");
    for (const l of S.layers) { if (!l.visible) continue; x.globalAlpha = l.opacity; x.globalCompositeOperation = l.blend; x.drawImage(l.canvas, l.x, l.y); }
    S.layers = [FE.makeLayer("Background", c)]; S.active = S.layers[0].id; FE.renderLayers(); FE.render(); toast("Flattened to one layer");
  }
  function autoTone() { const plan = window.FastAI.plan("auto enhance", { mode: "edit", adj: { ...S.adj }, image: (FE.doRender(), FE.view) }); FE.pushUndo(); Object.assign(S.adj, plan.adjustments); FE.syncAdj(); FE.render(); toast("Auto tone applied"); }

  // .fedit project files: layers as PNG, plus adjustments and curves
  function saveProject() {
    const proj = { app: "fastedit", v: 1, w: S.w, h: S.h, adj: S.adj, tone: S.tone, active: S.layers.findIndex((l) => l.id === S.active), layers: S.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, png: l.canvas.toDataURL("image/png") })) };
    const blob = new Blob([JSON.stringify(proj)], { type: "application/json" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `fastedit-project-${S.w}x${S.h}.fedit`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Saved the project (${(blob.size / 1048576).toFixed(1)} MB)`);
  }
  const projIn = document.createElement("input"); projIn.type = "file"; projIn.accept = ".fedit,application/json"; projIn.hidden = true; document.body.append(projIn);
  projIn.onchange = async () => {
    const f = projIn.files[0]; projIn.value = ""; if (!f) return;
    try {
      const p = JSON.parse(await f.text()); if (p.app !== "fastedit" || !Array.isArray(p.layers)) throw new Error("not a project");
      const layers = [];
      for (const L of p.layers) { const img = new Image(); img.src = L.png; await img.decode(); const c = mk(img.naturalWidth, img.naturalHeight); c.getContext("2d").drawImage(img, 0, 0); layers.push(FE.makeLayer(String(L.name || "Layer"), c, { visible: L.visible !== false, opacity: +L.opacity || 1, blend: L.blend || "source-over", x: +L.x || 0, y: +L.y || 0 })); }
      FE.pushUndo(); S.w = p.w; S.h = p.h; S.layers = layers; S.active = (layers[p.active] || layers[layers.length - 1]).id; S.adj = { ...FE.DEF, ...(p.adj || {}) }; S.tone = p.tone ? Tone.cloneTone(p.tone) : Tone.defaultTone(); S.sel = null;
      FE.sizeDoc(); FE.zoomFit(); FE.syncAdj(); FE.renderLayers(); FE.render(); toneUI && toneUI.draw(); toast(`Opened ${f.name}`);
    } catch (e) { toast("That file isn't a Fast Edit project"); }
  };

  /* ================= menu bar ================= */
  const MENUS = [
    ["File", [["New…", () => $("#btnNew").click(), "Ctrl+Alt+N"], ["Open image…", () => $("#btnOpen").click(), "Ctrl+O"], ["Place image as layer…", () => $("#lyPlace").click()], "-", ["Open project…", () => projIn.click()], ["Save project", saveProject, "Ctrl+S"], "-", ["Export PNG", () => $('[data-export="png"]').click()], ["Export JPEG", () => $('[data-export="jpeg"]').click()], ["Export WebP", () => $('[data-export="webp"]').click()]]],
    ["Edit", [["Undo", () => FE.doUndo(), "Ctrl+Z"], ["Redo", () => FE.doRedo(), "Ctrl+Shift+Z"], "-", ["Fill with color", fillSel], ["Clear selection area", clearSel, "Del", true], "-", ["Copy to new layer", () => viaCopy(false), "Ctrl+J", true], ["Cut to new layer", () => viaCopy(true), "Ctrl+Shift+J", true]]],
    ["Image", [["Curves & Levels…", () => openTone(), "Ctrl+M"], ["Auto tone", autoTone, "Ctrl+Shift+L"], "-", ["Image size…", imageSize, "Ctrl+Alt+I"], ["Crop to selection", cropToSel, "", true], "-", ["Rotate 90° left", () => { FE.pushUndo(); FE.rotateDoc(270); }], ["Rotate 90° right", () => { FE.pushUndo(); FE.rotateDoc(90); }], ["Rotate 180°", () => { FE.pushUndo(); FE.rotateDoc(180); }], ["Flip horizontal", () => { FE.pushUndo(); FE.flipDoc("h"); }], ["Flip vertical", () => { FE.pushUndo(); FE.flipDoc("v"); }]]],
    ["Layer", [["New layer", () => $("#lyNew").click(), "Ctrl+Shift+N"], ["Duplicate layer", () => $("#lyDup").click()], ["Delete layer", () => $("#lyDel").click()], "-", ["Merge down", () => $("#lyMerge").click(), "Ctrl+E"], ["Flatten image", flatten], "-", ["Layers panel", () => document.querySelector('#t-layers').click()]]],
    ["Select", [["All", sel.all, "Ctrl+A"], ["Deselect", sel.none, "Ctrl+D", true], ["Inverse", sel.invert, "Ctrl+Shift+I"], "-", ["Select subject (AI)", () => sel.subject()], "-", ["Feather…", () => openDialog({ title: "Feather selection", fields: [{ k: "r", label: "Radius", min: 1, max: 100, v: 10, unit: "px" }], apply: (v) => sel.feather(v.r) }), "", true], ["Grow…", () => openDialog({ title: "Grow selection", fields: [{ k: "r", label: "By", min: 1, max: 100, v: 8, unit: "px" }], apply: (v) => sel.grow(v.r) }), "", true]]],
    ["Filter", Object.entries(FILTERS).map(([id, F]) => [F.name + (F.params.length ? "…" : ""), () => runFilter(id)])],
    ["View", [["Zoom in", () => FE.setZoom(S.zoom * 1.25), "Ctrl++"], ["Zoom out", () => FE.setZoom(S.zoom / 1.25), "Ctrl+−"], ["Fit on screen", () => FE.zoomFit(), "Ctrl+0"], ["Actual pixels", () => FE.setZoom(1), "Ctrl+1"]]],
  ];
  const bar = document.createElement("nav"); bar.className = "menubar photo-only"; bar.setAttribute("aria-label", "Menu");
  let openMenu = null;
  for (const [name, items] of MENUS) {
    const wrapM = document.createElement("div"); wrapM.className = "menu";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "menu-btn"; btn.textContent = name; btn.setAttribute("aria-haspopup", "menu");
    const list = document.createElement("div"); list.className = "menu-list"; list.setAttribute("role", "menu"); list.hidden = true;
    for (const it of items) {
      if (it === "-") { const hr = document.createElement("div"); hr.className = "menu-sep"; list.append(hr); continue; }
      const [label, fn, key, needsSel] = it, b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem");
      b.innerHTML = `<span></span><kbd>${key || ""}</kbd>`; b.firstChild.textContent = label; if (needsSel) b.dataset.needsSel = "";
      b.onclick = () => { closeMenus(); fn(); }; list.append(b);
    }
    btn.onclick = (e) => { e.stopPropagation(); const willOpen = list.hidden; closeMenus(); if (willOpen) { list.hidden = false; openMenu = list; btn.setAttribute("aria-expanded", "true"); } };
    btn.onmouseenter = () => { if (openMenu && openMenu !== list) { closeMenus(); list.hidden = false; openMenu = list; } };
    wrapM.append(btn, list); bar.append(wrapM);
  }
  function closeMenus() { $$(".menu-list").forEach((l) => (l.hidden = true)); $$(".menu-btn").forEach((b) => b.setAttribute("aria-expanded", "false")); openMenu = null; }
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeMenus(); });
  $(".modeseg").after(bar);

  /* ================= Curves & Levels in the Adjust tab ================= */
  const toneHost = document.createElement("div"); toneHost.className = "tone-box"; toneHost.id = "photoTone";
  $("#adjGroups").before(toneHost);
  let toneEdit = 0;
  const toneUI = Tone.mountToneEditor(toneHost, {
    get: () => Tone.cloneTone(S.tone),
    set: (t) => { if (Date.now() - toneEdit > 900) FE.pushUndo(); toneEdit = Date.now(); S.tone = t; FE.render(); },
    histogram: () => Tone.histogram(FE.comp),
  });
  function openTone() { document.querySelector("#t-adjust").click(); toneHost.scrollIntoView({ block: "start", behavior: "smooth" }); toneUI.draw(); }
  document.querySelector("#t-adjust").addEventListener("click", () => setTimeout(() => toneUI.draw(), 30));
  FE.hooks.changed.push(() => toneUI.draw());
  setTimeout(() => toneUI.draw(), 400);

  /* ================= keyboard ================= */
  document.addEventListener("keydown", (e) => {
    if (document.body.classList.contains("mode-video") || e.target.closest("input, textarea, select") || modal) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const go = (fn) => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };
    if (mod && !e.shiftKey && k === "a") return go(sel.all);
    if (mod && k === "d") return go(sel.none);
    if (mod && e.shiftKey && k === "i") return go(sel.invert);
    if (mod && k === "j") return go(() => viaCopy(e.shiftKey));
    if (mod && k === "s") return go(saveProject);
    if (mod && k === "m") return go(openTone);
    if (mod && k === "e") return go(() => $("#lyMerge").click());
    if (mod && e.shiftKey && k === "l") return go(autoTone);
    if (mod && k === "0") return go(() => FE.zoomFit());
    if (mod && k === "1") return go(() => FE.setZoom(1));
    if ((k === "delete" || k === "backspace") && S.sel && !mod) return go(clearSel);
    if (mod || e.altKey) return;
    const map = { m: "select", u: "shape", g: "gradient", k: "bucket", s: "clone" };
    if (map[k]) go(() => FE.setTool(map[k]));
  }, true);

  sizeOverlays();
  FE.setTool(S.tool); // hide the new tools' options until their tool is picked
  window.PhotoPro = { sel, runFilter, blurCanvas, mergeSel, selectionChanged, FILTERS, saveProject, imageSize };
})();
