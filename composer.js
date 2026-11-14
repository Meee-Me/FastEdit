/*
 * Fast Edit composer: original, royalty-free music made on your device.
 * Drums, bass, chords and a melody are synthesised from oscillators and noise
 * for a mood and length, with an intro, a main section, a break and an ending.
 * What it makes is yours to use anywhere.
 */
(function () {
  "use strict";
  const rngFrom = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
  const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

  const MOODS = {
    upbeat: { name: "Upbeat pop", bpm: 118, key: 62, minor: false, prog: [0, 7, 9, 5], drums: "pop", lead: "pluck", pad: "saw", words: ["Bright", "Sunny", "Golden", "Weekend", "Good"] },
    chill: { name: "Chill lo-fi", bpm: 82, key: 57, minor: false, prog: [0, 9, 2, 7], seventh: true, drums: "lofi", lead: "keys", pad: "soft", words: ["Slow", "Coffee", "Late", "Rainy", "Soft"] },
    cinematic: { name: "Cinematic", bpm: 72, key: 50, minor: true, prog: [0, 8, 3, 10], drums: "epic", lead: "strings", pad: "strings", words: ["Rising", "Distant", "Northern", "Last", "Silent"] },
    energetic: { name: "Energetic", bpm: 128, key: 57, minor: true, prog: [0, 8, 3, 10], drums: "edm", lead: "saw", pad: "saw", words: ["Neon", "Rush", "Electric", "Night", "Wild"] },
    happy: { name: "Happy acoustic", bpm: 108, key: 60, minor: false, prog: [0, 5, 7, 5], drums: "light", lead: "pluck", pad: "soft", words: ["Sunday", "Picnic", "Little", "Morning", "Happy"] },
    dreamy: { name: "Dreamy ambient", bpm: 66, key: 64, minor: false, prog: [0, 4, 9, 5], seventh: true, drums: "none", lead: "bell", pad: "soft", words: ["Floating", "Cloud", "Velvet", "Ocean", "Quiet"] },
  };
  const NOUNS = ["Drive", "Days", "Lights", "Hour", "Dreams", "Waves", "Road", "Skies", "Story", "Echoes"];

  function chordNotes(root, minor, seventh) { const third = minor ? 3 : 4, fifth = 7; const n = [root, root + third, root + fifth]; if (seventh) n.push(root + (minor ? 10 : 11)); return n; }
  function scale(minor) { return minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]; }

  async function compose({ mood = "upbeat", seconds = 30, seed } = {}) {
    const M = MOODS[mood] || MOODS.upbeat, r = rngFrom(seed ?? (Date.now() & 0xffffffff));
    const sr = 44100, spb = 60 / M.bpm, bar = spb * 4;
    const bars = Math.max(4, Math.ceil(seconds / bar)), len = Math.min(seconds, bars * bar) + 1.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
    const master = ctx.createGain(); master.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3; master.connect(comp); comp.connect(ctx.destination);
    // light reverb from a decaying noise impulse
    const ir = ctx.createBuffer(2, sr * 1.8, sr); for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / d.length, 3); }
    const verb = ctx.createConvolver(); verb.buffer = ir; const wet = ctx.createGain(); wet.gain.value = M.drums === "none" || mood === "cinematic" ? 0.45 : 0.18; verb.connect(wet); wet.connect(master);
    const noise = ctx.createBuffer(1, sr, sr); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
    const bus = (g, rev) => { const n = ctx.createGain(); n.gain.value = g; n.connect(master); if (rev) { const s = ctx.createGain(); s.gain.value = rev; n.connect(s); s.connect(verb); } return n; };
    const drumBus = bus(0.9, 0.05), bassBus = bus(0.55), padBus = bus(0.22, 0.6), leadBus = bus(0.28, 0.5);

    const env = (g, t, a, d, peak, sus = 0) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sus || 0.0001), t + a + d); };
    function tone(type, f, t, dur, out, peak = 0.5, a = 0.01, detune = 0, cutoff) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune;
      const g = ctx.createGain(); let node = o;
      if (cutoff) { const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = cutoff; o.connect(fl); node = fl; }
      node.connect(g); g.connect(out); env(g, t, a, dur, peak); o.start(t); o.stop(t + a + dur + 0.05);
    }
    function kick(t, v = 1) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); o.connect(g); g.connect(drumBus); env(g, t, 0.003, 0.32, 0.95 * v); o.start(t); o.stop(t + 0.4); }
    function hit(t, hp, dur, v, bp) { const s = ctx.createBufferSource(); s.buffer = noise; const f = ctx.createBiquadFilter(); f.type = bp ? "bandpass" : "highpass"; f.frequency.value = hp; const g = ctx.createGain(); s.connect(f); f.connect(g); g.connect(drumBus); env(g, t, 0.002, dur, v); s.start(t, r() * 0.5); s.stop(t + dur + 0.05); }
    const snare = (t, v = 0.5) => { hit(t, 1800, 0.16, v, true); tone("triangle", 190, t, 0.08, drumBus, v * 0.5); };
    const hat = (t, v = 0.18) => hit(t, 8000, 0.04, v);

    const sc = scale(M.minor);
    let melodyDeg = 4;
    for (let b = 0; b < bars; b++) {
      const t0 = b * bar, chordRoot = M.key + M.prog[b % M.prog.length] - 12, notes = chordNotes(chordRoot, M.minor && [0, 5, 7].includes(M.prog[b % M.prog.length] % 12) ? true : M.minor && M.prog[b % M.prog.length] === 0, M.seventh);
      const section = b < 2 ? "intro" : b >= bars - 2 ? "outro" : b % 8 >= 6 ? "break" : "main";
      // pads
      const padType = M.pad === "saw" ? "sawtooth" : M.pad === "strings" ? "sawtooth" : "triangle";
      for (const n of notes) for (const d of [-7, 7]) tone(padType, NOTE(n + 12), t0, bar * 0.95, padBus, section === "intro" ? 0.18 : 0.26, M.pad === "strings" ? 0.6 : 0.08, d, M.pad === "soft" ? 1400 : M.pad === "strings" ? 1800 : 2600);
      // bass
      if (section !== "intro") {
        const pattern = M.drums === "edm" ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] : M.drums === "lofi" ? [0, 1.5, 2.5] : [0, 1, 2, 3];
        for (const p of pattern) tone(M.drums === "edm" ? "sawtooth" : "triangle", NOTE(chordRoot - 12), t0 + p * spb, spb * 0.45, bassBus, 0.55, 0.005, 0, M.drums === "edm" ? 600 : 900);
      }
      // drums
      if (M.drums !== "none" && section !== "intro") {
        for (let beat = 0; beat < 4; beat++) {
          const t = t0 + beat * spb, lofiSwing = M.drums === "lofi" ? spb * 0.08 : 0;
          if (M.drums === "edm" || M.drums === "pop") kick(t); else if (beat === 0 || (beat === 2 && M.drums !== "epic")) kick(t, 0.9);
          if (M.drums === "epic" && (beat === 0 || beat === 3)) { kick(t, 1); tone("sine", 70, t, 0.6, drumBus, 0.7); }
          if ((beat === 1 || beat === 3) && M.drums !== "epic" && section !== "break") snare(t + lofiSwing, M.drums === "lofi" ? 0.35 : 0.5);
          if (M.drums !== "epic") { hat(t + spb / 2 + lofiSwing, M.drums === "edm" ? 0.22 : 0.14); if (M.drums !== "lofi") hat(t, 0.08); }
        }
      }
      // melody: a stepwise line on chord tones and scale steps
      if (section === "main" || section === "outro") {
        const steps = M.bpm > 100 ? 8 : 4;
        for (let s = 0; s < steps; s++) {
          if (r() < (M.lead === "bell" ? 0.45 : 0.3)) continue;
          melodyDeg = Math.max(0, Math.min(9, melodyDeg + Math.round((r() - 0.5) * 3)));
          const deg = melodyDeg, n = M.key + sc[deg % 7] + 12 * Math.floor(deg / 7) + 12, t = t0 + (s * bar) / steps, dur = (bar / steps) * (M.lead === "strings" ? 1.6 : 0.8);
          const type = { pluck: "triangle", keys: "sine", strings: "sawtooth", saw: "square", bell: "sine" }[M.lead];
          tone(type, NOTE(n), t, dur, leadBus, M.lead === "saw" ? 0.18 : 0.32, M.lead === "strings" ? 0.12 : 0.005, 0, M.lead === "strings" ? 2400 : M.lead === "saw" ? 3200 : undefined);
          if (M.lead === "bell") tone("sine", NOTE(n + 12), t, dur * 1.5, leadBus, 0.1);
        }
      }
    }
    // ending fade
    const end = Math.min(seconds, bars * bar);
    master.gain.setValueAtTime(0.85, Math.max(0, end - 2)); master.gain.linearRampToValueAtTime(0, end + 1.2);
    const buf = await ctx.startRendering();
    const title = `${M.words[Math.floor(r() * M.words.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]}`;
    return { buffer: buf, title, mood, moodName: M.name, bpm: M.bpm, seconds: end };
  }

  function toWav(buffer) {
    const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
    return new Blob([out.buffer], { type: "audio/wav" });
  }

  async function composeFile(opts) {
    const r = await compose(opts);
    const file = new File([toWav(r.buffer)], `${r.title} (Fast Edit original).wav`, { type: "audio/wav" });
    return { ...r, file };
  }
  // A mood that suits a picture, from Fast Edit AI's image analysis.
  function moodFor(A) {
    if (!A) return "upbeat";
    if (A.mean < 0.3) return A.colorfulness > 0.35 ? "energetic" : "cinematic";
    if (A.colorfulness < 0.18) return "chill";
    if (A.castTemp > 0.04) return "happy";
    return A.mean > 0.55 ? "upbeat" : "dreamy";
  }

  window.FastComposer = { compose, composeFile, toWav, moodFor, MOODS };
})();
