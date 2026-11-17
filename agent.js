/*
 * Fast Edit AI controls: what an AI (Claude, ChatGPT, ...) can do in the editor, from the tool
 * definitions in agent-tools.mjs. Video operations live in video.js (FEVideo.agent); photo
 * operations are here. Every call returns { text, image? (a small screenshot), error? }.
 */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const FE = window.FE, S = FE.S;
  const mode = () => (document.body.classList.contains("mode-video") ? "video" : "photo");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const numOr = (v, d) => (v !== null && v !== "" && Number.isFinite(+v) ? +v : d);
  const okColor = (c, d) => (typeof c === "string" && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%deg/]+\)|[a-z]{3,20})$/i.test(c.trim()) ? c.trim() : d);
  const fail = (m) => { throw new Error(m); };

  async function ensureMode(m) { if (mode() !== m) { $(`[data-app-mode="${m}"]`).click(); await sleep(450); } }

  /* ---------- what's on screen ---------- */
  function shot(max = 960) {
    const src = mode() === "video" ? $("#vCanvas") : $("#view");
    if (!src || !src.width) return null;
    const k = Math.min(1, max / Math.max(src.width, src.height)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  }
  function photoState() {
    const adj = Object.fromEntries(Object.entries(S.adj).filter(([, v]) => v));
    return { mode: "photo", width: S.w, height: S.h, active_layer: S.active, layers: [...S.layers].reverse().map((l) => ({ id: l.id, name: l.name, visible: l.visible, opacity: +l.opacity.toFixed(2), blend: l.blend, x: l.x, y: l.y, width: l.canvas.width, height: l.canvas.height, has_mask: !!l.mask })), note: "layers are listed top first", adjustments: adj, selection: !!S.sel };
  }
  const state = () => (mode() === "video" ? window.FEVideo.agent.state() : photoState());
  const describe = () => { const st = state(); return JSON.stringify(st); };

  /* ---------- photo tools ---------- */
  const layerById = (id) => S.layers.find((l) => l.id === +id) || fail(`There's no layer ${id}. Ids are in fastedit_look.`);
  const refresh = () => { FE.renderLayers(); FE.render(); };
  function photoAdjust(o) {
    FE.pushUndo();
    if (o.reset) S.adj = { ...FE.DEF };
    if (o.look) { const L = FE.PRESETS[o.look]; if (!L) fail("Unknown look. Looks: " + Object.keys(FE.PRESETS).join(", ")); S.adj = { ...FE.DEF, ...L }; }
    for (const [k, v] of Object.entries(o.values || {})) { if (!(k in FE.DEF) || !Number.isFinite(+v)) continue; const [mn, mx] = k in FE.RANGE ? FE.RANGE[k] : [-100, 100]; S.adj[k] = Math.round(clamp(+v, mn, mx)); }
    FE.syncAdj(); FE.render();
    return "Color and light now: " + (Object.entries(S.adj).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "no adjustments") + ".";
  }
  async function photoText(o) {
    const text = String(o.text || "").trim(); if (!text) fail("text is required.");
    let fam = FE.FONTS[o.font];
    if (!fam && o.font && window.FEMarket) { try { const key = await window.FEMarket.useFont(String(o.font)); fam = FE.FONTS[key]; } catch {} }
    fam = fam || FE.FONTS.sans;
    FE.pushUndo();
    const cv = FE.mk(S.w, S.h), x = cv.getContext("2d"), sizePx = S.h * clamp(numOr(o.size_fraction, 0.08), 0.01, 0.6);
    FE.drawTextOp(x, { text: text.slice(0, 400), x: S.w * clamp(numOr(o.x, 0.5), 0, 1), y: S.h * clamp(numOr(o.y, 0.5), 0, 1), sizePx, family: fam, weight: clamp(numOr(o.weight, 700), 100, 900), color: okColor(o.color, "#ffffff"),
      align: ["left", "center", "right"].includes(o.align) ? o.align : "center", shadow: o.shadow !== false, stroke: o.stroke_color ? okColor(o.stroke_color, null) : null, maxWidthPx: S.w * clamp(numOr(o.max_width, 0.9), 0.1, 1) });
    FE.addLayer(FE.makeLayer("Text: " + text.slice(0, 24), cv));
    return `Added a text layer “${text.slice(0, 40)}”.`;
  }
  function validBlend(b) { return !b || (FE.BLENDS || []).some((x) => x[0] === b) ? b : fail("Unknown blend mode. Use one of: " + (FE.BLENDS || []).map((x) => x[0]).join(", ")); }
  function photoShape(o) {
    const cv = FE.mk(S.w, S.h), x = cv.getContext("2d"), rx = S.w * clamp(numOr(o.x, 0), 0, 1), ry = S.h * clamp(numOr(o.y, 0), 0, 1), rw = S.w * clamp(numOr(o.width, 1), 0.001, 1), rh = S.h * clamp(numOr(o.height, 1), 0.001, 1);
    FE.pushUndo();
    if (o.shape === "gradient") {
      const cols = (Array.isArray(o.colors) && o.colors.length >= 2 ? o.colors : [okColor(o.color, "#000"), "#ffffff"]).map((c) => okColor(c, "#000")), a = (numOr(o.angle, 90) * Math.PI) / 180;
      const cx = rx + rw / 2, cy = ry + rh / 2, L = Math.abs(rw * Math.cos(a)) / 2 + Math.abs(rh * Math.sin(a)) / 2, g = x.createLinearGradient(cx - Math.cos(a) * L, cy - Math.sin(a) * L, cx + Math.cos(a) * L, cy + Math.sin(a) * L);
      cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), c)); x.fillStyle = g; x.fillRect(rx, ry, rw, rh);
    } else if (o.shape === "ellipse") { x.fillStyle = okColor(o.color, "#ffffff"); x.beginPath(); x.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2); x.fill(); }
    else if (o.shape === "rect") { x.fillStyle = okColor(o.color, "#ffffff"); const r = clamp(numOr(o.radius, 0), 0, 0.5) * Math.min(rw, rh); x.beginPath(); x.roundRect ? x.roundRect(rx, ry, rw, rh, r) : x.rect(rx, ry, rw, rh); x.fill(); }
    else fail("shape must be rect, ellipse or gradient.");
    FE.addLayer(FE.makeLayer(String(o.name || o.shape).slice(0, 30), cv, { opacity: clamp(numOr(o.opacity, 1), 0, 1), blend: validBlend(o.blend) || "source-over" }));
    return `Drew a ${o.shape} on a new layer.`;
  }
  function photoLayers(o) {
    const act = o.action;
    if (act === "list") return JSON.stringify(photoState().layers);
    const l = layerById(o.id);
    if (act === "select") { S.active = l.id; refresh(); return `Selected layer ${l.id} (${l.name}).`; }
    FE.pushUndo();
    if (act === "set") {
      if (o.opacity !== undefined) l.opacity = clamp(numOr(o.opacity, 1), 0, 1);
      if (o.blend !== undefined) l.blend = validBlend(o.blend);
      if (o.visible !== undefined) l.visible = !!o.visible;
      if (o.name !== undefined) l.name = String(o.name).slice(0, 40);
      if (o.x !== undefined) l.x = Math.round(numOr(o.x, l.x)); if (o.y !== undefined) l.y = Math.round(numOr(o.y, l.y));
    } else if (act === "delete") { if (S.layers.length === 1) { FE.dropUndo(); fail("A picture needs at least one layer."); } S.layers = S.layers.filter((x) => x !== l); if (S.active === l.id) S.active = S.layers[S.layers.length - 1].id; }
    else if (act === "duplicate") { const c = FE.clone(l.canvas), n = FE.makeLayer(l.name + " copy", c, { x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible }); if (l.mask) n.mask = FE.clone(l.mask); S.layers.splice(S.layers.indexOf(l) + 1, 0, n); S.active = n.id; }
    else if (act === "move") { const to = clamp(Math.round(numOr(o.to, 0)), 0, S.layers.length - 1); S.layers.splice(S.layers.indexOf(l), 1); S.layers.splice(to, 0, l); }
    else { FE.dropUndo(); fail("action must be list, set, delete, duplicate, move or select."); }
    refresh(); return `Layer ${act} done.`;
  }
  function photoCanvas(o) {
    const act = o.action;
    if (act === "crop") { const x = clamp(numOr(o.x, 0), 0, 1) * S.w, y = clamp(numOr(o.y, 0), 0, 1) * S.h, w = clamp(numOr(o.width, 1), 0.01, 1) * S.w, h = clamp(numOr(o.height, 1), 0.01, 1) * S.h; FE.pushUndo(); if (!FE.cropDoc(x, y, w, h)) { FE.dropUndo(); fail("That crop is too small."); } return `Cropped to ${S.w} × ${S.h} px.`; }
    if (act === "rotate") { const d = Math.round(numOr(o.degrees, 90) / 90) * 90; if (!d) fail("degrees must be 90, 180 or 270."); FE.pushUndo(); FE.rotateDoc(d); return `Rotated ${d}°. Now ${S.w} × ${S.h} px.`; }
    if (act === "flip") { if (o.direction !== "h" && o.direction !== "v") fail("direction must be h or v."); FE.pushUndo(); FE.flipDoc(o.direction); return "Flipped."; }
    if (act === "new") { const w = Math.round(clamp(numOr(o.width, 1600), 16, 6000)), h = Math.round(clamp(numOr(o.height, 1067), 16, 6000)), c = FE.mk(w, h), x = c.getContext("2d"); x.fillStyle = okColor(o.color, "#ffffff"); x.fillRect(0, 0, w, h); FE.newDocument(w, h, c, "Background"); return `New ${w} × ${h} px picture.`; }
    fail("action must be crop, rotate, flip or new.");
  }
  function photoFilter(o) {
    if (!FE.agentFilter) fail("Filters aren't available.");
    const name = FE.agentFilter(String(o.name), o.params || {}); return `Applied ${name} to the active layer.`;
  }
  async function media(o) {
    const M = window.FEMarket; if (!M) fail("The Marketplace isn't loaded yet.");
    const q = String(o.query || "").slice(0, 120), r = (x) => (x && x.text) || "Done.";
    switch (o.action) {
      case "find_music": return r(await M.ai.findMusic({ text: q ? q + " music" : "", query: q || undefined }));
      case "compose_music": return r(await M.ai.composeMusic({ text: String(o.mood || q || "") }));
      case "remove_music": await ensureMode("video"); return window.FEVideo.removeMusic() ? "Removed the music." : "There was no music.";
      case "add_sound": return r(await M.ai.findSound({ text: String(o.name || q || "whoosh") }));
      case "find_photo": return r(await M.ai.findPhoto({ text: "find a photo of " + (q || "nature") }));
      case "add_credits": return r(await M.ai.addCredits());
      default: fail("action must be find_music, compose_music, remove_music, add_sound, find_photo or add_credits.");
    }
  }

  /* ---------- dispatcher ---------- */
  const PHOTO_ONLY = new Set(["fastedit_shape", "fastedit_layers", "fastedit_canvas", "fastedit_filter"]);
  const VIDEO_ONLY = new Set(["fastedit_make_video", "fastedit_timeline", "fastedit_export"]);
  async function call(name, a) {
    a = a && typeof a === "object" ? a : {};
    try {
      if (PHOTO_ONLY.has(name)) await ensureMode("photo"); else if (VIDEO_ONLY.has(name)) await ensureMode("video");
      let text;
      switch (name) {
        case "fastedit_make_video": text = await window.FEVideo.agent.make(a); break;
        case "fastedit_timeline": text = await window.FEVideo.agent.timeline(a.ops); break;
        case "fastedit_export": text = await window.FEVideo.agent.exportNow(); break;
        case "fastedit_text": text = mode() === "video" ? await window.FEVideo.agent.text(a) : await photoText(a); break;
        case "fastedit_adjust": text = mode() === "video" ? window.FEVideo.agent.adjust(a) : photoAdjust(a); break;
        case "fastedit_shape": text = photoShape(a); break;
        case "fastedit_layers": text = photoLayers(a); break;
        case "fastedit_canvas": text = photoCanvas(a); break;
        case "fastedit_filter": text = photoFilter(a); break;
        case "fastedit_media": text = await media(a); break;
        default: return { error: true, text: `Unknown tool ${name}.` };
      }
      await sleep(120);
      return { text: `${text}\n\n${describe()}`, image: shot(768) };
    } catch (e) { return { error: true, text: e && e.message ? e.message : "That didn't work." }; }
  }

  window.FEAgent = { call, shot, state, describe, mode, ensureMode };
})();
