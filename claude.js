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
  let seen = store.get("fastedit.claude.seen") === code;
  let apiKey = store.get("fastedit.claude.key") || "";
  let useKey = store.get("fastedit.claude.usekey") === "1" && !!apiKey;
  const chatActive = () => useKey && !!apiKey;
  const BRAND_MCP = { name: "Claude", status: "Connected · editing with you", foot: "Claude is connected. Typing here uses Fast Edit's built-in helper; Claude edits from its own chat.", placeholder: "Ask Claude in claude.ai, or type an edit here…",
    welcome: "Claude is connected. Ask Claude (in claude.ai) to edit your work, and I'll show what it does here. You can also type an edit here." };
  const BRAND_KEY = { name: "Claude", status: "Claude · using your API key", foot: "Claude answers here. Your messages and a small screenshot of your work go to Anthropic, using your own API key.", placeholder: "Ask Claude…",
    welcome: "Ask Claude anything about your work, or tell Claude what to change. Claude can see it and edit it with you: ask for ideas, an honest opinion, or a finished edit. What should we do?" };
  function brand() {
    const b = chatActive() ? BRAND_KEY : on ? BRAND_MCP : null;
    document.body.classList.toggle("claude-on", !!b);
    for (const m of ["photo", "video"]) { const c = window.FEChat && window.FEChat.get(m); if (c && c.setBrand) c.setBrand(b); }
  }
  const chatOf = () => window.FEChat.get(mode());
  let keyErr = ""; const hist = { photo: [], video: [] };
  const noteAll = (t) => { for (const m of ["photo", "video"]) { const c = window.FEChat.get(m); if (c) c.note(t); } };
  for (const [id, m] of [["#photoChat", "photo"], ["#videoChat", "video"]]) { const h = $(id); if (h) h.addEventListener("chat-reset", () => { hist[m] = []; }); }
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
  async function chatSend(text, from) {
    const m = mode(), api = window.FEChat.get(m); if (!api) throw new Error("The chat isn't ready.");
    const host = $(m === "video" ? "#videoChat" : "#photoChat"), sendBtn = host.querySelector(".chat-send");
    for (let i = 0; i < 100 && sendBtn.disabled; i++) await sleep(300);
    const before = host.querySelectorAll(".msg.ai").length;
    await api.send(text, { from });
    const msgs = [...host.querySelectorAll(".msg.ai")], last = msgs.length > before ? msgs[msgs.length - 1] : null;
    const body = last && last.querySelector(".msg-body");
    const chips = body ? [...body.querySelectorAll(".msg-chips .chip")].map((c) => c.textContent) : [];
    return (body ? body.innerText.replace(/\n{2,}/g, "\n").trim() : "") + (chips.length ? `\n(Suggested follow-ups: ${chips.join(" | ")})` : "");
  }
  async function run(tool, args) {
    if (tool === "look") {
      chatOf().note("Claude looked at your " + (mode() === "video" ? "video" : "photo"));
      if (mode() === "video" && Number.isFinite(args.at) && window.FEVideo.V.clips.length) { await window.FEVideo.seek(Math.max(0, Math.min(args.at, window.FEVideo.total() - 0.05))); await sleep(300); }
      return { text: describe(), image: shot() };
    }
    if (tool === "do") { const text = await chatSend(String(args.request || ""), "Claude"); return { text: `${text || "Done."}\n\n${describe()}`, image: shot() }; }
    if (tool === "undo") {
      const m = mode(), api = window.FEChat.get(m); const ok = api && api.cfg.undo(); api.note(ok ? "Claude undid the last change" : "Claude tried to undo, but there was nothing to undo");
      await sleep(200); return { text: (ok ? "Undid the last change. " : "Nothing to undo. ") + describe(), image: shot() };
    }
    if (tool === "mode") {
      if (args.mode !== mode()) { $(`[data-app-mode="${args.mode}"]`).click(); await sleep(500); chatOf().note("Claude switched to " + args.mode + " mode"); }
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
        if (!seen) { seen = true; store.set("fastedit.claude.seen", code); brand(); }
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
  function setOn(v) { on = v; store.set("fastedit.claude.on", v ? "1" : "0"); if (v) start(); else stop(); brand(); render(); updateBtn(); }

  /* ---------- Claude answers in the chat panel (your own API key, from this browser) ---------- */
  let sdkP = null;
  const loadSDK = () => (sdkP ||= new Promise((res, rej) => {
    if (window.Anthropic) return res(window.Anthropic);
    const s = document.createElement("script"); s.src = "vendor/anthropic-sdk.js";
    s.onload = () => res(window.Anthropic); s.onerror = () => { sdkP = null; rej(new Error("Couldn't load the Claude library. Check your connection.")); }; document.head.append(s);
  }));
  const MODEL = "claude-opus-5-5";
  const SYSTEM = `You are Claude, chatting with the user inside Fast Edit, a photo and video editor in their browser. The user talks to you in the editor's side panel and sees your replies there.

You can see their work and change it with tools:
- fastedit_look: a screenshot of the photo or the current video frame, plus what's open. Each user message already includes one; call it again after changes to check the result, or (video) to look at another moment.
- fastedit_do: tell Fast Edit's built-in editing assistant what to do, in plain English, one clear step at a time. It is a small on-device model that understands short editing commands, not long or subtle sentences. Photo examples: "make it warmer", "blur the background", "add a caption saying Hello", "remove the background", "make a thumbnail". Video examples: "trim the first 2 seconds", "make it 15 seconds with the best parts", "cinematic and vertical for TikTok", "find upbeat music", "add a whoosh sound", "edit it for me", "make a video about my trip". Break bigger requests into steps, and if it doesn't understand, rephrase more simply.
- fastedit_undo and fastedit_mode (photo or video).

Chat like a helpful, direct person: answer questions, give honest opinions about their photo or video, and make the edits they ask for. Look at the result before saying it worked, and don't claim an edit you didn't make. Keep replies short. Music from the Marketplace uses free Creative Commons songs or originals, never copyrighted songs.`;
  const TOOLS = [
    { name: "fastedit_look", description: "Screenshot of the current photo or video frame, plus what's open.", input_schema: { type: "object", properties: { at_seconds: { type: "number", description: "Video only: look at this time in the timeline (seconds)." } }, additionalProperties: false } },
    { name: "fastedit_do", description: "Tell Fast Edit's built-in editing assistant to do one thing, in plain English. Returns its reply and a screenshot.", input_schema: { type: "object", properties: { request: { type: "string" } }, required: ["request"], additionalProperties: false } },
    { name: "fastedit_undo", description: "Undo the last change.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fastedit_mode", description: "Switch between photo and video mode.", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["photo", "video"] } }, required: ["mode"], additionalProperties: false } },
  ];
  const imgBlock = (b64) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
  const stripImages = (msgs) => { // keep old turns cheap: only the newest screenshots are sent
    for (const m of msgs) if (m.role === "user" && Array.isArray(m.content)) {
      m.content = m.content.filter((b) => b.type !== "image").map((b) => (b.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: b.content.filter((x) => x.type !== "image") } : b));
      if (!m.content.length) m.content = [{ type: "text", text: "(screenshot omitted)" }];
    }
  };
  async function localTool(name, a, chat) {
    const m = mode();
    if (name === "fastedit_look") { const r = await run("look", { at: a.at_seconds }); return { text: r.text, image: r.image }; }
    if (name === "fastedit_undo") { const r = await run("undo", {}); return { text: r.text, image: r.image }; }
    if (name === "fastedit_mode") { if (a.mode !== "photo" && a.mode !== "video") return { text: "mode must be photo or video.", error: true }; const r = await run("mode", { mode: a.mode }); return { text: r.text, image: r.image }; }
    if (name === "fastedit_do") {
      const req = String(a.request || "").slice(0, 1000).trim(); if (!req) return { text: "Give a request, like \"make it warmer\".", error: true };
      const c = window.FEChat.get(m); const rep = await c.run(req);
      const tag = rep.tags && rep.tags.length ? ` (${rep.tags.join(", ")})` : "";
      return { text: `${rep.text || "Done."}${tag}${rep.chips && rep.chips.length ? `\nFast Edit AI suggests: ${rep.chips.join(" | ")}` : ""}\n\n${describe()}`, image: shot(768) };
    }
    return { text: "Unknown tool.", error: true };
  }
  const NOTES = { fastedit_do: (a) => `Claude: ${String(a.request || "").slice(0, 80)}` }; // look, undo and mode add their own notes
  function keyProblem(e, Anthropic) {
    if (e instanceof Anthropic.AuthenticationError) return "Anthropic didn't accept that API key. Open **Claude** at the top, remove the key and add a valid one.";
    if (e instanceof Anthropic.PermissionDeniedError) return "That API key isn't allowed to use this model. Check the key's access in console.anthropic.com.";
    if (e instanceof Anthropic.RateLimitError) return "Anthropic is rate-limiting this key right now. Wait a minute and try again.";
    if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection and try again.";
    if (e instanceof Anthropic.APIError) return /credit|billing|balance/i.test(e.message) ? "Your Anthropic account is out of credit. Add some in console.anthropic.com → Billing." : `Anthropic returned an error (${e.status}): ${e.message}`;
    return "Something went wrong: " + (e && e.message ? e.message : "unknown error");
  }
  async function chat(text, c, m) {
    let Anthropic; try { Anthropic = await loadSDK(); } catch (e) { return { text: e.message }; }
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(window.__FE_CLAUDE_BASE ? { baseURL: window.__FE_CLAUDE_BASE } : {}) });
    const msgs = hist[m]; stripImages(msgs); const mark = msgs.length;
    const first = shot(768);
    msgs.push({ role: "user", content: [...(first ? [imgBlock(first)] : []), { type: "text", text: `${text}\n\n[Editor now: ${describe()}]` }] });
    let edited = false, fallbacks = true, out = "";
    const create = (body) => client.beta.messages.create(fallbacks ? { ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : body);
    try {
      for (let i = 0; i < 10; i++) {
        let resp;
        try { resp = await create({ model: MODEL, max_tokens: 4096, system: SYSTEM, tools: TOOLS, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, messages: msgs }); }
        catch (e) { if (fallbacks && e instanceof Anthropic.BadRequestError && /beta|fallback/i.test(e.message)) { fallbacks = false; i--; continue; } throw e; }
        msgs.push({ role: "assistant", content: resp.content });
        const say = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (resp.stop_reason === "refusal") { out = say || "I can't help with that one."; break; }
        if (resp.stop_reason === "max_tokens") { out = (say ? say + "\n\n" : "") + "(I ran out of room for that reply. Ask me to continue.)"; break; }
        const uses = resp.content.filter((b) => b.type === "tool_use");
        if (resp.stop_reason !== "tool_use" || !uses.length) { out = say || "Done."; break; }
        const results = [];
        for (const u of uses) {
          const cc = window.FEChat.get(mode()) || c; if (NOTES[u.name]) cc.note(NOTES[u.name](u.input || {}));
          let r; try { r = await localTool(u.name, u.input || {}, cc); } catch (e) { r = { text: `That failed: ${e && e.message ? e.message : "unknown error"}`, error: true }; }
          if (u.name === "fastedit_do" || u.name === "fastedit_undo") edited = true;
          results.push({ type: "tool_result", tool_use_id: u.id, ...(r.error ? { is_error: true } : {}), content: [{ type: "text", text: r.text || "Done." }, ...(r.image ? [imgBlock(r.image)] : [])] });
        }
        msgs.push({ role: "user", content: results });
        if (i === 9) out = say || "I stopped after several steps. Tell me if you want me to keep going.";
      }
    } catch (e) { msgs.length = mark; console.error(e); return { text: keyProblem(e, Anthropic) }; }
    const img = edited ? shot(720) : null;
    return { text: out, ...(img ? { image: "data:image/jpeg;base64," + img, imageAlt: "How it looks now" } : {}) };
  }

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
    const keyMsg = keyErr ? `<span class="clm-status err">${esc(keyErr)}</span>` : "";
    const status = !on ? ["off", "Off"] : lastErr ? ["err", lastErr] : busy ? ["busy", "Claude is editing…"] : ["on", lastCall ? `Connected · Claude last used “${lastCall.tool}” ${Math.max(0, Math.round((Date.now() - lastCall.at) / 1000))}s ago` : "Connected · waiting for Claude"];
    b.innerHTML = `
      <p class="clm-lead">Let <b>Claude</b> see and edit your work in Fast Edit. Claude looks at your photo or video frame and tells Fast Edit AI what to do, like “make it warmer” or “cut it to 15 seconds”.</p>
      <div class="label">Chat with Claude right here</div>
      <p class="hint" style="margin-top:0">Replaces Fast Edit AI in the chat panel with Claude itself. It needs a Claude API key from <b>console.anthropic.com</b> (a separate account from claude.ai; every message is billed to it). The key stays in this browser and goes only to Anthropic. Your messages and a small screenshot of your work are sent when you chat.</p>
      ${apiKey ? `<div class="clm-row"><label class="check"><input type="checkbox" id="clmUseKey" ${useKey ? "checked" : ""}> Claude answers in the chat panel</label><button class="btn sm" id="clmKeyDel">Remove key</button></div>${keyMsg}`
        : `<div class="clm-link"><input type="password" id="clmKey" placeholder="Paste your API key (sk-ant-…)" autocomplete="off" aria-label="Claude API key"><button class="btn sm primary" id="clmKeySave">Save</button></div>${keyMsg}`}
      <div class="label">Or: let Claude in claude.ai edit this tab</div>
      <p class="hint" style="margin-top:0">Add this private link in Claude. Claude then edits from its own chat, and the panel here shows what it does.</p>
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
    const ks = $("#clmKeySave");
    if (ks) ks.onclick = () => { const v = $("#clmKey").value.trim(); if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v)) { keyErr = "That doesn't look like a Claude API key (it starts with sk-ant-)."; return render(); } keyErr = ""; apiKey = v; store.set("fastedit.claude.key", v); useKey = true; store.set("fastedit.claude.usekey", "1"); brand(); noteAll("Claude now answers in this panel"); render(); };
    const uk = $("#clmUseKey"); if (uk) uk.onchange = (e) => { useKey = e.target.checked; store.set("fastedit.claude.usekey", useKey ? "1" : "0"); brand(); noteAll(useKey ? "Claude now answers in this panel" : "Fast Edit AI answers in this panel again"); render(); };
    const kd = $("#clmKeyDel"); if (kd) kd.onclick = () => { apiKey = ""; useKey = false; store.del("fastedit.claude.key"); store.del("fastedit.claude.usekey"); hist.photo = []; hist.video = []; keyErr = ""; brand(); render(); FE.toast("Key removed from this browser"); };
    $("#clmCopy").onclick = async () => { try { await navigator.clipboard.writeText(link()); FE.toast("Link copied"); } catch { const i = $("#clmLink"); i.focus(); i.select(); FE.toast("Select the link and copy it"); } };
    $("#clmLink").onfocus = (e) => e.target.select();
    $("#clmNew").onclick = () => { if (!confirm("Make a new link? The current one will stop working.")) return; code = newCode(); store.set("fastedit.claude.code", code); store.del("fastedit.claude.seen"); seen = false; lastCall = null; brand(); render(); FE.toast("New link made. Add it in Claude."); };
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
  updateBtn(); brand(); if (on) start();

  window.FEClaude = { open, close, chat, chatActive, get on() { return on; } };
})();
