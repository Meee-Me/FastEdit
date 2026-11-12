/*
 * Fast Edit + Deluxe Main.
 * "Sign in with Deluxe Main" in the top bar, and My looks (saved adjustments)
 * kept in your Deluxe account when you're signed in, or in this browser as a
 * guest. A guest's looks move into the account when they sign in.
 */
(function () {
  "use strict";
  const $$ = (s) => [...document.querySelectorAll(s)];
  const D = window.Deluxe || null;
  const LOCAL = "fastedit.looks.v1", MAX = 40;
  let looks = [], user = null, busy = false;

  const readLocal = () => { try { const v = JSON.parse(localStorage.getItem(LOCAL) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const writeLocal = (v) => { try { localStorage.setItem(LOCAL, JSON.stringify(v || [])); } catch {} };
  const valid = (l) => l && typeof l.id === "string" && typeof l.name === "string" && l.adj && typeof l.adj === "object";

  async function load(u) {
    user = u || null;
    if (!user) { looks = readLocal().filter(valid); render(); return; }
    busy = true; render();
    try {
      const saved = await D.data.get("looks");
      let list = Array.isArray(saved) ? saved.filter(valid) : [];
      const guest = readLocal().filter(valid);
      const extra = guest.filter((g) => !list.some((l) => l.id === g.id));
      if (extra.length) {
        list = [...extra, ...list].slice(0, MAX);
        await D.data.put("looks", list);
        FE.toast(`Moved ${extra.length} look${extra.length > 1 ? "s" : ""} from this browser into your Deluxe account`);
      }
      writeLocal([]);
      looks = list;
    } catch (e) {
      looks = readLocal().filter(valid);
      FE.toast("Couldn't load your looks from Deluxe Main. Showing the ones in this browser.");
    }
    busy = false; render();
  }
  async function persist() {
    if (user) {
      try { await D.data.put("looks", looks); return true; }
      catch (e) { FE.toast("Couldn't save to your Deluxe account: " + e.message); return false; }
    }
    writeLocal(looks); return true;
  }
  const getAdj = (mode) => (mode === "video" ? window.FEVideo && window.FEVideo.getAdj() : FE.getAdj()) || {};
  const apply = (mode, adj) => (mode === "video" ? window.FEVideo && window.FEVideo.applyLook(adj) : FE.applyLook(adj));

  async function save(mode, input) {
    const adj = getAdj(mode);
    if (!Object.values(adj).some((v) => v)) return FE.toast("Change some adjustments first, then save them as a look");
    const name = (input.value.trim() || `Look ${looks.length + 1}`).slice(0, 40);
    looks = [{ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name, adj, at: Date.now() }, ...looks].slice(0, MAX);
    input.value = "";
    render();
    if (await persist()) FE.toast(user ? `Saved “${name}” to your Deluxe account` : `Saved “${name}” in this browser`);
  }
  async function forget(id) {
    const l = looks.find((x) => x.id === id);
    looks = looks.filter((x) => x.id !== id); render();
    if ((await persist()) && l) FE.toast(`Deleted “${l.name}”`);
  }

  function render() {
    for (const box of $$(".looks")) {
      const mode = box.dataset.looks;
      box.innerHTML = "";
      const head = document.createElement("div"); head.className = "looks-head";
      const h = document.createElement("div"); h.className = "label"; h.textContent = "My looks";
      const count = document.createElement("span"); count.className = "looks-note"; count.textContent = busy ? "Loading…" : looks.length ? `${looks.length} saved` : "";
      head.append(h, count);
      const list = document.createElement("div"); list.className = "looks-list";
      if (!looks.length && !busy) { const e = document.createElement("span"); e.className = "looks-note"; e.textContent = "Save your adjustments as a look to reuse them on any photo or video."; list.append(e); }
      for (const l of looks) {
        const chip = document.createElement("span"); chip.className = "look";
        const b = document.createElement("button"); b.type = "button"; b.textContent = l.name; b.title = "Apply " + l.name;
        b.onclick = () => { apply(mode, l.adj); FE.toast(`Applied “${l.name}”`); };
        const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "×"; x.setAttribute("aria-label", "Delete " + l.name);
        x.onclick = () => forget(l.id);
        chip.append(b, x); list.append(chip);
      }
      const row = document.createElement("div"); row.className = "looks-save";
      const input = document.createElement("input"); input.type = "text"; input.id = "lookName-" + mode; input.placeholder = "Name this look"; input.maxLength = 40; input.setAttribute("aria-label", "Look name");
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(mode, input); } });
      const go = document.createElement("button"); go.className = "btn sm"; go.type = "button"; go.textContent = "Save current look"; go.onclick = () => save(mode, input);
      row.append(input, go);
      const note = document.createElement("div"); note.className = "looks-note";
      if (user) note.textContent = `Saved to your Deluxe account (${user.name}), on every device.`;
      else if (D) {
        note.append("Saved in this browser. ");
        const s = document.createElement("button"); s.type = "button"; s.textContent = "Sign in with Deluxe Main"; s.onclick = () => D.signIn();
        note.append(s, " to keep them on every device.");
      } else note.textContent = "Saved in this browser.";
      box.append(head, list, row, note);
    }
  }

  render();
  if (!D) { load(null); return; }
  D.button(document.getElementById("deluxeAccount"), { background: "#f0a43a", color: "#1b1306" });
  D.ready.then(load, () => load(null));
  D.onChange((u) => { if ((u && u.id) !== (user && user.id)) load(u); });
})();
