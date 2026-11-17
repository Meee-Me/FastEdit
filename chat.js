/*
 * Fast Edit — chat with Fast Edit AI, in the style of a modern AI assistant.
 * One conversation per mode (photo, video). Fast Edit AI decides whether a
 * message is conversation (answered in words) or an edit (carried out), and
 * remembers your last edit for follow-ups like "stronger", "a bit less" or "undo that".
 */
(function () {
  "use strict";
  const AI = window.FastAI;
  const chats = {};
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  let curAvatar = null;
  const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5 13.5h5.5L9 22l9.5-12.5H13z" fill="currentColor"/></svg>';

  curAvatar = BOLT;
  function mount(host, cfg) {
    host.classList.add("chat");
    host.innerHTML = `
      <div class="chat-head">
        <span class="chat-avatar">${BOLT}</span>
        <div class="chat-who"><b>Fast Edit AI</b><span class="chat-status">Starting…</span></div>
        <span class="agentdot"></span>
        <button class="btn sm ghost chat-new" type="button" title="Start a new conversation">New chat</button>
      </div>
      <div class="chat-log" role="log" aria-live="polite" aria-label="Conversation with Fast Edit AI"></div>
      <form class="chat-composer">
        ${cfg.attach ? `<button class="chat-attach" type="button" aria-label="Attach files" title="${esc(cfg.attach.title)}"><svg viewBox="0 0 24 24"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><input type="file" class="chat-file" multiple hidden accept="${esc(cfg.attach.accept)}">` : ""}
        <textarea rows="1" aria-label="Message Fast Edit AI" placeholder="${esc(cfg.placeholder)}"></textarea>
        <button class="chat-send" type="submit" aria-label="Send" title="Send (Enter)"><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </form>
      <div class="chat-foot">Runs on your device. Nothing you edit is uploaded.</div>`;
    const log = host.querySelector(".chat-log"), form = host.querySelector(".chat-composer"), box = form.querySelector("textarea"), sendBtn = form.querySelector(".chat-send");
    const statusEl = host.querySelector(".chat-status"), dot = host.querySelector(".agentdot");
    const mem = { last: null };
    let working = false;

    const scroll = () => { log.scrollTop = log.scrollHeight; };
    function clearChips() { log.querySelectorAll(".msg-chips").forEach((c) => c.remove()); }
    function userMsg(text, files, from) {
      clearChips(); const m = document.createElement("div"); m.className = "msg user" + (from ? " from-agent" : "");
      if (from) { const l = document.createElement("div"); l.className = "msg-from"; l.textContent = from + " asked"; m.append(l); }
      if (files && files.length) { const f = document.createElement("div"); f.className = "msg-files"; for (const x of files) { const c = document.createElement("span"); c.className = "file-chip"; c.textContent = fileLabel(x); f.append(c); } m.append(f); }
      if (text) { const t = document.createElement("div"); t.textContent = text; m.append(t); }
      log.append(m); scroll();
    }
    function typing() { const m = document.createElement("div"); m.className = "msg ai"; m.innerHTML = `<span class="chat-avatar sm">${curAvatar}</span><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div>`; log.append(m); scroll(); return m; }
    async function aiMsg(el, reply) {
      const body = el.querySelector(".msg-body"); body.innerHTML = "";
      const textEl = document.createElement("div"); textEl.className = "msg-text"; body.append(textEl);
      const html = md(reply.text || "Done.");
      if (reduceMotion) textEl.innerHTML = html;
      else {
        const words = (reply.text || "Done.").split(/(\s+)/), step = Math.max(1, Math.ceil(words.length / 45));
        for (let i = 0; i < words.length; i += step) { textEl.innerHTML = md(words.slice(0, i + step).join("")); scroll(); await new Promise((r) => setTimeout(r, 16)); }
        textEl.innerHTML = html;
      }
      if (reply.image) {
        const img = document.createElement("img"); img.className = "msg-img"; img.alt = reply.imageAlt || "Image made by Fast Edit AI";
        img.src = typeof reply.image === "string" ? reply.image : reply.image.toDataURL("image/jpeg", 0.88); body.append(img);
      }
      if (reply.embed && /^https:\/\/open\.spotify\.com\/embed\/track\/[A-Za-z0-9]{22}$/.test(reply.embed)) {
        const f = document.createElement("iframe"); f.className = "msg-embed"; f.src = reply.embed + "?utm_source=generator&theme=0"; f.height = "80"; f.loading = "lazy";
        f.title = "Spotify player (listening only)"; f.allow = "autoplay; clipboard-write; encrypted-media"; body.append(f);
      }
      if (reply.actions && reply.actions.length) {
        const row = document.createElement("div"); row.className = "msg-actions";
        for (const a of reply.actions) { const b = document.createElement("button"); b.type = "button"; b.className = "btn sm" + (a.primary ? " primary" : ""); b.textContent = a.label; b.onclick = () => a.run(); row.append(b); }
        body.append(row);
      }
      if (reply.tags && reply.tags.length) { const t = document.createElement("div"); t.className = "understood"; for (const x of reply.tags) { const s = document.createElement("span"); s.textContent = x; t.append(s); } body.append(t); }
      if (reply.chips && reply.chips.length) {
        const c = document.createElement("div"); c.className = "msg-chips";
        for (const label of reply.chips) { const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = label; b.onclick = () => send(label); c.append(b); }
        body.append(c);
      }
      scroll();
    }
    function welcome() {
      log.innerHTML = "";
      const el = document.createElement("div"); el.className = "msg ai"; el.innerHTML = `<span class="chat-avatar sm">${curAvatar}</span><div class="msg-body"></div>`; log.append(el);
      aiMsg(el, { text: branded ? branded.welcome : cfg.welcome, chips: cfg.starters });
    }

    async function respond(text, internal) {
      if (!internal && window.FEClaude && window.FEClaude.chatActive()) return await window.FEClaude.chat(text, chats[cfg.mode], cfg.mode);
      if (!AI.ready) { setStatus("Learning on your device…"); await AI.train(); }
      const r = AI.converse(text, cfg.mode);
      const followChips = (extra) => [...(extra || []).slice(0, 2), "Stronger", "A bit less", "Undo that"];
      switch (r.kind) {
        case "answer": return { text: r.text, chips: r.chips };
        case "undo": return cfg.undo() ? { text: "Undid that. Anything else you'd like to try?", chips: cfg.starters.slice(0, 3) } : { text: "There's nothing to undo yet." };
        case "stronger": {
          if (!mem.last) return { text: "Tell me an edit first, then I can make it stronger.", chips: cfg.starters.slice(0, 3) };
          const res = await cfg.edit(mem.last);
          return { text: "Pushed it further: " + lower(res.text), tags: res.tags, chips: followChips(res.chips) };
        }
        case "weaker": {
          if (!mem.last) return { text: "Tell me an edit first, then I can tone it down.", chips: cfg.starters.slice(0, 3) };
          cfg.undo(); const res = await cfg.edit("slightly " + mem.last);
          return { text: "Dialed it back: " + lower(res.text), tags: res.tags, chips: followChips(res.chips) };
        }
        case "make_video": return await cfg.makeVideo(r.topic, text);
        case "make_poster": return await cfg.makePoster(r.topic, text);
        case "make_thumbnail": return await cfg.makeThumbnail(r.topic, text);
        case "auto_edit": return await cfg.autoEdit(r.topic, r.secs, text);
        case "open_claude": { if (!window.FEClaude) return { text: "The AI connection isn't loaded yet. Try again in a moment." }; window.FEClaude.open(); return { text: "I opened **Connect AI**. Pick Claude, ChatGPT or another AI. You can paste its API key to chat with it right here, or copy your private link into its app so it can edit your work." }; }
        case "spotify_like": case "remove_music": case "find_music": case "compose_music": case "find_photo": case "find_sound": case "open_market": case "add_credits": {
          const M = window.FEMarket; if (!M) return { text: "The Marketplace isn't loaded yet. Try again in a moment." };
          const fn = { spotify_like: "spotifyLike", remove_music: "removeMusic", find_music: "findMusic", compose_music: "composeMusic", find_photo: "findPhoto", find_sound: "findSound", open_market: "openMarket", add_credits: "addCredits" }[r.kind];
          try { return await M.ai[fn]({ text, again: r.again }); } catch (e) { console.error(e); return { text: "That didn't work: " + (e && e.message ? e.message : "unknown error") + "." }; }
        }
        default: {
          try {
            const res = await cfg.edit(text);
            if (!res.critique) mem.last = text;
            return res.critique ? res : { text: res.text, tags: res.tags, chips: followChips(res.chips) };
          } catch (e) {
            if (e && (e.code === "not_understood" || e.code === "not_ready")) return AI.fallback(text, cfg.mode);
            console.error(e);
            return { text: "Something went wrong while editing: " + (e && e.message ? e.message : "unknown error") + ". Your picture wasn't changed." };
          }
        }
      }
    }
    const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
    let pending = [];
    const tray = document.createElement("div"); tray.className = "chat-tray"; tray.hidden = true; form.before(tray);
    function renderTray() {
      tray.innerHTML = ""; tray.hidden = !pending.length;
      pending.forEach((f, i) => { const c = document.createElement("span"); c.className = "file-chip"; c.textContent = fileLabel(f); const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove " + f.name); x.onclick = () => { pending.splice(i, 1); renderTray(); }; c.append(x); tray.append(c); });
    }
    const fileLabel = (f) => `${/^video/.test(f.type) ? "🎬" : /^audio/.test(f.type) ? "🎵" : /^image/.test(f.type) ? "🖼" : "📄"} ${f.name}`;
    function addPending(files) {
      const ok = [...files].filter((f) => cfg.attach.ok(f));
      if (ok.length < files.length) window.FE && FE.toast(cfg.attach.reject);
      if (!ok.length) return;
      pending.push(...ok); renderTray(); box.focus();
    }
    if (cfg.attach) {
      const fileIn = host.querySelector(".chat-file");
      host.querySelector(".chat-attach").onclick = () => fileIn.click();
      fileIn.onchange = () => { addPending(fileIn.files); fileIn.value = ""; };
      host.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); host.classList.add("drop-on"); } });
      host.addEventListener("dragleave", (e) => { if (e.target === host || !host.contains(e.relatedTarget)) host.classList.remove("drop-on"); });
      host.addEventListener("drop", (e) => { e.preventDefault(); host.classList.remove("drop-on"); addPending(e.dataTransfer.files); });
    }
    async function send(text, opts) {
      opts = opts || {}; text = String(text || "").trim();
      const files = pending; pending = []; renderTray();
      if ((!text && !files.length) || working) { if (files.length) { pending = files; renderTray(); } return; }
      working = true; sendBtn.disabled = true; box.value = ""; autosize();
      userMsg(text, files, opts.from);
      const el = typing();
      await new Promise((r) => setTimeout(r, 250));
      let reply;
      try { reply = files.length ? await cfg.attach.send(files, text) : await respond(text); } catch (e) { console.error(e); reply = { text: "Something went wrong" + (e && e.message ? ": " + e.message : "") + ". Try again." }; }
      await aiMsg(el, reply);
      working = false; sendBtn.disabled = false;
    }
    function autosize() { box.style.height = "auto"; box.style.height = Math.min(160, box.scrollHeight) + "px"; }
    box.addEventListener("input", autosize);
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(box.value); } });
    form.addEventListener("submit", (e) => { e.preventDefault(); send(box.value); });
    host.querySelector(".chat-new").onclick = () => { mem.last = null; host.dispatchEvent(new CustomEvent("chat-reset")); welcome(); box.focus(); };
    let branded = null;
    function setStatus(text, state) { if (branded) return; statusEl.textContent = text; dot.className = "agentdot" + (state ? " " + state : ""); }
    const whoEl = host.querySelector(".chat-who b"), avatarEl = host.querySelector(".chat-head .chat-avatar"), footEl = host.querySelector(".chat-foot");
    const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';
    const base = { name: whoEl.textContent, avatar: avatarEl.innerHTML, foot: footEl.textContent };
    function setBrand(b) {
      branded = b || null; host.classList.toggle("claude-brand", !!b); curAvatar = b ? SPARK : BOLT;
      box.placeholder = b ? (b.placeholder || "Ask Claude…") : cfg.placeholder;
      box.setAttribute("aria-label", b ? "Ask Claude" : "Message Fast Edit AI"); log.setAttribute("aria-label", b ? "Conversation with Claude" : "Conversation with Fast Edit AI");
      host.querySelectorAll(".msg.ai .chat-avatar").forEach((a) => (a.innerHTML = curAvatar));
      whoEl.textContent = b ? b.name : base.name; avatarEl.innerHTML = b ? SPARK : base.avatar; footEl.textContent = b ? b.foot : base.foot;
      if (b) { statusEl.textContent = b.status; dot.className = "agentdot ok"; } else { statusEl.textContent = "Ready · on your device"; dot.className = "agentdot ok"; }
      if (log.children.length <= 1) welcome(); // still just the greeting: say it in the right voice
    }
    function note(text) {
      const n = document.createElement("div"); n.className = "msg-note"; n.textContent = text;
      const typ = log.querySelector(".msg.ai:last-child .typing"), anchor = typ && typ.closest(".msg");
      if (anchor) log.insertBefore(n, anchor); else log.append(n); scroll();
    }
    welcome();
    const api = { send, setStatus, welcome, mem, cfg, attach: (files) => addPending(files), setBrand, note, run: (t) => respond(t, true), host };
    chats[cfg.mode] = api;
    return api;
  }

  window.FEChat = { mount, get: (mode) => chats[mode] };
})();
