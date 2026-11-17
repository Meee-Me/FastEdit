/*
 * Fast Edit <-> Claude. "Claude" button: shows a private connector link to add in
 * Claude (Settings > Connectors > Add custom connector). While it's on, this tab checks a
 * small relay (Supabase) for commands from Claude, runs them here and sends back a reply and
 * a screenshot. Your photos and videos stay in this browser; only the screenshot Claude asks for
 * (a small JPEG) is sent.
 */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const FE = window.FE;
  const SUPA = "https://tcrprxgwhfsdkfiatmpe.supabase.co", KEY = "sb_publishable_s2o1OqqvDAPJHv94xmJNRQ_HiZ9nNYO";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mode = () => (document.body.classList.contains("mode-video") ? "video" : "photo");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };

  let code = store.get("fastedit.claude.code");
  let on = store.get("fastedit.claude.on") === "1";
  let lastCall = null, lastErr = null, polling = false, timer = null, busy = false;
  const newCode = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  if (!code || code.length < 32) { code = newCode(); store.set("fastedit.claude.code", code); }
  const link = () => `${location.origin.startsWith("http") && !/localhost|127\.0\.0\.1/.test(location.hostname) ? location.origin : "https://fast-edit-nine.vercel.app"}/api/mcp?s=${code}`;

  async function rpc(fn, args) {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`relay ${r.status}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }

  /* ---------- what's on screen ---------- */
  function shot(max = 960) {
    let src = null;
    if (mode() === "video") src = $("#vCanvas");
    else src = $("#view"); // the finished picture, with adjustments applied
    if (!src || !src.width) return null;
    const k = Math.min(1, max / Math.max(src.width, src.height)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  }
  function describe() {
    if (mode() === "video") {
      const V = window.FEVideo && window.FEVideo.V; if (!V) return "Video mode.";
      const m = V.music && V.media.find((x) => x.id === V.music.mediaId);
      return `Video mode. ${V.clips.length} clip(s), ${window.FEVideo.total().toFixed(1)} s long, playhead at ${window.FEVideo.time.toFixed(1)} s. Music: ${m ? m.name : "none"}. Sound effects: ${V.sounds.length}. Text/effects/overlays: ${V.overlays.length}.`;
    }
    const S = FE.S; const names = S.layers.map((l) => l.name).slice(-8).join(", ");
    return `Photo mode. ${S.w} x ${S.h} px, ${S.layers.length} layer(s) (${names}).`;
  }
  const info = () => ({ mode: mode(), v: 1 });

  /* ---------- running commands ---------- */
  async function chatSend(text) {
    const m = mode(), api = window.FEChat.get(m); if (!api) throw new Error("The chat isn't ready.");
    const host = $(m === "video" ? "#videoChat" : "#photoChat"), sendBtn = host.querySelector(".chat-send");
    for (let i = 0; i < 100 && sendBtn.disabled; i++) await sleep(300);
    const before = host.querySelectorAll(".msg.ai").length;
    await api.send(text);
    const msgs = [...host.querySelectorAll(".msg.ai")], last = msgs.length > before ? msgs[msgs.length - 1] : null;
    const body = last && last.querySelector(".msg-body");
    const chips = body ? [...body.querySelectorAll(".msg-chips .chip")].map((c) => c.textContent) : [];
    return (body ? body.innerText.replace(/\n{2,}/g, "\n").trim() : "") + (chips.length ? `\n(Suggested follow-ups: ${chips.join(" | ")})` : "");
  }
  async function run(tool, args) {
    if (tool === "look") {
      if (mode() === "video" && Number.isFinite(args.at) && window.FEVideo.V.clips.length) { await window.FEVideo.seek(Math.max(0, Math.min(args.at, window.FEVideo.total() - 0.05))); await sleep(300); }
      return { text: describe(), image: shot() };
    }
    if (tool === "do") { const text = await chatSend(String(args.request || "")); return { text: `${text || "Done."}\n\n${describe()}`, image: shot() }; }
    if (tool === "undo") {
      const m = mode(), api = window.FEChat.get(m); const ok = api && api.cfg.undo();
      await sleep(200); return { text: (ok ? "Undid the last change. " : "Nothing to undo. ") + describe(), image: shot() };
    }
    if (tool === "mode") {
      if (args.mode !== mode()) { $(`[data-app-mode="${args.mode}"]`).click(); await sleep(500); }
      return { text: `Now in ${mode()} mode. ${describe()}`, image: shot() };
    }
    return { error: true, text: "That command isn't supported by this version of Fast Edit." };
  }
  async function tick() {
    if (!on || polling) return; polling = true;
    try {
      const cmds = (await rpc("fe_take", { p_session: code, p_info: info() })) || [];
      lastErr = null;
      for (const c of cmds) {
        busy = true; render();
        let res;
        try { res = await run(c.tool, c.args || {}); lastCall = { tool: c.tool, at: Date.now() }; }
        catch (e) { res = { error: true, text: `Fast Edit couldn't do that: ${e && e.message ? e.message : "unknown error"}` }; }
        try { await rpc("fe_done", { p_session: code, p_id: c.id, p_result: res }); } catch (e) { lastErr = "Couldn't send the result to Claude."; }
        busy = false;
      }
    } catch (e) { lastErr = "Can't reach the connection service."; }
    polling = false; render();
  }
  function start() { stop(); if (!on) return; tick(); timer = setInterval(tick, document.hidden ? 4000 : 1500); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  document.addEventListener("visibilitychange", () => { if (on) start(); });
  function setOn(v) { on = v; store.set("fastedit.claude.on", v ? "1" : "0"); if (v) start(); else stop(); render(); updateBtn(); }

  /* ---------- UI ---------- */
  document.body.insertAdjacentHTML("beforeend", `
    <div class="mkt" id="clm" hidden role="dialog" aria-modal="true" aria-labelledby="clmTitle">
      <div class="mkt-panel clm-panel">
        <div class="mkt-head"><h2 id="clmTitle">Connect Claude</h2><button class="btn sm ghost" id="clmClose" aria-label="Close" style="margin-left:auto">✕</button></div>
        <div class="mkt-body" id="clmBody"></div>
      </div>
    </div>`);
  const dlg = $("#clm");
  function render() {
    const b = $("#clmBody"); if (!b || dlg.hidden) return;
    const status = !on ? ["off", "Off"] : lastErr ? ["err", lastErr] : busy ? ["busy", "Claude is editing…"] : ["on", lastCall ? `Connected · Claude last used “${lastCall.tool}” ${Math.max(0, Math.round((Date.now() - lastCall.at) / 1000))}s ago` : "Connected · waiting for Claude"];
    b.innerHTML = `
      <p class="clm-lead">Let <b>Claude</b> see and edit your work in Fast Edit. Claude looks at your photo or video frame and tells Fast Edit AI what to do, like “make it warmer” or “cut it to 15 seconds”.</p>
      <div class="clm-row"><label class="check"><input type="checkbox" id="clmOn" ${on ? "checked" : ""}> Allow Claude to use this tab</label><span class="clm-status ${status[0]}">${esc(status[1])}</span></div>
      <div class="label">Your private connector link</div>
      <div class="clm-link"><input readonly id="clmLink" value="${esc(link())}" aria-label="Connector link"><button class="btn sm primary" id="clmCopy">Copy</button></div>
      <ol class="clm-steps">
        <li>Turn on <b>Allow Claude to use this tab</b> above.</li>
        <li>Tap <b>Copy</b>.</li>
        <li>In Claude, open <b>Settings → Connectors → Add custom connector</b>. Name it “Fast Edit”, paste the link, and add it.</li>
        <li>In a Claude chat, turn the connector on and ask, e.g. “Look at my photo in Fast Edit and make it look like a movie poster.”</li>
      </ol>
      <p class="hint">Keep this tab open while Claude works: it can only act while Fast Edit is open here. Your files stay in this browser. Claude only gets the small screenshots and replies it asks for.</p>
      <p class="hint"><b>Treat the link like a password.</b> Anyone who has it can edit this tab while it's connected.</p>
      <div class="btnrow"><button class="btn sm" id="clmNew">Make a new link</button><span class="hint">This disconnects Claude until you add the new link.</span></div>`;
    $("#clmOn").onchange = (e) => setOn(e.target.checked);
    $("#clmCopy").onclick = async () => { try { await navigator.clipboard.writeText(link()); FE.toast("Link copied"); } catch { const i = $("#clmLink"); i.focus(); i.select(); FE.toast("Select the link and copy it"); } };
    $("#clmLink").onfocus = (e) => e.target.select();
    $("#clmNew").onclick = () => { if (!confirm("Make a new link? The current one will stop working.")) return; code = newCode(); store.set("fastedit.claude.code", code); lastCall = null; render(); FE.toast("New link made. Add it in Claude."); };
  }
  function open() { dlg.hidden = false; render(); if (!on) $("#clmOn")?.focus(); }
  function close() { dlg.hidden = true; }
  $("#clmClose").onclick = close; dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dlg.hidden) close(); });
  setInterval(() => { if (!dlg.hidden) render(); }, 5000);

  const btn = document.createElement("button"); btn.className = "btn video-only"; btn.id = "clmOpen"; btn.onclick = open;
  $("#mktOpen") ? $("#mktOpen").before(btn) : $("#deluxeAccount").before(btn);
  const menu = $(".menubar"); let mb = null;
  if (menu) { mb = document.createElement("button"); mb.type = "button"; mb.className = "menu-btn clm-menu"; mb.onclick = open; menu.append(mb); }
  function updateBtn() { const t = on ? "Claude ●" : "Claude"; btn.textContent = t; if (mb) mb.textContent = t; btn.classList.toggle("clm-on", on); if (mb) mb.classList.toggle("clm-on", on); }
  updateBtn(); if (on) start();

  window.FEClaude = { open, close, get on() { return on; } };
})();
