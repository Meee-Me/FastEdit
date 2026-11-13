/*
 * Fast Edit — thumbnail designer used by Fast Edit AI (photo and video).
 * Picks the most interesting frame, punches up the colour, makes the subject
 * stand out and sets a big, bold title, at 1280×720.
 */
(function () {
  "use strict";
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h)); return c; };
  const W = 1280, H = 720;

  // How good a frame is as a thumbnail: sharp, colourful, well exposed, with a clear subject.
  function frameScore(canvas) {
    const s = Math.min(1, 160 / Math.max(canvas.width, canvas.height)), c = mk(canvas.width * s, canvas.height * s), x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height;
    let lapSum = 0, lapSq = 0, n = 0;
    const L = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) { const i = (y * w + xx) * 4, v = 4 * L(i) - L(i - 4) - L(i + 4) - L(i - w * 4) - L(i + w * 4); lapSum += v; lapSq += v * v; n++; }
    const sharp = Math.sqrt(Math.max(0, lapSq / n - (lapSum / n) ** 2)) / 40;
    const A = window.FastAI.analyze(c);
    const exposure = 1 - Math.min(1, Math.abs(A.mean - 0.5) * 2.2), salPeak = A.region(0.2, 0.15, 0.8, 0.85) / (A.region(0, 0, 1, 1) || 1);
    return { score: Math.min(1.2, sharp) * 0.35 + Math.min(1, A.colorfulness) * 0.3 + exposure * 0.2 + salPeak * 0.15 - (A.mean < 0.12 ? 0.5 : 0), A };
  }

  // A real subject (a person or object) is compact and doesn't run along the top edge like sky or scenery does.
  function compactSubject(maskCanvas) {
    const s = 96 / maskCanvas.width, c = mk(96, maskCanvas.height * s), x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(maskCanvas, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height; let x0 = w, x1 = -1, y0 = h, y1 = -1, top = 0;
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) if (d[(y * w + xx) * 4 + 3] > 127) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; if (y < 2) top++; }
    if (x1 < 0) return false;
    return (x1 - x0) / w < 0.75 && (y1 - y0) / h < 0.95 && top / (2 * w) < 0.15;
  }
  function cover(src, w, h, fx = 0.5, fy = 0.5) {
    const out = mk(w, h), x = out.getContext("2d"), ar = w / h, sar = src.width / src.height;
    let cw, ch; if (sar > ar) { ch = src.height; cw = ch * ar; } else { cw = src.width; ch = cw / ar; }
    const sx = clamp(fx * src.width - cw / 2, 0, src.width - cw), sy = clamp(fy * src.height - ch / 2, 0, src.height - ch);
    x.drawImage(src, sx, sy, cw, ch, 0, 0, w, h); return out;
  }

  function wrapTitle(ctx, text, maxW) {
    const words = String(text).toUpperCase().split(/\s+/).filter(Boolean), lines = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  }

  /*
   * make({ frame, title, hasTitle }) → { canvas, layers: { background, title } }
   * frame: any canvas; title: words for the thumbnail; hasTitle: the frame already shows a title, so none is added.
   */
  async function make({ frame, title, hasTitle }) {
    const FONTS = (window.FE && window.FE.FONTS) || {}, display = FONTS.display || "system-ui, sans-serif";
    try { await document.fonts.load(`800 120px ${display}`); } catch {}
    const A0 = window.FastAI.analyze(frame);
    const bg = cover(frame, W, H, A0.salCenter.x, A0.salCenter.y);
    // punchier colour
    const punch = mk(W, H), px = punch.getContext("2d");
    px.filter = "contrast(1.14) saturate(1.38) brightness(1.04)"; px.drawImage(bg, 0, 0); px.filter = "none";
    if (px.getImageData(0, 0, 1, 1).data[3] === 0) px.drawImage(bg, 0, 0); // browsers without canvas filters
    const A = window.FastAI.analyze(punch);
    // make the subject stand out with a glow outline
    let subjectSide = A.salCenter.x, outlined = false;
    const cut = window.FastAI.removeBackground(punch);
    if (cut.ok && cut.subjectShare > 0.06 && cut.subjectShare < 0.5 && compactSubject(cut.canvas)) {
      const glow = mk(W, H), gx = glow.getContext("2d");
      gx.shadowColor = "rgba(255,255,255,.95)"; gx.shadowBlur = 26; for (let i = 0; i < 3; i++) gx.drawImage(cut.canvas, 0, 0);
      gx.globalCompositeOperation = "source-in"; gx.fillStyle = "#fff"; gx.fillRect(0, 0, W, H);
      const v = mk(W, H), vx = v.getContext("2d"); vx.drawImage(glow, 0, 0); vx.globalCompositeOperation = "destination-out"; vx.drawImage(cut.canvas, 0, 0);
      px.drawImage(v, 0, 0); px.drawImage(cut.canvas, 0, 0); outlined = true;
    }
    // vignette
    const vg = px.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.45)"); px.fillStyle = vg; px.fillRect(0, 0, W, H);

    const titleLayer = mk(W, H);
    if (!hasTitle && title) {
      const tx = titleLayer.getContext("2d"), left = subjectSide > 0.5, maxW = W * 0.5;
      // shade the text side
      const sh = tx.createLinearGradient(left ? 0 : W, 0, left ? W * 0.62 : W * 0.38, 0); sh.addColorStop(0, "rgba(0,0,0,.62)"); sh.addColorStop(1, "rgba(0,0,0,0)"); tx.fillStyle = sh; tx.fillRect(0, 0, W, H);
      let size = 128; tx.font = `800 ${size}px ${display}`; let lines = wrapTitle(tx, title, maxW);
      while ((lines.length > 3 || lines.some((l) => tx.measureText(l).width > maxW)) && size > 56) { size -= 8; tx.font = `800 ${size}px ${display}`; lines = wrapTitle(tx, title, maxW); }
      const lh = size * 1.02, y0 = H / 2 - ((lines.length - 1) * lh) / 2, x0 = left ? W * 0.06 : W * 0.94;
      const longest = lines.join(" ").split(" ").reduce((a, b) => (b.length > a.length ? b : a), "");
      tx.save(); tx.translate(x0, y0); tx.rotate(-0.035); tx.textAlign = left ? "left" : "right"; tx.textBaseline = "middle"; tx.lineJoin = "round";
      lines.forEach((ln, i) => {
        const y = i * lh;
        tx.shadowColor = "rgba(0,0,0,.6)"; tx.shadowBlur = 24; tx.shadowOffsetY = 8;
        tx.lineWidth = size * 0.16; tx.strokeStyle = "#111"; tx.strokeText(ln, 0, y);
        tx.shadowColor = "transparent";
        tx.fillStyle = ln.includes(longest) && lines.length > 1 ? "#ffd23f" : "#ffffff"; tx.fillText(ln, 0, y);
      });
      // accent bar under the title
      tx.shadowColor = "transparent"; tx.fillStyle = "#f0a43a"; const bw = Math.min(maxW, size * 3); tx.fillRect(left ? 0 : -bw, (lines.length - 1) * lh + size * 0.72, bw, size * 0.12);
      tx.restore();
    }
    const canvas = mk(W, H), cx = canvas.getContext("2d"); cx.drawImage(punch, 0, 0); cx.drawImage(titleLayer, 0, 0);
    return { canvas, outlined, layers: { background: punch, title: titleLayer }, score: frameScore(canvas).score };
  }

  // Picks the best moment from a list of {t, canvas} candidates.
  function pickBest(cands) { let best = null; for (const c of cands) { const sc = frameScore(c.canvas).score; if (!best || sc > best.sc) best = { ...c, sc }; } return best; }

  function download(canvas, name) {
    canvas.toBlob((b) => { if (!b) return; const url = URL.createObjectURL(b), a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }, "image/png");
  }

  window.FastThumb = { make, pickBest, frameScore, download, W, H };
})();
