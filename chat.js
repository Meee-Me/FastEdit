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
    function userMsg(text) { clearChips(); const m = document.createElement("div"); m.className = "msg user"; m.textContent = text; log.append(m); scroll(); }
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
    async function send(text) {
      text = String(text || "").trim();
      if (!text || working) return;
      working = true; sendBtn.disabled = true; box.value = ""; autosize();
      userMsg(text);
      const el = typing();
      await new Promise((r) => setTimeout(r, 250));
      let reply;
      try { reply = await respond(text); } catch (e) { console.error(e); reply = { text: "Something went wrong. Try again." }; }
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
    const api = { send, setStatus, welcome, mem };
    chats[cfg.mode] = api;
    return api;
  }

  window.FEChat = { mount, get: (mode) => chats[mode] };
})();
