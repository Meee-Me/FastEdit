/*
 * Fast Edit <-> AI (Claude, ChatGPT, others). "Connect AI" button: (1) an AI answers in the chat panel
 * using the user's own API key; (2) a private connector link (MCP) lets an AI app edit this tab. While
 * the link is on, this tab checks a small relay (Supabase) for commands, runs them here and sends
 * back a reply and a screenshot. Your photos and videos stay in this browser; only the screenshot Claude asks for
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
  // Which AI answers in the chat panel (needs that AI's own API key), and which AI app uses the private link
  const PROV = {
    claude: { name: "Claude", vendor: "Anthropic", site: "console.anthropic.com", keyOk: (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k), keyHint: "sk-ant-…" },
    chatgpt: { name: "ChatGPT", vendor: "OpenAI", site: "platform.openai.com", base: "https://api.openai.com/v1", model: "gpt-5", keyOk: (k) => /^sk-[A-Za-z0-9_-]{20,}$/.test(k), keyHint: "sk-…" },
    gemini: { name: "Gemini", vendor: "Google", site: "aistudio.google.com", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", keyOk: (k) => k.length >= 20, keyHint: "AIza…", app: "gemini.google.com" },
    groq: { name: "Groq", vendor: "Groq", site: "console.groq.com", base: "https://api.groq.com/openai/v1", model: "", keyOk: (k) => k.length >= 20, keyHint: "gsk_…" },
    openrouter: { name: "OpenRouter", vendor: "OpenRouter", site: "openrouter.ai", base: "https://openrouter.ai/api/v1", model: "", keyOk: (k) => k.length >= 20, keyHint: "sk-or-…" },
    mistral: { name: "Mistral", vendor: "Mistral", site: "console.mistral.ai", base: "https://api.mistral.ai/v1", model: "", keyOk: (k) => k.length >= 16, keyHint: "API key" },
    other: { name: "AI", vendor: "the AI service", keyOk: (k) => k.length >= 8, keyHint: "API key" },
  };
  const ORDER = ["claude", "chatgpt", "gemini", "groq", "openrouter", "mistral", "other"];
  const getf = (p, k) => store.get(`fastedit.ai.${p}.${k}`) || "", setf = (p, k, v) => store.set(`fastedit.ai.${p}.${k}`, v);
  const keyOf = (p) => getf(p, "key");
  { const old = store.get("fastedit.claude.key"); // earlier versions stored a Claude key here
    if (old && !keyOf("claude")) { setf("claude", "key", old); if (store.get("fastedit.claude.usekey") === "1") store.set("fastedit.ai.active", "claude"); }
    store.del("fastedit.claude.key"); store.del("fastedit.claude.usekey"); }
  let prov = PROV[store.get("fastedit.ai.prov")] ? store.get("fastedit.ai.prov") : "claude";
  let active = store.get("fastedit.ai.active") || ""; if (!PROV[active] || !keyOf(active)) active = "";
  let mcpAgent = PROV[store.get("fastedit.mcp.agent")] ? store.get("fastedit.mcp.agent") : "claude";
  const nameOf = (p) => (p === "other" ? getf("other", "name") || "AI" : PROV[p].name);
  const baseOf = (p) => ((window.__FE_BASES && window.__FE_BASES[p]) || (p === "chatgpt" && window.__FE_OPENAI_BASE) || PROV[p].base || getf(p, "base")).replace(/\/+$/, "");
  const modelOf = (p) => getf(p, "model") || PROV[p].model || "";
  const vendorOf = (p) => { if (p !== "other") return PROV[p].vendor; try { return new URL(baseOf(p)).hostname; } catch { return PROV.other.vendor; } };
  const chatActive = () => !!active && !!keyOf(active);
  const handles = () => chatActive() || on; // an AI is connected, so what you type here goes to it
  const nm = () => nameOf(chatActive() ? active : mcpAgent);
  const appOf = (p) => (p === "claude" ? "claude.ai" : PROV[p].app || (p === "chatgpt" ? "chatgpt.com" : "its app"));
  function brandFor() {
    if (chatActive()) {
      const n = nameOf(active);
      return { name: n, status: `${n} · using your API key`, foot: `${n} answers here. Your messages and a small screenshot of your work go to ${vendorOf(active)}, using your own API key.`, placeholder: `Ask ${n}…`,
        welcome: `Ask ${n} anything about your work, or tell ${n} what to change. ${n} can see it and edit it with you: ask for ideas, an honest opinion, or a finished edit. What should we do?` };
    }
    if (on) {
      const n = nameOf(mcpAgent);
      return { name: n, status: "Connected · messages go to " + n, foot: `${n} is connected through your link. What you type here is sent to ${n}. If ${n} doesn't pick it up in a few seconds, Fast Edit AI does it. For ${n} to answer every time on its own, add an API key.`, placeholder: `Ask ${n}…`,
        welcome: `${n} is connected. Type what you want here, then tell ${n} (in ${appOf(mcpAgent)}) to “check Fast Edit”. If ${n} doesn't pick it up after a few seconds, Fast Edit AI does it.` };
    }
    return null;
  }
  function brand() {
    const b = brandFor();
    document.body.classList.toggle("claude-on", !!b);
    for (const m of ["photo", "video"]) { const c = window.FEChat && window.FEChat.get(m); if (c && c.setBrand) c.setBrand(b); }
    updateBtn();
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

  /* ---------- what's on screen (see agent.js) ---------- */
  const shot = (m) => window.FEAgent.shot(m), describe = () => window.FEAgent.describe();
  let toolsMod = null; // the tool definitions (agent-tools.mjs), loaded on first use
  const loadTools = () => (toolsMod ||= import("./agent-tools.mjs").catch((e) => { toolsMod = null; throw e; }));
  const noteFor = async (c, name, args) => { try { const { LABELS } = await loadTools(); const f = LABELS[name]; if (f) c.note(`${nm()} ${f(args || {})}`); } catch {} };
  // messages typed in the panel while an AI is connected through the link wait here, for the AI to read (fastedit_inbox)
  let inbox = [], seq = Number(store.get("fastedit.claude.seq") || 0);
  const info = () => { const o = { mode: mode(), v: 1, seq, inbox: [...inbox] }; while (JSON.stringify(o).length > 3600 && o.inbox.length) o.inbox.shift(); return o; };
  const FALLBACK_MS = window.__FE_FALLBACK_MS || 25000, pending = new Map();
  async function relay(text, c, m) {
    const n = nameOf(mcpAgent), id = ++seq;
    inbox.push({ seq: id, at: new Date().toISOString(), mode: m, text: String(text).slice(0, 600) }); inbox = inbox.slice(-6); store.set("fastedit.claude.seq", String(seq));
    pending.set(id, setTimeout(() => fallback(id, String(text), m), FALLBACK_MS));
    return { text: `Sent to ${n}. Tell ${n} (in ${appOf(mcpAgent)}) to **check Fast Edit** and it acts on this. If it hasn't picked this up in ${Math.round(FALLBACK_MS / 1000)} seconds, Fast Edit AI does it for you.` };
  }
  async function fallback(id, text, m) { // the AI didn't read the message in time, so Fast Edit AI does it
    pending.delete(id); const i = inbox.findIndex((x) => x.seq === id); if (i < 0) return; inbox.splice(i, 1);
    const c = window.FEChat.get(m); if (!c) return;
    try { const rep = await c.run(text); await c.say({ ...rep, text: `${nm()} hasn't picked this up, so Fast Edit AI did it:\n\n${rep.text || "Done."}` }); }
    catch (e) { await c.say({ text: `${nm()} hasn't picked this up, and Fast Edit AI couldn't do it: ${e && e.message ? e.message : "unknown error"}` }); }
  }
  function markRead(upTo) { // the AI read its inbox: no fallback for those messages
    const read = inbox.filter((x) => x.seq <= upTo); if (!read.length) return;
    for (const x of read) { clearTimeout(pending.get(x.seq)); pending.delete(x.seq); }
    inbox = inbox.filter((x) => x.seq > upTo); chatOf().note(`${nm()} read your message${read.length > 1 ? "s" : ""}`);
  }

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
    if (tool === "inbox_read") { markRead(+args.upto || 0); return { text: "ok" }; }
    if (tool === "look") {
      if (mode() === "video" && Number.isFinite(args.at) && window.FEVideo.V.clips.length) { await window.FEVideo.seek(Math.max(0, Math.min(args.at, window.FEVideo.total() - 0.05))); await sleep(300); }
      return { text: describe(), image: shot() };
    }
    if (tool === "do") { const text = await chatSend(String(args.request || ""), nm()); return { text: `${text || "Done."}\n\n${describe()}`, image: shot() }; }
    if (tool === "undo") {
      const m = mode(), api = window.FEChat.get(m); const ok = api && api.cfg.undo();
      await sleep(200); return { text: (ok ? "Undid the last change. " : "Nothing to undo. ") + describe(), image: shot() };
    }
    if (tool === "mode") {
      if (args.mode !== mode()) { $(`[data-app-mode="${args.mode}"]`).click(); await sleep(500); }
      return { text: `Now in ${mode()} mode. ${describe()}`, image: shot() };
    }
    return await window.FEAgent.call("fastedit_" + tool, args);
  }
  async function tick() {
    if (!on || polling) return; polling = true;
    try {
      const cmds = (await rpc("fe_take", { p_session: code, p_info: info() })) || [];
      lastErr = null;
      for (const c of cmds) {
        if (c.tool !== "do" && c.tool !== "inbox_read") noteFor(chatOf(), "fastedit_" + c.tool, c.args || {});
        if (!seen) { seen = true; store.set("fastedit.claude.seen", code); brand(); }
        busy = true; refreshStatus();
        let res;
        try { res = await run(c.tool, c.args || {}); lastCall = { tool: c.tool, at: Date.now() }; }
        catch (e) { res = { error: true, text: `Fast Edit couldn't do that: ${e && e.message ? e.message : "unknown error"}` }; }
        try { await rpc("fe_done", { p_session: code, p_id: c.id, p_result: res }); } catch (e) { lastErr = `Couldn't send the result to ${nm()}.`; }
        busy = false;
      }
    } catch (e) { lastErr = "Can't reach the connection service."; }
    polling = false; refreshStatus();
  }
  function start() { stop(); if (!on) return; tick(); timer = setInterval(tick, document.hidden ? 4000 : 1500); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  document.addEventListener("visibilitychange", () => { if (on) start(); });
  function setOn(v) { on = v; store.set("fastedit.claude.on", v ? "1" : "0"); if (v) start(); else stop(); brand(); render(); }

  /* ---------- an AI answers in the chat panel (your own API key, from this browser) ---------- */
  let sdkP = null;
  const loadSDK = () => (sdkP ||= new Promise((res, rej) => {
    if (window.Anthropic) return res(window.Anthropic);
    const s = document.createElement("script"); s.src = "vendor/anthropic-sdk.js";
    s.onload = () => res(window.Anthropic); s.onerror = () => { sdkP = null; rej(new Error("Couldn't load the Claude library. Check your connection.")); }; document.head.append(s);
  }));
  const MODEL = "claude-opus-5-5";
  const SYSTEM = (n) => `You are ${n}. The user is chatting with you inside Fast Edit, a photo and video editor in their browser, through its side panel.

You can see their work and change it with the editor's tools. Use your own judgment, taste and creativity: plan the work, write the words, choose the colors, timing and music, and make something good, the way you would if you were editing it yourself. Look at the result when it matters.

Two things about the editor: its tools make precise changes (text, colors, shapes, layers, a scene-by-scene video maker, an exact timeline editor, free music and sounds), and fastedit_do hands a short request to a small built-in assistant for things only it can do (remove or blur a background, animated effects like snow or confetti, thumbnails). Music and photos from the Marketplace are free Creative Commons or original, never copyrighted songs.`;
  let TOOLS = [], LABELS_ = {};
  async function ensureTools() { const m = await loadTools(); TOOLS = m.TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })); LABELS_ = m.LABELS; }
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
    return await window.FEAgent.call(name, a);
  }
  function keyProblem(e, Anthropic) {
    if (e instanceof Anthropic.AuthenticationError) return "Anthropic didn't accept that API key. Open **Connect AI** at the top, remove the key and add a valid one.";
    if (e instanceof Anthropic.PermissionDeniedError) return "That API key isn't allowed to use this model. Check the key's access in console.anthropic.com.";
    if (e instanceof Anthropic.RateLimitError) return "Anthropic is rate-limiting this key right now. Wait a minute and try again.";
    if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection and try again.";
    if (e instanceof Anthropic.APIError) return /credit|billing|balance/i.test(e.message) ? "Your Anthropic account is out of credit. Add some in console.anthropic.com → Billing." : `Anthropic returned an error (${e.status}): ${e.message}`;
    return "Something went wrong: " + (e && e.message ? e.message : "unknown error");
  }
  async function claudeChat(text, c, m) {
    let Anthropic; try { Anthropic = await loadSDK(); await ensureTools(); } catch (e) { return { text: e.message }; }
    const client = new Anthropic({ apiKey: keyOf("claude"), dangerouslyAllowBrowser: true, ...(window.__FE_CLAUDE_BASE ? { baseURL: window.__FE_CLAUDE_BASE } : {}) });
    const msgs = hist[m]; stripImages(msgs); const mark = msgs.length;
    const first = shot(768);
    msgs.push({ role: "user", content: [...(first ? [imgBlock(first)] : []), { type: "text", text: `${text}\n\n[Editor now: ${describe()}]` }] });
    let edited = false, fallbacks = true, out = "";
    const create = (body) => client.beta.messages.create(fallbacks ? { ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : body);
    try {
      for (let i = 0; i < 25; i++) {
        let resp;
        try { resp = await create({ model: MODEL, max_tokens: 16000, system: SYSTEM(nameOf("claude")), tools: TOOLS, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: msgs }); }
        catch (e) { if (fallbacks && e instanceof Anthropic.BadRequestError && /beta|fallback/i.test(e.message)) { fallbacks = false; i--; continue; } throw e; }
        msgs.push({ role: "assistant", content: resp.content });
        const say = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (resp.stop_reason === "refusal") { out = say || "I can't help with that one."; break; }
        if (resp.stop_reason === "max_tokens") { out = (say ? say + "\n\n" : "") + "(I ran out of room for that reply. Ask me to continue.)"; break; }
        const uses = resp.content.filter((b) => b.type === "tool_use");
        if (resp.stop_reason !== "tool_use" || !uses.length) { out = say || "Done."; break; }
        const results = [];
        for (const u of uses) {
          const cc = window.FEChat.get(mode()) || c; await noteFor(cc, u.name, u.input);
          let r; try { r = await localTool(u.name, u.input || {}, cc); } catch (e) { r = { text: `That failed: ${e && e.message ? e.message : "unknown error"}`, error: true }; }
          if (u.name !== "fastedit_look") edited = true;
          results.push({ type: "tool_result", tool_use_id: u.id, ...(r.error ? { is_error: true } : {}), content: [{ type: "text", text: r.text || "Done." }, ...(r.image ? [imgBlock(r.image)] : [])] });
        }
        msgs.push({ role: "user", content: results });
        if (i === 24) out = say || "I stopped after several steps. Tell me if you want me to keep going.";
      }
    } catch (e) { msgs.length = mark; console.error(e); return { text: keyProblem(e, Anthropic) }; }
    const img = edited ? shot(720) : null;
    return { text: out, ...(img ? { image: "data:image/jpeg;base64," + img, imageAlt: "How it looks now" } : {}) };
  }

  // ChatGPT (OpenAI) and any service that speaks the same chat format (Gemini, Groq, OpenRouter, Mistral, ...)
  function stripOAImages(msgs) {
    for (const m of msgs) if (m.role === "user" && Array.isArray(m.content)) { m.content = m.content.filter((b) => b.type !== "image_url"); if (!m.content.length) m.content = [{ type: "text", text: "(screenshot omitted)" }]; }
  }
  async function oaError(res, p) {
    let msg = ""; try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || j.message || ""; if (Array.isArray(j) && j[0] && j[0].error) msg = j[0].error.message; } catch {}
    msg = String(msg);
    const v = vendorOf(p), n = nameOf(p);
    if (res.status === 401 || res.status === 403) return `${v} didn't accept that API key. Open **Connect AI** at the top, remove the key and add a valid one.`;
    if (res.status === 404) return `${v} says it doesn't have the model “${modelOf(p)}”. Open **Connect AI** and change the model name.`;
    if (res.status === 429) return /quota|credit|billing|balance/i.test(msg) ? `Your ${v} account is out of credit. Add some on its billing page.` : `${v} is rate-limiting this key right now. Wait a minute and try again.`;
    return `${n} returned an error (${res.status})${msg ? ": " + msg.slice(0, 300) : ""}`;
  }
  async function openaiChat(p, text, c, m) {
    try { await ensureTools(); } catch (e) { return { text: "Couldn't load the editing tools. Check your connection." }; }
    const base = baseOf(p), model = modelOf(p), n = nameOf(p);
    if (!/^https:\/\//.test(base) && !/^http:\/\/localhost/.test(base)) return { text: `Open **Connect AI** and enter ${n}'s website address (it starts with https://).` };
    if (!model) return { text: `Open **Connect AI** and enter the model name to use for ${n}.` };
    const msgs = hist[m]; stripOAImages(msgs); const mark = msgs.length;
    const first = shot(768);
    msgs.push({ role: "user", content: [{ type: "text", text: `${text}\n\n[Editor now: ${describe()}]` }, ...(first ? [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + first } }] : [])] });
    const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    let edited = false, out = "";
    try {
      for (let i = 0; i < 25; i++) {
        let res;
        try { res = await fetch(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + keyOf(p) }, body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM(n) }, ...msgs], tools }) }); }
        catch { throw new Error(`Couldn't reach ${vendorOf(p)}. Check your connection. (Some AI services don't allow calls straight from a web page.)`); }
        if (!res.ok) throw new Error(await oaError(res, p));
        const data = await res.json(), ch = data.choices && data.choices[0], msg = ch && ch.message;
        if (!msg) throw new Error(`${n} sent back an empty reply.`);
        const say = (typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((x) => x.text || "").join("") : "").trim();
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        msgs.push({ role: "assistant", content: say || null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) { out = say || "Done."; if (ch.finish_reason === "length") out += "\n\n(I ran out of room for that reply. Ask me to continue.)"; break; }
        let lastImg = null;
        for (const tc of calls) {
          let args = {}; try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch {}
          const name = tc.function && tc.function.name, cc = window.FEChat.get(mode()) || c;
          await noteFor(cc, name, args);
          let r; try { r = await localTool(name, args, cc); } catch (e) { r = { text: `That failed: ${e && e.message ? e.message : "unknown error"}`, error: true }; }
          if (name !== "fastedit_look") edited = true;
          msgs.push({ role: "tool", tool_call_id: tc.id, content: (r.error ? "Error: " : "") + (r.text || "Done.") });
          if (r.image) lastImg = r.image;
        }
        if (lastImg) msgs.push({ role: "user", content: [{ type: "text", text: "Screenshot of the editor after that:" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + lastImg } }] });
        if (i === 24) out = say || "I stopped after several steps. Tell me if you want me to keep going.";
      }
    } catch (e) { msgs.length = mark; console.error(e); return { text: e && e.message ? e.message : "Something went wrong." }; }
    const img = edited ? shot(720) : null;
    return { text: out, ...(img ? { image: "data:image/jpeg;base64," + img, imageAlt: "How it looks now" } : {}) };
  }
  const chat = (text, c, m) => (!chatActive() ? relay(text, c, m) : active === "claude" ? claudeChat(text, c, m) : openaiChat(active, text, c, m));

  /* ---------- UI ---------- */
  document.body.insertAdjacentHTML("beforeend", `
    <div class="mkt" id="clm" hidden role="dialog" aria-modal="true" aria-labelledby="clmTitle">
      <div class="mkt-panel clm-panel">
        <div class="mkt-head"><h2 id="clmTitle">Connect an AI</h2><button class="btn sm ghost" id="clmClose" aria-label="Close" style="margin-left:auto">✕</button></div>
        <div class="mkt-body" id="clmBody"></div>
      </div>
    </div>`);
  const dlg = $("#clm");
  const statusInfo = () => { const n = nameOf(mcpAgent); return !on ? ["off", "Off"] : lastErr ? ["err", lastErr] : busy ? ["busy", `${n} is editing…`] : ["on", lastCall ? `Connected · ${n} last used “${lastCall.tool}” ${Math.max(0, Math.round((Date.now() - lastCall.at) / 1000))}s ago` : `Connected · waiting for ${n}`]; };
  function refreshStatus() { const el = $("#clmStatus"); if (!el || dlg.hidden) return; const s = statusInfo(); el.className = "clm-status " + s[0]; el.textContent = s[1]; }
  const STEPS = {
    claude: ["In Claude, open <b>Settings → Connectors → Add custom connector</b>. Name it “Fast Edit”, paste the link, and add it.", "In a Claude chat, turn the connector on and ask, e.g. “Look at my photo in Fast Edit and make it look like a movie poster.”"],
    chatgpt: ["In ChatGPT, open <b>Settings → Connectors → Advanced</b> and turn on <b>Developer mode</b> (it's only on some plans), then choose <b>Create</b>. Name it “Fast Edit”, paste the link, and pick <b>No authentication</b>.", "In a ChatGPT chat, add the Fast Edit connector (Developer mode in the + menu) and ask, e.g. “Look at my photo in Fast Edit and make it look like a movie poster.”"],
    other: ["In any AI app that supports <b>MCP</b> connectors over the web (a “remote MCP server”), add a new one. Name it “Fast Edit”, paste the link, and choose no authentication.", "Then ask it, e.g. “Look at my photo in Fast Edit and make it look like a movie poster.”"],
  };
  function render() {
    const b = $("#clmBody"); if (!b || dlg.hidden) return;
    const P = PROV[prov], n = nameOf(prov), has = !!keyOf(prov), mn = nameOf(mcpAgent);
    const keyMsg = keyErr ? `<span class="clm-status err">${esc(keyErr)}</span>` : "";
    const opt = (id, cur) => ORDER.map((p) => `<option value="${p}" ${p === cur ? "selected" : ""}>${p === "other" ? "Another AI (any service)" : PROV[p].name}</option>`).join("");
    const hint = prov === "other" ? `Works with any AI service that uses OpenAI's chat format. Use a model that can see images and use tools, and a service that allows calls from a web page.`
      : `Needs ${prov === "claude" ? "a Claude" : "a " + n} API key from <b>${esc(P.site)}</b>.${prov === "gemini" ? " Google has offered a free tier for Gemini keys (check its current limits)." : ""}`;
    const fields = P.base ? `<div class="clm-field"><label for="clmModel">Model</label><input id="clmModel" value="${esc(modelOf(prov))}" placeholder="${esc(P.model || "choose a model")}" autocomplete="off" list="clmModels"><datalist id="clmModels"></datalist></div>${has && !modelOf(prov) ? `<p class="hint" style="margin-top:0">Tap the Model box and choose one of the models your key can use.</p>` : ""}`
      : prov === "other" ? `<div class="clm-field"><label for="clmName">Name</label><input id="clmName" value="${esc(getf("other", "name"))}" placeholder="Gemini" autocomplete="off"></div>
        <div class="clm-field"><label for="clmBase">Website address</label><input id="clmBase" value="${esc(getf("other", "base"))}" placeholder="https://…/v1" autocomplete="off" inputmode="url"></div>
        <div class="clm-field"><label for="clmModel">Model</label><input id="clmModel" value="${esc(getf("other", "model"))}" placeholder="model name" autocomplete="off"></div>` : "";
    b.innerHTML = `
      <p class="clm-lead">Connect an <b>AI</b> to Fast Edit. It sees your photo or video and edits it with its own judgment: ask it to “make a cool video about my trip”, “design a poster” or “cut this to 15 seconds”. It plans the scenes, writes the text, picks colors and music, and edits the timeline itself.</p>
      <div class="label">1. Chat with an AI right here</div>
      <p class="hint" style="margin-top:0">Replaces Fast Edit AI in the chat panel. ${hint} The key is for that service's own account (a subscription like ChatGPT Plus or claude.ai doesn't include it, and every message is billed to the account). The key stays in this browser and goes only to ${esc(vendorOf(prov))}, along with your messages and a small screenshot of your work.</p>
      <div class="clm-field"><label for="clmProv">AI</label><select id="clmProv">${opt("p", prov)}</select></div>
      ${fields}
      ${has ? `<div class="clm-row"><label class="check"><input type="checkbox" id="clmUseKey" ${active === prov ? "checked" : ""}> ${esc(n)} answers in the chat panel</label><button class="btn sm" id="clmKeyDel">Remove key</button></div>${keyMsg}`
        : `<div class="clm-link"><input type="password" id="clmKey" placeholder="Paste your API key (${esc(P.keyHint)})" autocomplete="off" aria-label="${esc(n)} API key"><button class="btn sm primary" id="clmKeySave">Save</button></div>${keyMsg}`}
      <div class="label" style="margin-top:18px">2. Or: let an AI app edit this tab (private link)</div>
      <p class="hint" style="margin-top:0">An AI app can't be woken up from here: it acts when you talk to it. With the link on, what you type in Fast Edit waits for the AI to read it (tell it to “check Fast Edit”); if it doesn't within a few seconds, Fast Edit AI does it. For an AI that answers every message on its own, use an API key in section 1.</p>
      <div class="clm-field"><label for="clmAgent">AI app</label><select id="clmAgent">${opt("a", mcpAgent)}</select></div>
      <div class="clm-row"><label class="check"><input type="checkbox" id="clmOn" ${on ? "checked" : ""}> Allow ${esc(mn)} to use this tab</label><span id="clmStatus" class="clm-status ${statusInfo()[0]}">${esc(statusInfo()[1])}</span></div>
      <div class="label">Your private connector link</div>
      <div class="clm-link"><input readonly id="clmLink" value="${esc(link())}" aria-label="Connector link"><button class="btn sm primary" id="clmCopy">Copy</button></div>
      <ol class="clm-steps">
        <li>Turn on <b>Allow ${esc(mn)} to use this tab</b> above, then tap <b>Copy</b>.</li>
        ${(STEPS[mcpAgent] || STEPS.other).map((t) => `<li>${t}</li>`).join("")}
      </ol>
      <p class="hint">Keep this tab open while ${esc(mn)} works: it can only act while Fast Edit is open here. Your files stay in this browser. ${esc(mn)} only gets the small screenshots and replies it asks for.</p>
      <p class="hint"><b>Treat the link like a password.</b> Anyone who has it can edit this tab while it's connected.</p>
      <div class="btnrow"><button class="btn sm" id="clmNew">Make a new link</button><span class="hint">This disconnects the AI until you add the new link.</span></div>`;
    $("#clmProv").onchange = (e) => { prov = e.target.value; store.set("fastedit.ai.prov", prov); keyErr = ""; render(); };
    $("#clmAgent").onchange = (e) => { mcpAgent = e.target.value; store.set("fastedit.mcp.agent", mcpAgent); brand(); render(); };
    for (const [id, k] of [["#clmModel", "model"], ["#clmName", "name"], ["#clmBase", "base"]]) { const el = $(id); if (el) el.onchange = () => { setf(prov, k, el.value.trim()); if (active === prov) brand(); }; }
    if (P.base && has) loadModels(prov);
    $("#clmOn").onchange = (e) => setOn(e.target.checked);
    const ks = $("#clmKeySave");
    if (ks) ks.onclick = () => {
      const v = $("#clmKey").value.trim();
      if (!P.keyOk(v)) { keyErr = prov === "claude" ? "That doesn't look like a Claude API key (it starts with sk-ant-)." : prov === "chatgpt" ? "That doesn't look like an OpenAI API key (it starts with sk-)." : P.site ? `That doesn't look like a ${n} API key. Copy it again from ${P.site}.` : "Paste the API key from that service."; return render(); }
      if (prov === "other" && (!/^(https:\/\/|http:\/\/localhost)/.test(getf("other", "base")) || !modelOf("other"))) { keyErr = "Fill in the website address (starting with https://) and the model first."; return render(); }
      keyErr = ""; setf(prov, "key", v); active = prov; store.set("fastedit.ai.active", active); hist.photo = []; hist.video = []; brand(); noteAll(`${nameOf(prov)} now answers in this panel`); render();
    };
    const uk = $("#clmUseKey");
    if (uk) uk.onchange = (e) => { active = e.target.checked ? prov : active === prov ? "" : active; store.set("fastedit.ai.active", active); hist.photo = []; hist.video = []; brand(); noteAll(active ? `${nameOf(active)} now answers in this panel` : "Fast Edit AI answers in this panel again"); render(); };
    const kd = $("#clmKeyDel");
    if (kd) kd.onclick = () => { store.del(`fastedit.ai.${prov}.key`); if (active === prov) { active = ""; store.set("fastedit.ai.active", ""); } hist.photo = []; hist.video = []; keyErr = ""; brand(); render(); FE.toast("Key removed from this browser"); };
    $("#clmCopy").onclick = async () => { try { await navigator.clipboard.writeText(link()); FE.toast("Link copied"); } catch { const i = $("#clmLink"); i.focus(); i.select(); FE.toast("Select the link and copy it"); } };
    $("#clmLink").onfocus = (e) => e.target.select();
    $("#clmNew").onclick = () => { if (!confirm("Make a new link? The current one will stop working.")) return; code = newCode(); store.set("fastedit.claude.code", code); store.del("fastedit.claude.seen"); seen = false; lastCall = null; brand(); render(); FE.toast("New link made. Add it in your AI app."); };
  }
  let modelsFor = "", modelIds = {};
  async function loadModels(p) { // suggest the models this key can use
    const tag = p + ":" + keyOf(p), fill = () => { const dl = $("#clmModels"); if (dl && modelIds[p]) dl.innerHTML = modelIds[p].map((id) => `<option value="${esc(id)}">`).join(""); };
    if (modelsFor === tag) return fill(); modelsFor = tag;
    try {
      const r = await fetch(baseOf(p) + "/models", { headers: { authorization: "Bearer " + keyOf(p) } }); if (!r.ok) { modelsFor = ""; return; }
      const bad = /(audio|realtime|transcribe|tts|image|embed|moderation|search|instruct|whisper|guard|rerank|ocr)/;
      let ids = ((await r.json()).data || []).map((x) => String(x.id).replace(/^models\//, "")).filter((id) => !bad.test(id));
      if (p === "chatgpt") ids = ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id)); if (p === "gemini") ids = ids.filter((id) => /^gemini/.test(id));
      modelIds[p] = ids.sort().reverse().slice(0, 300); fill();
    } catch { modelsFor = ""; }
  }
  function open() { dlg.hidden = false; render(); }
  function close() { dlg.hidden = true; }
  $("#clmClose").onclick = close; dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dlg.hidden) close(); });
  setInterval(() => { if (!dlg.hidden) refreshStatus(); }, 3000);

  const btn = document.createElement("button"); btn.className = "btn video-only"; btn.id = "clmOpen"; btn.onclick = open;
  $("#mktOpen") ? $("#mktOpen").before(btn) : $("#deluxeAccount").before(btn);
  const menu = $(".menubar"); let mb = null;
  if (menu) { mb = document.createElement("button"); mb.type = "button"; mb.className = "menu-btn clm-menu"; mb.onclick = open; menu.append(mb); }
  function updateBtn() {
    const live = chatActive() || on, t = live ? nameOf(chatActive() ? active : mcpAgent) + " ●" : "Connect AI";
    btn.textContent = t; if (mb) mb.textContent = t; btn.classList.toggle("clm-on", live); if (mb) mb.classList.toggle("clm-on", live);
  }
  updateBtn(); brand(); if (on) start();

  window.FEClaude = { open, close, chat, chatActive, handles, get on() { return on; } };
})();
