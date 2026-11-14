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
  const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5 13.5h5.5L9 22l9.5-12.5H13z" fill="currentColor"/></svg>';

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
    function userMsg(text, files) {
      clearChips(); const m = document.createElement("div"); m.className = "msg user";
      if (files && files.length) { const f = document.createElement("div"); f.className = "msg-files"; for (const x of files) { const c = document.createElement("span"); c.className = "file-chip"; c.textContent = fileLabel(x); f.append(c); } m.append(f); }
      if (text) { const t = document.createElement("div"); t.textContent = text; m.append(t); }
      log.append(m); scroll();
    }
    function typing() { const m = document.createElement("div"); m.className = "msg ai"; m.innerHTML = `<span class="chat-avatar sm">${BOLT}</span><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div>`; log.append(m); scroll(); return m; }
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
      const el = document.createElement("div"); el.className = "msg ai"; el.innerHTML = `<span class="chat-avatar sm">${BOLT}</span><div class="msg-body"></div>`; log.append(el);
      aiMsg(el, { text: cfg.welcome, chips: cfg.starters });
    }

    async function respond(text) {
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
    async function send(text) {
      text = String(text || "").trim();
      const files = pending; pending = []; renderTray();
      if ((!text && !files.length) || working) { if (files.length) { pending = files; renderTray(); } return; }
      working = true; sendBtn.disabled = true; box.value = ""; autosize();
      userMsg(text, files);
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
    host.querySelector(".chat-new").onclick = () => { mem.last = null; welcome(); box.focus(); };
    function setStatus(text, state) { statusEl.textContent = text; dot.className = "agentdot" + (state ? " " + state : ""); }
    welcome();
    const api = { send, setStatus, welcome, mem, cfg, attach: (files) => addPending(files) };
    chats[cfg.mode] = api;
    return api;
  }

  window.FEChat = { mount, get: (mode) => chats[mode] };
})();
