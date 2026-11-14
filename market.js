/*
 * Fast Edit Marketplace: music, sound effects, photos, looks, effects, templates and fonts.
 * Everything is free to use. Creative Commons media comes from Openverse (Jamendo,
 * ccMixter, Freesound, Wikimedia, Flickr…), shown with its license, and Fast Edit keeps
 * the credits you owe. "Fast Edit originals" are composed on your device and are yours.
 */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const FE = window.FE, toast = (m) => FE.toast(m);
  const OV = "https://api.openverse.org/v1/", MEDIA = "/api/media";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mode = () => (document.body.classList.contains("mode-video") ? "video" : "photo");
  const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  /* ---------- licenses & credits ---------- */
  function licLabel(l, v) {
    l = String(l || "").toLowerCase();
    if (l === "cc0") return "CC0 (no credit needed)"; if (l === "pdm") return "Public domain";
    return `CC ${l.toUpperCase()}${v ? " " + v : ""}`;
  }
  const isNC = (l) => /nc/i.test(l || "");
  const needsCredit = (l) => !/^(cc0|pdm)$/i.test(l || "");
  let credits = [];
  try { credits = JSON.parse(localStorage.getItem("fastedit.credits.v1") || "[]"); } catch {}
  const saveCredits = () => { try { localStorage.setItem("fastedit.credits.v1", JSON.stringify(credits.slice(-50))); } catch {} renderCredits(); };
  function addCredit(item, kind) {
    if (!needsCredit(item.license) && !item.always) { renderCredits(); return; }
    if (credits.some((c) => c.id === item.id)) return;
    credits.push({ id: item.id, kind, title: item.title, creator: item.creator, license: licLabel(item.license, item.license_version), attribution: item.attribution || `“${item.title}” by ${item.creator}`, url: item.foreign_landing_url || "" });
    saveCredits();
  }
  function dropMusicCredits() { const n = credits.length; credits = credits.filter((c) => c.kind !== "music"); if (credits.length !== n) saveCredits(); }
  const creditsText = () => credits.map((c) => `${c.kind === "music" ? "Music" : c.kind === "sound" ? "Sound" : "Photo"}: “${c.title}” by ${c.creator || "unknown"} (${c.license})${c.url ? " " + c.url : ""}`).join("\n");
  function renderCredits() {
    for (const host of $$(".credits-host")) {
      host.innerHTML = credits.length
        ? `<div class="label">Credits you need to give (${credits.length})</div><ul class="credit-list">${credits.map((c) => `<li><b>${esc(c.title)}</b> by ${esc(c.creator || "unknown")} · ${esc(c.license)}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">source</a>` : ""}</li>`).join("")}</ul>
           <div class="btnrow"><button class="btn sm" data-cr="copy">Copy credits</button>${mode() === "video" ? '<button class="btn sm" data-cr="add">Add credits to the end of the video</button>' : ""}<button class="btn sm ghost" data-cr="clear">Clear list</button></div>
           <p class="hint">Creative Commons licenses (except CC0 and public domain) require these credits wherever you post the video or photo, for example in its description.</p>`
        : `<p class="hint">Media you use from the Marketplace is listed here with the credit its license asks for.</p>`;
      host.querySelectorAll("[data-cr]").forEach((b) => (b.onclick = () => {
        if (b.dataset.cr === "copy") { const t = creditsText(); navigator.clipboard?.writeText(t).then(() => toast("Credits copied"), () => toast("Couldn't copy. Select the list and copy it")); }
        else if (b.dataset.cr === "add") { window.FEVideo.addCreditsOverlay(credits.map((c) => `${c.kind === "music" ? "Music" : c.kind === "sound" ? "Sound" : "Photo"}: ${c.title} · ${c.creator} · ${c.license.replace(/ \(.+\)$/, "")}`).join("\n")); toast("Added the credits to the last 4 seconds"); }
        else { credits = []; saveCredits(); }
      }));
    }
  }

  /* ---------- Openverse ---------- */
  const searchCache = new Map();
  async function search(type, q, { kind, commercial = true, page = 1 } = {}) {
    const p = new URLSearchParams({ q: q || (kind === "sound_effect" ? "whoosh" : type === "images" ? "nature" : "upbeat"), page_size: "20", page: String(page), license: commercial ? "cc0,pdm,by,by-sa" : "cc0,pdm,by,by-sa,by-nc,by-nc-sa", mature: "false" });
    if (type === "audio") { if ((kind || "music") === "music") { p.set("category", "music"); p.set("source", "jamendo,ccmixter,wikimedia_audio"); } else { p.set("source", "freesound,wikimedia_audio"); p.set("length", "short"); } }
    const url = `${OV}${type}/?${p}`;
    if (searchCache.has(url)) return searchCache.get(url);
    let r;
    try { r = await fetch(url, { headers: { accept: "application/json" } }); }
    catch { throw new Error("Openverse is busy or unreachable right now. Wait a minute and try again."); }
    if (!r.ok) throw new Error(r.status === 429 ? "Openverse is busy. Wait a minute and try again." : `Openverse answered ${r.status}.`);
    const res = (await r.json()).results || [];
    searchCache.set(url, res); return res;
  }
  async function download(type, item) {
    let r;
    try { r = await fetch(`${MEDIA}?type=${type}&id=${encodeURIComponent(item.id)}`); }
    catch { throw new Error("Couldn't reach Fast Edit's download helper. Check your connection."); }
    if (!r.ok && type === "audio" && item.url) { // some hosts allow browsers but not servers
      try { const t = await fetch(item.url, { mode: "cors" }); if (t.ok) r = t; } catch {}
    }
    if (!r.ok && type === "images") { // Openverse's own preview copy works from the browser when the original host refuses
      try { const t = await fetch(`${OV}images/${item.id}/thumb/?full_size=true`); if (t.ok && /^image\//.test(t.headers.get("content-type") || "")) r = t; } catch {}
    }
    if (!r.ok) { let msg = `Download failed (${r.status}).`; try { msg = (await r.json()).error || msg; } catch {} throw new Error(msg); }
    const blob = await r.blob(), ext = (item.filetype || (type === "audio" ? "mp3" : "jpg")).replace(/^\./, "");
    return new File([blob], `${String(item.title || "media").replace(/[^\w\- ]+/g, "").slice(0, 60) || "media"}.${ext}`, { type: blob.type || (type === "audio" ? "audio/mpeg" : "image/jpeg") });
  }

  /* ---------- Fast Edit original sound effects (synthesized on your device) ---------- */
  const SFX = {
    whoosh: { name: "Whoosh", len: 0.9 }, impact: { name: "Impact boom", len: 1.6 }, riser: { name: "Riser", len: 2.5 }, pop: { name: "Pop", len: 0.25 },
    ding: { name: "Ding", len: 1.4 }, click: { name: "Click", len: 0.08 }, swipe: { name: "Swipe", len: 0.4 }, glitch: { name: "Glitch", len: 0.6 },
  };
  async function synthSfx(key) {
    const def = SFX[key], sr = 44100, oc = new OfflineAudioContext(2, Math.ceil(def.len * sr), sr), T = def.len, out = oc.createGain(); out.connect(oc.destination);
    const noise = () => { const b = oc.createBuffer(1, Math.ceil(T * sr), sr), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const n = oc.createBufferSource(); n.buffer = b; return n; };
    const env = (g, a, peak, rel) => { g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(peak, a); g.gain.exponentialRampToValueAtTime(0.0001, rel); };
    if (key === "whoosh" || key === "swipe" || key === "riser") {
      const n = noise(), f = oc.createBiquadFilter(), g = oc.createGain(); f.type = "bandpass"; f.Q.value = key === "riser" ? 4 : 1.2;
      f.frequency.setValueAtTime(key === "riser" ? 300 : 500, 0); f.frequency.exponentialRampToValueAtTime(key === "riser" ? 6000 : 3500, T * (key === "riser" ? 0.95 : 0.5)); if (key !== "riser") f.frequency.exponentialRampToValueAtTime(400, T);
      env(g, key === "riser" ? T * 0.95 : T * 0.45, key === "swipe" ? 0.8 : 1, T); n.connect(f); f.connect(g); g.connect(out); n.start();
      if (key === "riser") { const o = oc.createOscillator(), og = oc.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(110, 0); o.frequency.exponentialRampToValueAtTime(880, T); env(og, T * 0.95, 0.12, T); o.connect(og); og.connect(out); o.start(); }
    } else if (key === "impact") {
      const o = oc.createOscillator(), g = oc.createGain(); o.frequency.setValueAtTime(120, 0); o.frequency.exponentialRampToValueAtTime(32, 0.8); env(g, 0.005, 1, T); o.connect(g); g.connect(out); o.start();
      const n = noise(), f = oc.createBiquadFilter(), ng = oc.createGain(); f.type = "lowpass"; f.frequency.value = 900; env(ng, 0.003, 0.7, 0.5); n.connect(f); f.connect(ng); ng.connect(out); n.start();
    } else if (key === "pop" || key === "click") {
      const o = oc.createOscillator(), g = oc.createGain(); o.type = key === "click" ? "square" : "sine"; o.frequency.setValueAtTime(key === "click" ? 2200 : 900, 0); o.frequency.exponentialRampToValueAtTime(key === "click" ? 800 : 180, T); env(g, 0.003, key === "click" ? 0.5 : 0.9, T); o.connect(g); g.connect(out); o.start();
    } else if (key === "ding") {
      for (const [fr, v] of [[1318.5, 0.5], [2637, 0.18], [3955, 0.08]]) { const o = oc.createOscillator(), g = oc.createGain(); o.frequency.value = fr; env(g, 0.004, v, T); o.connect(g); g.connect(out); o.start(); }
    } else if (key === "glitch") {
      for (let i = 0; i < 9; i++) { const o = oc.createOscillator(), g = oc.createGain(), st = i * T / 9; o.type = "square"; o.frequency.value = 80 + Math.random() * 1600; g.gain.setValueAtTime(0, 0); g.gain.setValueAtTime(0.25, st); g.gain.setValueAtTime(0, st + T / 14); o.connect(g); g.connect(out); o.start(); }
    }
    const buf = await oc.startRendering();
    return new File([FastComposer.toWav(buf)], `${def.name} (Fast Edit original).wav`, { type: "audio/wav" });
  }
  async function useOriginalSfx(key) { toVideo(); const f = await synthSfx(key); await window.FEVideo.addSoundFile(f); return SFX[key].name; }
  const sfxKeyFor = (q) => { q = String(q || "").toLowerCase(); return Object.keys(SFX).find((k) => q.includes(k) || q.includes(SFX[k].name.toLowerCase())) || (/swoosh|swish|transition/.test(q) ? "whoosh" : /boom|hit|bass|drop/.test(q) ? "impact" : /bell|chime|notification/.test(q) ? "ding" : /bubble|pluck/.test(q) ? "pop" : /tap|tick|button|mouse/.test(q) ? "click" : /build ?up|rise|tension/.test(q) ? "riser" : /error|digital|static/.test(q) ? "glitch" : null); };

  /* ---------- "sounds like" a Spotify song (details only; Spotify audio never enters the video) ---------- */
  const SPOTIFY_RE = /(https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/[A-Za-z0-9]{22}[^\s]*|spotify:track:[A-Za-z0-9]{22})/;
  const STYLES = [
    [/reggaeton|latin|salsa|bachata|cumbia/, "latin reggaeton", "upbeat", "Latin"],
    [/hip ?hop|rap|trap|drill|grime/, "hip hop beat", "energetic", "Hip hop"],
    [/r&b|rnb|soul|funk/, "rnb soul groove", "chill", "R&B / soul"],
    [/house|techno|edm|electro(?!pop)|dance(?!-pop)|trance|dubstep|drum and bass/, "electronic dance", "energetic", "Electronic / dance"],
    [/synth-?pop|new wave|synthwave|80s/, "synthpop retro", "upbeat", "Synth-pop"],
    [/metal|punk|hard rock|grunge/, "rock energetic guitar", "energetic", "Rock"],
    [/rock|indie|alternative/, "indie rock", "energetic", "Indie / rock"],
    [/soundtrack|orchestral|classical|film|score|epic/, "cinematic orchestral", "cinematic", "Cinematic"],
    [/ambient|lo-?fi|chill|downtempo|new age/, "chill lofi ambient", "chill", "Chill / lo-fi"],
    [/folk|acoustic|country|singer-songwriter|bluegrass/, "acoustic folk guitar", "happy", "Acoustic / folk"],
    [/jazz|blues|swing|bossa/, "jazz", "chill", "Jazz"],
    [/dark|sad|ballad|emo/, "emotional piano", "dreamy", "Emotional"],
    [/pop|k-pop|j-pop|electropop/, "upbeat pop", "upbeat", "Pop"],
  ];
  function styleFor(info) {
    for (const g of (info.genres || []).map((x) => x.toLowerCase())) for (const [re, query, mood, label] of STYLES) if (re.test(g)) return { query, mood, label };
    return { query: "upbeat pop", mood: "upbeat", label: "Pop" };
  }
  let lastSpot = null;
  async function spotifyInfo(link) {
    let r;
    try { r = await fetch(`/api/spotify?url=${encodeURIComponent(link)}`); } catch { throw new Error("Couldn't reach Fast Edit's helper. Check your connection."); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Couldn't read that Spotify link (${r.status}).`);
    d.style = styleFor(d); lastSpot = d; return d;
  }
  const spotLine = (d) => `“${d.title}” by ${d.artist}${d.year ? ` (${d.year})` : ""}`;
  function spotHTML() {
    const d = lastSpot;
    return `<div class="spot-box"><div class="label">Sounds like a Spotify song</div>
      <form class="spot-form"><input type="url" placeholder="Paste a Spotify song link (open.spotify.com/track/…)" aria-label="Spotify song link" value="${d ? esc(d.link) : ""}"><button class="btn sm primary">Find similar free music</button></form>
      ${d ? `<div class="spot-out"><iframe src="${esc(d.embed)}?utm_source=generator&theme=0" title="Spotify player: ${esc(d.title)}" height="80" loading="lazy" allow="autoplay; clipboard-write; encrypted-media"></iframe>
        <div class="spot-meta"><b>${esc(spotLine(d))}</b><span class="by">Style: ${esc(d.style.label)}${d.genres.length ? " · " + esc(d.genres.slice(0, 3).join(", ")) : ""}</span>
        <span class="hint">Spotify songs play here for listening only; they can't go into your video. The songs below are free ones in a similar style.</span>
        <button class="btn sm spot-compose">Compose an original in this style</button></div></div>` : `<p class="hint">Fast Edit reads the song's artist and genre, then finds free music that feels similar. Spotify's own audio is never added to your video.</p>`}
    </div>`;
  }
  function wireSpot(b) {
    const f = b.querySelector(".spot-form"); if (!f) return;
    f.onsubmit = async (e) => {
      e.preventDefault(); const v = f.querySelector("input").value.trim(), btn = f.querySelector("button");
      if (!SPOTIFY_RE.test(v)) { toast("Paste a Spotify song link, like https://open.spotify.com/track/…"); return; }
      btn.disabled = true; btn.textContent = "Reading…";
      try { const d = await spotifyInfo(v.match(SPOTIFY_RE)[1]); $("#mktQ").value = d.style.query; load(d.style.query); }
      catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Find similar free music"; }
    };
    const c = b.querySelector(".spot-compose");
    if (c) c.onclick = () => busyCard(async () => { const r = await useOriginal(lastSpot.style.mood); toast(`Composed “${r.title}” in a ${lastSpot.style.label.toLowerCase()} style`); })(c);
  }

  /* ---------- using things ---------- */
  function toVideo() { if (mode() !== "video") document.querySelector('[data-app-mode="video"]').click(); }
  async function useMusic(item) {
    toVideo(); toast(`Downloading “${item.title}”…`);
    const file = await download("audio", item); const m = await window.FEVideo.addMusicFile(file); if (!m) throw new Error("That file couldn't be played.");
    dropMusicCredits(); addCredit(item, "music"); return m;
  }
  async function useSound(item) { toVideo(); toast(`Downloading “${item.title}”…`); const file = await download("audio", item); await window.FEVideo.addSoundFile(file); addCredit(item, "sound"); }
  async function usePhoto(item) {
    toast(`Downloading “${item.title}”…`); const file = await download("images", item);
    if (mode() === "video") await window.FEVideo.addFiles([file]); else await FE.loadImage(file, true);
    addCredit(item, "photo"); return file;
  }
  async function useOriginal(mood, seconds) {
    toVideo();
    const len = Math.max(15, Math.min(240, seconds || (window.FEVideo.total() || 30) + 1));
    toast("Composing…");
    const r = await FastComposer.composeFile({ mood, seconds: len });
    await window.FEVideo.addMusicFile(r.file); dropMusicCredits();
    return r;
  }

  /* ---------- catalog of built-in items ---------- */
  const LOOKS = {
    ...FE.PRESETS,
    "Teal & orange": { contrast: 18, saturation: -8, temperature: 6, fade: 8, vignette: 28, hue: -4 },
    "Golden hour": { temperature: 32, tint: 6, vibrance: 18, highlights: -10, exposure: 6, vignette: 18 },
    "Moody blue": { temperature: -26, contrast: 20, saturation: -20, exposure: -10, vignette: 40, shadows: -8 },
    "Vivid": { vibrance: 40, saturation: 14, contrast: 16, sharpen: 25 },
    "Pastel": { fade: 30, saturation: -12, exposure: 10, contrast: -14, temperature: 6, tint: 8 },
    "Matte B&W": { mono: 100, fade: 28, contrast: 10, grain: 22 },
    "Night city": { temperature: -18, tint: 10, contrast: 22, vibrance: 26, highlights: -16, vignette: 30 },
    "Summer": { exposure: 10, temperature: 18, vibrance: 30, shadows: 14, highlights: -12 },
  };
  const EFFECTS = [["Falling snow", "add falling snow"], ["Rain", "add rain"], ["Confetti", "add confetti"], ["Sparkles", "add sparkles around the light"], ["Bokeh lights", "add bokeh lights"], ["Floating hearts", "add floating hearts"], ["Light leak", "add a light leak"], ["Lens flare", "add a lens flare"], ["Stars & moon", "add stars and a crescent moon"], ["Birds", "add a flock of birds"], ["Low fog", "add low fog"], ["Retro sun", "add a retro synthwave sun"], ["Film frame", "add a film frame"], ["Hand-drawn frame", "add a hand-drawn frame"]];
  const TEMPLATES = {
    video: [["Travel vlog", "Your clips, edited with a title, warm color and music", ["edit it for me about my trip", "make it warmer", "find upbeat music"]],
      ["TikTok / Reels", "Vertical, best 15 seconds, punchy", ["make it 15 seconds with the best parts", "vertical for TikTok", "more contrast"]],
      ["Cinematic", "Movie grade, fades and an epic score", ["cinematic", "fade in and fade out", "compose cinematic music"]],
      ["Birthday", "Confetti, hearts and happy music", ["add confetti", "compose happy music", "fade in and fade out"]],
      ["Podcast clip", "Silences out, clearer voices, even volume", ["remove the silent parts", "make voices clearer", "even out the volume"]],
      ["Promo", "Animated title cards about your brand", ["make a video about Fast Edit"]]],
    photo: [["YouTube thumbnail", "Bold 1280×720 thumbnail", ["make a thumbnail"]], ["Instagram post", "4:5, vivid", ["crop to 4:5", "more vivid"]], ["Story", "9:16 vertical", ["crop to 9:16"]], ["Portrait", "Blurred background, warm", ["blur the background", "a bit warmer"]], ["Poster", "Big title, light leak, frame", ["make a poster about Summer Sale"]], ["Vintage print", "Faded film with a border", ["vintage", "add a white border"]]],
  };
  const FONTS = ["Bebas Neue", "Anton", "Oswald", "Montserrat", "Poppins", "Pacifico", "Lobster", "Permanent Marker", "Righteous", "Abril Fatface", "Dancing Script", "Archivo Black"];
  async function useFont(name) {
    const key = "gf_" + name.toLowerCase().replace(/\W+/g, "_");
    if (!FE.FONTS[key]) {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400;700&display=swap`; document.head.append(link);
      await new Promise((r) => { link.onload = r; link.onerror = r; setTimeout(r, 4000); });
      try { await document.fonts.load(`700 40px "${name}"`); } catch {}
      FE.FONTS[key] = `"${name}", system-ui, sans-serif`;
      for (const sel of [$("#optFont"), $("#vTextStyle")]) if (sel && ![...sel.options].some((o) => o.value === (sel.id === "vTextStyle" ? "font:" + key : key))) sel.add(new Option(name, sel.id === "vTextStyle" ? "font:" + key : key));
    }
    $("#optFont").value = key; if ($("#vTextStyle")) $("#vTextStyle").value = "font:" + key;
    return key;
  }

  /* ---------- UI ---------- */
  const TABS = [["music", "Music"], ["sfx", "Sound effects"], ["photos", "Photos"], ["looks", "Looks"], ["effects", "Effects"], ["templates", "Templates"], ["fonts", "Fonts"], ["credits", "Credits"]];
  const QUICK = { music: ["upbeat", "chill", "cinematic", "happy", "epic", "piano", "acoustic", "electronic", "lofi", "sad"], sfx: ["whoosh", "applause", "click", "pop", "laugh", "rain", "birds", "camera", "explosion", "ding"], photos: ["nature", "city", "sky", "mountains", "beach", "food", "people", "abstract", "space", "flowers"] };
  document.body.insertAdjacentHTML("beforeend", `
    <div class="mkt" id="mkt" hidden role="dialog" aria-modal="true" aria-labelledby="mktTitle">
      <div class="mkt-panel">
        <div class="mkt-head"><h2 id="mktTitle">Marketplace</h2><form class="mkt-search" id="mktSearch"><input type="search" id="mktQ" placeholder="Search music, sounds or photos" aria-label="Search the Marketplace"><button class="btn sm primary">Search</button></form><label class="check" id="mktComWrap"><input type="checkbox" id="mktCom" checked> Commercial use OK</label><button class="btn sm ghost" id="mktClose" aria-label="Close Marketplace">✕</button></div>
        <div class="mkt-tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" data-mt="${k}">${n}</button>`).join("")}</div>
        <div class="mkt-quick" id="mktQuick"></div>
        <div class="mkt-body" id="mktBody"></div>
        <div class="mkt-foot">Everything here is free. Creative Commons media comes from <a href="https://openverse.org" target="_blank" rel="noopener">Openverse</a> with the license shown; Fast Edit originals are composed on your device and are yours.</div>
      </div>
    </div>`);
  const audio = new Audio(); let playingBtn = null;
  function preview(btn, url) {
    if (playingBtn === btn && !audio.paused) { audio.pause(); btn.textContent = "▶"; playingBtn = null; return; }
    if (playingBtn) playingBtn.textContent = "▶";
    audio.src = url; audio.play().then(() => { btn.textContent = "❚❚"; playingBtn = btn; }, () => toast("This preview can't play here"));
  }
  audio.onended = () => { if (playingBtn) playingBtn.textContent = "▶"; playingBtn = null; };
  let tab = "music";
  function open(t) { $("#mkt").hidden = false; setTab(t || tab); $("#mktQ").focus(); }
  function close() { $("#mkt").hidden = true; audio.pause(); if (playingBtn) playingBtn.textContent = "▶"; playingBtn = null; }
  $("#mktClose").onclick = close; $("#mkt").addEventListener("click", (e) => { if (e.target.id === "mkt") close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#mkt").hidden) close(); });
  $$("[data-mt]").forEach((b) => (b.onclick = () => setTab(b.dataset.mt)));
  $("#mktSearch").onsubmit = (e) => { e.preventDefault(); if (!["music", "sfx", "photos"].includes(tab)) setTab("music"); else load($("#mktQ").value.trim()); };
  $("#mktCom").onchange = () => { if (["music", "sfx", "photos"].includes(tab)) load($("#mktQ").value.trim()); };
  function setTab(t) {
    tab = t; $$("[data-mt]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mt === t)));
    const searchable = ["music", "sfx", "photos"].includes(t);
    $("#mktSearch").hidden = !searchable; $("#mktComWrap").hidden = !searchable;
    $("#mktQuick").innerHTML = (QUICK[t] || []).map((q) => `<button class="chip" data-q="${q}">${q}</button>`).join("");
    $$("[data-q]").forEach((b) => (b.onclick = () => { $("#mktQ").value = b.dataset.q; load(b.dataset.q); }));
    $("#mktQ").placeholder = t === "photos" ? "Search free photos" : t === "sfx" ? "Search sound effects" : "Search free music";
    if (searchable) load($("#mktQ").value.trim()); else renderStatic(t);
  }
  const body = () => $("#mktBody");
  function busyCard(fn) { return async (btn) => { const was = btn.textContent; btn.disabled = true; btn.textContent = "…"; try { await fn(); btn.textContent = "Added ✓"; } catch (e) { btn.textContent = was; btn.disabled = false; toast(e.message || "That didn't work"); } }; }
  let loadSeq = 0;
  async function load(q) {
    const t = tab, b = body(), my = ++loadSeq;
    b.innerHTML = `${t === "music" ? spotHTML() + originalsHTML() : t === "sfx" ? sfxOriginalsHTML() : ""}<div class="mkt-status">Searching Openverse…</div>`;
    if (t === "music") { wireSpot(b); wireOriginals(); } if (t === "sfx") wireSfxOriginals();
    try {
      const type = t === "photos" ? "images" : "audio", res = await search(type, q, { kind: t === "sfx" ? "sound_effect" : "music", commercial: $("#mktCom").checked });
      if (tab !== t || my !== loadSeq) return;
      const status = b.querySelector(".mkt-status"); if (!status) return;
      if (!res.length) { status.textContent = "Nothing found. Try another word."; return; }
      status.outerHTML = `<div class="label">${t === "photos" ? "Free photos" : t === "sfx" ? "Free sound effects" : "Creative Commons music"} · ${esc(q || (t === "photos" ? "nature" : t === "sfx" ? "whoosh" : "upbeat"))}</div><div class="mkt-grid ${type}"></div>`;
      const grid = b.querySelector(".mkt-grid");
      for (const it of res) {
        const card = document.createElement("div"); card.className = "mkt-card";
        const lic = `<span class="lic${isNC(it.license) ? " nc" : ""}" title="${esc(it.attribution || "")}">${esc(licLabel(it.license, it.license_version))}${isNC(it.license) ? " · non-commercial" : ""}</span>`;
        if (type === "images") card.innerHTML = `<img src="${esc(it.thumbnail || it.url)}" alt="${esc(it.title)}" loading="lazy"><b>${esc(it.title || "Untitled")}</b><span class="by">${esc(it.creator || "")} · ${esc(it.source || "")}</span>${lic}<button class="btn sm primary use">Use</button>`;
        else card.innerHTML = `<div class="arow"><button class="btn sm play" aria-label="Preview">▶</button><div class="ameta"><b>${esc(it.title || "Untitled")}</b><span class="by">${esc(it.creator || "")} · ${esc(it.source || "")} · ${fmtDur(it.duration)}</span></div></div>${lic}<button class="btn sm primary use">${t === "sfx" ? "Add at playhead" : "Use as music"}</button>`;
        const play = card.querySelector(".play"); if (play) play.onclick = () => preview(play, it.url);
        const use = card.querySelector(".use"); use.onclick = () => busyCard(() => (t === "photos" ? usePhoto(it) : t === "sfx" ? useSound(it) : useMusic(it)))(use);
        grid.append(card);
      }
    } catch (e) { if (my !== loadSeq) return; const st = b.querySelector(".mkt-status"); if (st) st.textContent = (e.message || "Couldn't search.") + " Fast Edit originals still work offline."; }
  }
  function sfxOriginalsHTML() {
    return `<div class="label">Fast Edit originals · made on your device, yours to use anywhere</div><div class="mkt-grid looks">${Object.entries(SFX).map(([k, d]) => `<div class="mkt-card sfxo" data-sfx="${k}"><div class="arow"><button class="btn sm play" aria-label="Preview ${esc(d.name)}">▶</button><div class="ameta"><b>${esc(d.name)}</b><span class="by">${d.len} s</span></div></div><button class="btn sm primary use">Add at playhead</button></div>`).join("")}</div>`;
  }
  function wireSfxOriginals() {
    $$(".mkt-card.sfxo").forEach((card) => {
      const k = card.dataset.sfx, play = card.querySelector(".play");
      play.onclick = async () => { const f = await synthSfx(k); preview(play, URL.createObjectURL(f)); };
      const use = card.querySelector(".use"); use.onclick = () => busyCard(() => useOriginalSfx(k))(use);
    });
  }
  function originalsHTML() {
    return `<div class="label">Fast Edit originals · composed on your device, yours to use anywhere</div><div class="mkt-grid audio">${Object.entries(FastComposer.MOODS).map(([k, M]) => `<div class="mkt-card orig" data-mood="${k}"><div class="arow"><button class="btn sm play" aria-label="Preview ${esc(M.name)}">▶</button><div class="ameta"><b>${esc(M.name)}</b><span class="by">${M.bpm} BPM · made to fit your video's length</span></div></div><span class="lic own">Yours · no credit needed</span><button class="btn sm primary use">Compose &amp; use</button></div>`).join("")}</div>`;
  }
  function wireOriginals() {
    $$(".mkt-card.orig").forEach((card) => {
      const mood = card.dataset.mood, play = card.querySelector(".play");
      play.onclick = async () => { if (playingBtn === play && !audio.paused) return preview(play); play.textContent = "…"; const r = await FastComposer.composeFile({ mood, seconds: 12 }); play.textContent = "▶"; preview(play, URL.createObjectURL(r.file)); };
      const use = card.querySelector(".use"); use.onclick = () => busyCard(async () => { const r = await useOriginal(mood); toast(`Composed “${r.title}” and added it as music`); })(use);
    });
  }
  function renderStatic(t) {
    const b = body();
    if (t === "looks") {
      b.innerHTML = `<div class="label">Looks · one tap to apply to your ${mode()}</div><div class="mkt-grid looks">${Object.entries(LOOKS).map(([n, a]) => `<button class="mkt-look" data-look="${esc(n)}"><span class="sw" style="background:${swatch(a)}"></span><b>${esc(n)}</b></button>`).join("")}</div>`;
      $$("[data-look]", b).forEach((x) => (x.onclick = () => { const a = { ...FE.DEF, ...LOOKS[x.dataset.look] }; if (mode() === "video") window.FEVideo.applyLook(a); else FE.applyLook(a); toast(`${x.dataset.look} applied`); }));
    } else if (t === "effects") {
      b.innerHTML = `<div class="label">Effects · added by Fast Edit AI to your ${mode()}</div><div class="mkt-grid looks">${EFFECTS.map(([n, c]) => `<button class="mkt-look" data-cmd="${esc(c)}"><b>${esc(n)}</b></button>`).join("")}</div>`;
      $$("[data-cmd]", b).forEach((x) => (x.onclick = () => runCommands([x.dataset.cmd])));
    } else if (t === "templates") {
      const list = TEMPLATES[mode()];
      b.innerHTML = `<div class="label">Templates for ${mode() === "video" ? "videos" : "photos"} · Fast Edit AI does each step</div><div class="mkt-grid tpl">${list.map(([n, d, cmds], i) => `<div class="mkt-card"><b>${esc(n)}</b><span class="by">${esc(d)}</span><span class="steps">${cmds.map(esc).join(" → ")}</span><button class="btn sm primary" data-tpl="${i}">Use template</button></div>`).join("")}</div>`;
      $$("[data-tpl]", b).forEach((x) => (x.onclick = () => runCommands(list[+x.dataset.tpl][2])));
    } else if (t === "fonts") {
      b.innerHTML = `<div class="label">Fonts · free from Google Fonts (open licenses)</div><div class="mkt-grid looks">${FONTS.map((f) => `<button class="mkt-look font" data-font="${esc(f)}"><b>${esc(f)}</b><span class="by">Aa Bb 123</span></button>`).join("")}</div>`;
      $$("[data-font]", b).forEach((x) => { const f = x.dataset.font; const l = document.createElement("link"); l.rel = "stylesheet"; l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, "+")}&text=${encodeURIComponent(f + "AaBb123")}&display=swap`; document.head.append(l); x.querySelector("b").style.fontFamily = `"${f}", sans-serif`; x.querySelector(".by").style.fontFamily = `"${f}", sans-serif`;
        x.onclick = async () => { await useFont(f); toast(`${f} added. Pick it in the Text tool${mode() === "video" ? " or Edit › Text" : ""}`); }; });
    } else if (t === "credits") { b.innerHTML = `<div class="credits-host"></div>`; renderCredits(); }
  }
  function swatch(a) { const warm = (a.temperature || 0) / 100, mono = (a.mono || 0) / 100, sat = 1 + ((a.saturation || 0) + (a.vibrance || 0)) / 150; const h1 = warm > 0 ? 30 : 210, l = 45 + (a.exposure || 0) / 4 + (a.fade || 0) / 5; return mono ? `linear-gradient(135deg,hsl(0,0%,${l + 25}%),hsl(0,0%,${l - 20}%))` : `linear-gradient(135deg,hsl(${h1},${Math.round(60 * sat * (1 - mono))}%,${l + 15}%),hsl(${(h1 + 160) % 360},${Math.round(50 * sat)}%,${l - 15}%))`; }
  async function runCommands(cmds) {
    close();
    const m = mode(); document.querySelector(m === "video" ? '#vTabs [data-vtab="ai"]' : "#t-ai").click();
    const chat = window.FEChat.get(m); for (const c of cmds) await chat.send(c);
  }

  /* ---------- top-bar button + credits in the Export tab ---------- */
  const btn = document.createElement("button"); btn.className = "btn"; btn.id = "mktOpen"; btn.innerHTML = "Marketplace"; btn.onclick = () => open();
  btn.classList.add("video-only"); $("#deluxeAccount").before(btn);
  const menu = $(".menubar"); // photo mode: a menu-bar item, so the crowded top bar doesn't wrap
  if (menu) { const mb = document.createElement("button"); mb.type = "button"; mb.className = "menu-btn mkt-menu"; mb.textContent = "Marketplace"; mb.onclick = () => open(); menu.append(mb); }
  const exp = $("#vpane-export"); if (exp) { const h = document.createElement("div"); h.className = "credits-host"; exp.append(h); }
  renderCredits();

  /* ---------- Fast Edit AI ---------- */
  const MOOD_Q = { upbeat: "upbeat pop", chill: "chill lofi", cinematic: "cinematic", energetic: "energetic electronic", happy: "happy acoustic", dreamy: "ambient dreamy" };
  const MOOD_WORDS = /\b(upbeat|chill|lo-?fi|cinematic|epic|happy|sad|romantic|energetic|dreamy|ambient|calm|relaxing|piano|acoustic|rock|jazz|electronic|hip ?hop|dramatic|inspiring|corporate|funky|summer|travel|emotional|dance|orchestral|guitar)\b/gi;
  let triedMusic = new Set(), lastMusicQuery = null, lastStyleMood = null;
  const ai = {
    async findMusic({ text = "", again, query, mood: moodIn, intro = "" } = {}) {
      toVideo();
      const words = query ? [] : (text.match(MOOD_WORDS) || []).map((w) => w.toLowerCase());
      const mood = moodIn || (again && lastStyleMood) || FastComposer.moodFor(window.FEVideo.frameAnalysis());
      if (!again) lastStyleMood = moodIn || null;
      let q = query || (words.length ? words.join(" ") : again && lastMusicQuery ? lastMusicQuery : MOOD_Q[mood]);
      lastMusicQuery = q; if (!again) triedMusic = new Set();
      const need = (window.FEVideo.total() || 20) * 1000;
      let results;
      try { results = (await search("audio", q, { kind: "music", commercial: true })).filter((r) => !triedMusic.has(r.id)); }
      catch (e) { const r = await useOriginal(words[0] && FastComposer.MOODS[words[0]] ? words[0] : mood); return { text: `${intro}I couldn't reach the music library (${e.message}), so I composed an original ${r.moodName.toLowerCase()} track instead, “${r.title}”. It's yours to use anywhere, no credit needed.`, chips: ["Compose another", "Try finding a song again"] }; }
      results.sort((a, b) => Math.abs((a.duration || 0) - need * 1.2) - Math.abs((b.duration || 0) - need * 1.2));
      let lastErr = null;
      for (const it of results.slice(0, 4)) {
        triedMusic.add(it.id);
        try {
          await useMusic(it);
          const credit = needsCredit(it.license) ? ` Its license asks you to credit the artist when you post the video; I saved the credit under **Marketplace › Credits**.` : " It's public domain/CC0, so no credit is needed.";
          return { text: `${intro}I searched for “${q}” music and added **“${it.title}”** by ${it.creator} (${licLabel(it.license, it.license_version)}, from ${it.source}, ${fmtDur(it.duration)}). It fades out at the end and dips whenever someone talks.${credit}`,
            actions: [{ label: "Browse more music", run: () => open("music") }], chips: ["Find a different song", "Compose original music instead", "Add credits to the end"] };
        } catch (e) { lastErr = e; }
      }
      const r = await useOriginal(mood);
      return { text: `${intro}${results.length ? `The songs I found couldn't be downloaded (${lastErr ? lastErr.message : "no matches"}).` : `I found no “${q}” songs.`} So I composed an original ${r.moodName.toLowerCase()} track instead, “${r.title}”, yours to use anywhere.`, chips: ["Find a different song", "Compose another"] };
    },
    async spotifyLike({ text = "" } = {}) {
      const link = (text.match(SPOTIFY_RE) || [])[1];
      if (!link) return { text: "Paste a Spotify song link (open.spotify.com/track/…) and I'll find free music that sounds similar." };
      let d; try { d = await spotifyInfo(link); } catch (e) { return { text: e.message } }
      const intro = `That's ${spotLine(d)}, ${d.style.label.toLowerCase()}${d.genres.length ? ` (${d.genres.slice(0, 3).join(", ")})` : ""}. Spotify songs can only be played in Spotify, not put into videos, so here's free music in a similar style.\n\n`;
      const r = await ai.findMusic({ query: d.style.query, mood: d.style.mood, intro });
      return { ...r, embed: d.embed, chips: ["Find a different one", "Compose one in this style", "Add credits to the end"] };
    },
    async composeMusic({ text = "" } = {}) {
      const w = (text.match(MOOD_WORDS) || []).map((x) => x.toLowerCase().replace("lo-fi", "chill").replace("lofi", "chill"));
      const map = { epic: "cinematic", dramatic: "cinematic", orchestral: "cinematic", sad: "cinematic", emotional: "cinematic", calm: "dreamy", relaxing: "chill", ambient: "dreamy", acoustic: "happy", guitar: "happy", summer: "upbeat", travel: "upbeat", dance: "energetic", electronic: "energetic", rock: "energetic", funky: "upbeat", piano: "dreamy" };
      let mood = w.map((x) => (FastComposer.MOODS[x] ? x : map[x])).find(Boolean) || (lastStyleMood && /\b(this|that|same|similar) (style|vibe|feel)|\blike (it|that|this)\b/i.test(text) ? lastStyleMood : null) || FastComposer.moodFor(window.FEVideo && window.FEVideo.frameAnalysis());
      const r = await useOriginal(mood);
      return { text: `I composed an original **${r.moodName.toLowerCase()}** track, “${r.title}” (${r.bpm} BPM, ${Math.round(r.seconds)} s) to fit your video, and added it as the music. It's yours to use anywhere, no credit needed.`, chips: ["Compose another", "Find a song instead", "Make it calmer"] };
    },
    async findPhoto({ text = "" } = {}) {
      const m = text.match(/\b(?:photo|picture|image|pic)s?\s+(?:of|with|showing)\s+(.+)$/i) || text.match(/\b(?:find|get|add|search for|download)\s+(?:a |an |some )?(.+?)\s+(?:photo|picture|image|pic)s?\b/i);
      const q = (m ? m[1] : text.replace(/\b(find|get|add|search|download|a|an|some|photo|picture|image|pic|of|for|me|please)\b/gi, "")).replace(/[.!?"]+/g, "").trim() || "nature";
      let res; try { res = await search("images", q, { commercial: true }); } catch (e) { return { text: `I couldn't reach the photo library: ${e.message}` }; }
      for (const it of res.slice(0, 4)) {
        try { await usePhoto(it); return { text: `I found a free photo of ${q}, **“${it.title || "Untitled"}”** by ${it.creator || "unknown"} (${licLabel(it.license, it.license_version)}), and ${mode() === "video" ? "added it to the end of the timeline" : "placed it as a new layer"}.${needsCredit(it.license) ? " Its credit is saved under **Marketplace › Credits**." : ""}`, image: it.thumbnail, actions: [{ label: "Browse more photos", run: () => { $("#mktQ").value = q; open("photos"); } }] }; } catch {}
      }
      return { text: res.length ? "I found photos, but none of them could be downloaded right now. Try another subject." : `I found no free photos of “${q}”.` };
    },
    async findSound({ text = "" } = {}) {
      const q = text.replace(/\b(find|get|add|search|download|a|an|some|the|sound effects?|sfx|sounds?|of|for|me|please|at the playhead)\b/gi, "").replace(/[.!?"]+/g, "").trim() || "whoosh";
      const key = sfxKeyFor(q);
      if (key) { const n = await useOriginalSfx(key); return { text: `I made a **${n.toLowerCase()}** sound on your device and added it at ${fmtDur(window.FEVideo.time * 1000)}. It's a Fast Edit original, so no credit is needed. Click it on the timeline to remove it.`, chips: ["Add a ding sound", "Add an impact boom", "Find more sound effects"] }; }
      let res = []; try { res = await search("audio", q, { kind: "sound_effect", commercial: true }); } catch {}
      for (const it of res.slice(0, 3)) { try { await useSound(it); return { text: `I added the sound “${it.title}” by ${it.creator} (${licLabel(it.license, it.license_version)}) at the playhead. Click it on the timeline to remove it.` }; } catch {} }
      return { text: res.length ? `I found “${q}” sounds, but their site wouldn't allow the download. You can preview them, or use one of Fast Edit's own sound effects, in **Marketplace › Sound effects**.` : `I couldn't find a “${q}” sound. Fast Edit's own sound effects are in **Marketplace › Sound effects**.`, actions: [{ label: "Open sound effects", run: () => { $("#mktQ").value = q; open("sfx"); } }], chips: ["Add a whoosh sound", "Add a pop sound"] };
    },
    async openMarket({ text = "" } = {}) {
      const t = /music|song/i.test(text) ? "music" : /sound/i.test(text) ? "sfx" : /photo|image|picture/i.test(text) ? "photos" : /look|filter|preset/i.test(text) ? "looks" : /effect/i.test(text) ? "effects" : /template/i.test(text) ? "templates" : /font/i.test(text) ? "fonts" : "music";
      open(t); return { text: "I opened the Marketplace for you. Everything there is free: Fast Edit originals, Creative Commons music, sounds and photos (with credits tracked for you), looks, effects, templates and fonts." };
    },
    async addCredits() { if (!credits.length) return { text: "There's nothing to credit yet: you haven't used any Creative Commons media that needs it." }; toVideo(); window.FEVideo.addCreditsOverlay(credits.map((c) => `${c.kind === "music" ? "Music" : c.kind === "sound" ? "Sound" : "Photo"}: ${c.title} · ${c.creator} · ${c.license.replace(/ \(.+\)$/, "")}`).join("\n")); return { text: `I added the credits for ${credits.length} item${credits.length > 1 ? "s" : ""} to the last 4 seconds of the video.` }; },
  };

  window.FEMarket = { open, close, search, download, ai, credits: () => credits.slice(), useFont };
})();
