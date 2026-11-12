/*
 * Fast Edit AI — built from scratch, runs entirely in the browser.
 *
 *  1. Language model: a small neural network (hashed word + character-trigram features
 *     -> 48 tanh units -> softmax over edit intents). Written by hand, trained on this
 *     device at page load from a generated phrase set. No external model or service.
 *  2. Vision: image statistics (exposure, contrast, clipping, gray-world color cast,
 *     colorfulness), k-means palette, frequency-tuned saliency (where the eye goes),
 *     brightest light source, horizon line, sky detection.
 *  3. Planner: turns the understood intents + the analysis into concrete edits
 *     (adjustments, smart crops, rotations, background removal, generated layers).
 *  4. Generators: procedural artwork (stars, birds, flares, frames, captions, ...)
 *     placed using the analysis so it fits the photo.
 */
(function (global) {
  "use strict";

  /* ================= utilities ================= */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function mk(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function rngFrom(seed) { let s = (seed >>> 0) || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function hashStr(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function downsample(src, maxSide) {
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = mk(src.width * s, src.height * s);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function boxBlur(arr, w, h, r) {
    const tmp = new Float32Array(arr.length), out = new Float32Array(arr.length);
    for (let y = 0; y < h; y++) { let acc = 0, cnt = 0; const row = y * w;
      for (let x = -r; x < w; x++) { const add = x + r; if (add < w) { acc += arr[row + add]; cnt++; } const rem = x - r - 1; if (rem >= 0) { acc -= arr[row + rem]; cnt--; } if (x >= 0) tmp[row + x] = acc / cnt; } }
    for (let x = 0; x < w; x++) { let acc = 0, cnt = 0;
      for (let y = -r; y < h; y++) { const add = y + r; if (add < h) { acc += tmp[add * w + x]; cnt++; } const rem = y - r - 1; if (rem >= 0) { acc -= tmp[rem * w + x]; cnt--; } if (y >= 0) out[y * w + x] = acc / cnt; } }
    return out;
  }
  function srgbToLab(r, g, b) {
    const lin = (c) => { c /= 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
    const R = lin(r), G = lin(g), B = lin(b);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), fy = f(R * 0.2126 + G * 0.7152 + B * 0.0722), fz = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function colorName(c) {
    const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
    if (l < 0.12) return "black"; if (l > 0.9 && s < 0.3) return "white";
    if (s < 0.14) return l < 0.45 ? "charcoal" : "silver";
    const names = [[15, "red"], [38, "orange"], [52, "amber"], [68, "yellow"], [90, "lime"], [150, "green"], [180, "teal"], [200, "cyan"], [235, "blue"], [260, "indigo"], [290, "violet"], [330, "magenta"], [345, "pink"], [361, "red"]];
    for (const [lim, n] of names) if (h < lim) return n;
    return "red";
  }
  const css = (c, a = 1) => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
  const brighten = (c, k) => ({ r: clamp(c.r + (255 - c.r) * k, 0, 255), g: clamp(c.g + (255 - c.g) * k, 0, 255), b: clamp(c.b + (255 - c.b) * k, 0, 255) });
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ================= 1. language model ================= */
  const D = 2048, H = 48;
  const INTENTS = {
    auto_enhance: ["auto enhance", "enhance", "make it look better", "improve this photo", "fix it", "auto fix", "make this look professional", "auto adjust", "optimize the photo", "improve", "fix the photo", "make it nicer", "touch it up", "polish it", "make it look good", "one click fix", "best look", "make it better"],
    brighten: ["brighter", "brighten", "more light", "lighten it", "increase exposure", "too dark", "make it lighter", "raise exposure", "more exposure", "brighten the image", "it is too dark", "boost brightness", "lighter", "less dark", "underexposed", "light it up"],
    darken: ["darker", "darken", "too bright", "less light", "lower exposure", "reduce brightness", "decrease exposure", "make it darker", "dim it", "less exposure", "overexposed", "less bright", "tone it down darker"],
    contrast_up: ["more contrast", "increase contrast", "punchier", "add contrast", "boost contrast", "higher contrast", "make it punchy", "crisper tones", "stronger contrast", "deeper blacks", "contrast", "pop", "make it pop", "high contrast"],
    contrast_down: ["less contrast", "lower contrast", "reduce contrast", "flatter", "softer contrast", "decrease contrast", "too harsh", "flat look", "low contrast", "softer tones"],
    warmer: ["warmer", "warm it up", "more warm", "add warmth", "warmer tones", "more orange", "more yellow", "too cold", "too blue", "heat it up", "warm", "cozy tones", "less cool", "warm colors", "warmth", "sunnier colors"],
    cooler: ["cooler", "cool it down", "colder", "more blue", "less warm", "too warm", "too yellow", "too orange", "cool tones", "icy", "cold look", "cool", "chilly tones", "blue tint"],
    saturate: ["more saturation", "more colorful", "more vivid", "saturate", "boost colors", "vibrant", "richer colors", "pop the colors", "colors pop", "more color", "increase saturation", "vivid", "saturated", "brighter colors", "intense colors"],
    desaturate: ["less saturation", "desaturate", "muted colors", "less colorful", "tone down colors", "washed out look", "reduce saturation", "subtle colors", "pastel", "less color", "muted", "dull the colors", "soft colors"],
    black_white: ["blackwhite", "monochrome", "grayscale", "greyscale", "blackwhite photo", "no color", "bw", "noir", "mono", "remove all color", "colorless", "blackwhite high contrast"],
    sepia: ["sepia", "old photo", "antique", "aged photo", "old fashioned", "brown tone", "historic look", "1900s photo", "sepia tone"],
    vintage: ["vintage", "retro", "film look", "analog", "faded film", "70s look", "nostalgic", "film photo", "old film", "faded", "retro film", "warm film", "analog film look", "matte look"],
    cinematic: ["cinematic", "movie look", "tealorange", "film grade", "hollywood look", "blockbuster", "cinema", "color grade like a movie", "cinematic grade", "movie still"],
    moody: ["moody", "dramatic", "dark and moody", "atmospheric", "gloomy", "intense mood", "brooding", "drama", "stormy mood", "dark mood", "mysterious"],
    golden_hour: ["golden hour", "sunset glow", "golden light", "sunny glow", "warm glow", "evening light", "magic hour", "golden", "sun glow", "golden hour glow", "warm sunlight"],
    vignette_add: ["vignette", "add vignette", "darken edges", "darker corners", "dark edges", "edge darkening", "frame the subject with shadow", "subtle vignette", "add a vignette", "dark corners"],
    vignette_remove: ["remove vignette", "no vignette", "less vignette", "brighten corners", "lighter edges", "lighter corners", "get rid of the vignette"],
    grain_add: ["grain", "add grain", "film grain", "noise", "grainy", "texture", "add noise", "gritty", "add film grain"],
    grain_remove: ["remove grain", "less grain", "no grain", "denoise", "smooth noise", "clean noise", "reduce noise", "remove noise"],
    sharpen: ["sharpen", "sharper", "more detail", "crisp", "crisper", "clarity", "more defined", "in focus", "enhance details", "sharp", "make it sharp", "detail"],
    soften: ["blur", "soften", "softer", "soft focus", "blurry", "smooth it", "haze", "gaussian blur", "blur it", "out of focus", "make it soft"],
    shadows_up: ["lift shadows", "brighten shadows", "open shadows", "more shadow detail", "shadows brighter", "raise shadows", "recover shadows", "lift the shadows", "see into the shadows"],
    highlights_down: ["recover highlights", "tone down highlights", "less highlights", "reduce highlights", "blown out", "highlights too bright", "save the sky", "bring back sky", "lower highlights", "the sky is too bright"],
    fix_color: ["white balance", "fix colors", "color cast", "neutral colors", "correct colors", "remove tint", "fix white balance", "colors look off", "auto color", "balance colors", "fix the color", "too green", "realistic colors", "natural colors"],
    crop_smart: ["crop", "better composition", "crop it", "recompose", "crop to subject", "tighter crop", "zoom in on subject", "rule of thirds", "stronger composition", "improve framing", "reframe", "crop to a stronger composition", "fix composition", "smart crop"],
    crop_ratio: ["vertical for tiktok", "make it vertical", "for instagram reels", "youtube shorts format", "tiktok format", "for my story", "make it widescreen", "reel format", "square", "make it square", "instagram square", "portrait crop", "crop to 4 5", "story format", "widescreen", "crop 16 9", "landscape crop", "vertical crop", "crop to ratio", "9 16", "cinema crop", "1 1", "3 2 crop", "phone wallpaper"],
    rotate: ["rotate", "rotate left", "rotate right", "turn it", "rotate 90", "upside down", "rotate 180", "turn sideways", "rotate clockwise", "rotate counterclockwise", "turn it left", "turn it right"],
    flip: ["flip", "mirror", "flip horizontal", "flip vertical", "mirror image", "reverse it", "flip it", "flip upside", "mirror it"],
    add_text: ["add text", "add a caption", "caption", "write", "title", "add title", "put text", "add words", "label it", "text that says", "add a quote", "headline", "watermark", "add a fitting caption", "write something", "add a title in elegant type", "words on it", "typography"],
    frame: ["frame", "border", "add a border", "white border", "polaroid", "add frame", "film border", "picture frame", "matte border", "hand drawn frame", "draw a frame", "black border", "outline"],
    light_leak: ["light leak", "lens leak", "film leak", "leak", "warm leak", "color leak", "light leaks", "soft light leak"],
    glow: ["glow", "bloom", "dreamy glow", "soft glow", "halo", "shine", "radiant", "glowing light", "orton effect", "dreamy", "ethereal"],
    flare: ["lens flare", "flare", "sun flare", "sunburst", "light flare", "sun rays", "flare over the light", "anamorphic flare"],
    stars: ["stars", "starry sky", "add stars", "night sky", "starfield", "twinkling stars", "constellations", "milky way", "starry night"],
    birds: ["birds", "flock of birds", "add birds", "seagulls", "flying birds", "bird silhouettes", "crows", "geese", "a flock in the sky", "bird"],
    sparkles: ["sparkles", "glitter", "twinkles", "magic sparkles", "sparkle", "shimmer", "fairy dust", "shiny bits", "sparkles around the light", "glints"],
    snow: ["snow", "snowfall", "snowing", "snowflakes", "winter flakes", "blizzard", "make it snow", "falling snow"],
    rain: ["rain", "raining", "rainfall", "drizzle", "storm rain", "rain drops", "make it rain", "rainy", "rainstorm"],
    bokeh: ["bokeh", "bokeh lights", "light orbs", "fairy lights", "blurred lights", "orbs", "circles of light", "city lights blur"],
    confetti: ["confetti", "party", "celebration", "streamers", "festive", "birthday", "party confetti", "celebrate"],
    hearts: ["hearts", "love", "romantic", "valentine", "heart shapes", "love hearts", "floating hearts"],
    moon: ["moon", "add a moon", "crescent moon", "full moon", "moonlight", "lunar", "a moon in the sky"],
    sunset_stripes: ["sunset stripes", "retro stripes", "70s stripes", "rainbow stripes", "stripes overlay", "retro sunset", "synthwave", "vaporwave", "outrun", "stripes", "retro sun"],
    clouds: ["clouds", "add clouds", "fluffy clouds", "cloudy sky", "mist", "fog", "foggy", "misty", "haze over the horizon", "low fog"],
    remove_bg: ["remove background", "remove the background", "cut out", "background removal", "transparent background", "isolate subject", "delete background", "erase background", "cutout", "extract subject", "no background", "remove bg"],
    reset: ["reset", "start over", "undo everything", "remove all edits", "original look", "clear adjustments", "revert", "go back to original", "reset adjustments"],
    critique: ["critique", "feedback", "what do you think", "review my photo", "how can i improve", "rate it", "analyze", "suggestions", "any tips", "is it good", "rate my photo", "critique this image", "give me feedback"],
    trim_start: ["trim the first 3 seconds", "cut the first 2 seconds", "remove the beginning", "cut the intro", "trim the start", "skip the first 5 seconds", "start later", "remove the first second", "trim the beginning by 2 seconds", "cut off the start", "delete the first 4 seconds"],
    trim_end: ["trim the last 3 seconds", "cut the last 2 seconds", "remove the ending", "cut the outro", "trim the end", "end earlier", "remove the last second", "cut off the end", "delete the last 4 seconds", "stop earlier"],
    shorten: ["make it 15 seconds", "shorten to 10 seconds", "keep the first 10 seconds", "keep only 5 to 12 seconds", "make it shorter", "cut it down to 30 seconds", "max 20 seconds long", "keep from 3 to 8 seconds", "only keep the middle part", "shorten it", "make the video shorter"],
    slow_down: ["slow motion", "slow it down", "half speed", "0 5x", "slower", "slow mo", "play slower", "quarter speed", "slowmo", "slow down the video"],
    speed_up: ["speed up", "faster", "timelapse", "make it a timelapse", "time lapse", "turn it into a timelapse", "2x speed", "double speed", "play faster", "fast forward", "hyperlapse", "3x", "speed it up", "make the video faster"],
    normal_speed: ["normal speed", "reset speed", "1x", "real time speed", "original speed", "regular speed"],
    mute: ["mute", "remove audio", "no sound", "silent", "mute the audio", "turn off sound", "remove the sound", "kill the audio", "without sound", "mute it"],
    unmute: ["unmute", "turn sound on", "restore audio", "bring back the sound", "with sound", "audio on", "keep the audio", "turn the sound back on"],
    scene_split: ["split scenes", "detect scenes", "cut at scene changes", "split into shots", "find the cuts", "split at scene changes", "scene detection", "separate the shots", "break into scenes", "split it up by scene"],
    fade_in: ["fade in", "fade from black", "start with a fade", "fade in at the start", "open with a fade", "fade in from black"],
    fade_out: ["fade out", "fade to black", "end with a fade", "fade out at the end", "close with a fade", "fade out to black"],
    reframe: ["follow the subject", "track the subject", "keep the subject centered", "auto reframe", "smart reframe", "keep them in frame", "reframe", "center the subject", "follow the action", "track the person"],
    unknown: ["hello", "hi there", "how are you", "what is the weather", "hows the weather today", "what day is it", "tell me about yourself", "where am i", "tell me a joke", "who are you", "asdf", "qwerty", "banana", "ok", "thanks", "write code", "what time is it", "play music", "order pizza", "lorem ipsum", "the meaning of life", "send an email", "book a flight", "yes", "no", "cat", "dog"],
  };
  const LABELS = Object.keys(INTENTS);
  const K = LABELS.length;
  const PRE = ["", "", "make it ", "can you ", "please ", "i want ", "could you ", "lets ", "try ", "id like ", "give it ", "now ", "maybe "];
  const SUF = ["", "", " please", " a bit", " for me", " now", " to the photo", " on this image", " thanks"];

  function normalize(t) {
    return String(t).toLowerCase()
      .replace(/\bb\s*[&\/]\s*w\b/g, " blackwhite ").replace(/black\s*(?:and|&|n)\s*white/g, " blackwhite ")
      .replace(/teal\s*(?:and|&)\s*orange/g, " tealorange ")
      .replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function featurize(text) {
    const words = normalize(text).split(" ").filter(Boolean);
    const m = new Map();
    const add = (key, v) => { const i = hashStr(key) % D; m.set(i, (m.get(i) || 0) + v); };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      add("w:" + w, 1);
      if (i + 1 < words.length) add("b:" + w + "_" + words[i + 1], 0.8);
      const p = "#" + w + "#";
      for (let j = 0; j + 3 <= p.length; j++) add("c:" + p.slice(j, j + 3), 0.35);
    }
    let norm = 0; for (const v of m.values()) norm += v * v; norm = Math.sqrt(norm) || 1;
    const idx = new Int32Array(m.size), val = new Float32Array(m.size); let k = 0;
    for (const [i, v] of m) { idx[k] = i; val[k] = v / norm; k++; }
    return { idx, val };
  }

  const net = { W1: null, b1: null, W2: null, b2: null, ready: false, stats: null };
  function initNet(r) {
    const s1 = Math.sqrt(6 / (60 + H)), s2 = Math.sqrt(6 / (H + K));
    net.W1 = new Float32Array(D * H).map(() => (r() * 2 - 1) * s1);
    net.b1 = new Float32Array(H);
    net.W2 = new Float32Array(H * K).map(() => (r() * 2 - 1) * s2);
    net.b2 = new Float32Array(K);
  }
  function forward(f, hOut) {
    const { W1, b1, W2, b2 } = net;
    const h = hOut || new Float32Array(H);
    for (let j = 0; j < H; j++) h[j] = b1[j];
    for (let n = 0; n < f.idx.length; n++) { const base = f.idx[n] * H, v = f.val[n]; for (let j = 0; j < H; j++) h[j] += v * W1[base + j]; }
    for (let j = 0; j < H; j++) h[j] = Math.tanh(h[j]);
    const z = new Float32Array(K); let mx = -Infinity;
    for (let k = 0; k < K; k++) { let s = b2[k]; for (let j = 0; j < H; j++) s += h[j] * W2[j * K + k]; z[k] = s; if (s > mx) mx = s; }
    let sum = 0; for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - mx); sum += z[k]; }
    for (let k = 0; k < K; k++) z[k] /= sum;
    return { h, p: z };
  }
  function trainStep(f, y, lr) {
    const { h, p } = forward(f);
    const { W1, b1, W2, b2 } = net;
    const dz = p; dz[y] -= 1;
    const dh = new Float32Array(H);
    for (let j = 0; j < H; j++) { let s = 0; const row = j * K; for (let k = 0; k < K; k++) { s += W2[row + k] * dz[k]; W2[row + k] -= lr * h[j] * dz[k]; } dh[j] = s * (1 - h[j] * h[j]); }
    for (let k = 0; k < K; k++) b2[k] -= lr * dz[k];
    for (let j = 0; j < H; j++) b1[j] -= lr * dh[j];
    for (let n = 0; n < f.idx.length; n++) { const base = f.idx[n] * H, v = f.val[n]; for (let j = 0; j < H; j++) W1[base + j] -= lr * v * dh[j]; }
    return p[y] > 0 ? -Math.log(Math.max(1e-9, 1 + dz[y])) : 0;
  }
  function buildDataset(r) {
    const data = [];
    LABELS.forEach((label, y) => {
      for (const phrase of INTENTS[label]) {
        data.push({ t: phrase, y });
        const variants = label === "unknown" ? 1 : 4;
        for (let v = 0; v < variants; v++) {
          let t = PRE[(r() * PRE.length) | 0] + phrase + SUF[(r() * SUF.length) | 0];
          if (r() < 0.25 && t.length > 6) { const i = 1 + ((r() * (t.length - 2)) | 0); t = t.slice(0, i) + t.slice(i + 1); } // typo
          data.push({ t, y });
        }
      }
    });
    return data.map((d) => ({ f: featurize(d.t), y: d.y }));
  }
  let readyPromise = null;
  function train(onProgress) {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      const t0 = performance.now();
      const r = rngFrom(20261112);
      initNet(r);
      const data = buildDataset(r);
      const EPOCHS = 28; let epoch = 0, i = 0, loss = 0;
      const order = data.map((_, k) => k);
      const shuffle = () => { for (let k = order.length - 1; k > 0; k--) { const j = (r() * (k + 1)) | 0; [order[k], order[j]] = [order[j], order[k]]; } };
      shuffle();
      const chunk = () => {
        const lr = 0.12 * Math.pow(0.9, epoch) + 0.01;
        const end = Math.min(order.length, i + 600);
        for (; i < end; i++) loss += trainStep(data[order[i]].f, data[order[i]].y, lr);
        if (i >= order.length) { epoch++; i = 0; shuffle(); if (epoch < EPOCHS) loss = 0; }
        onProgress && onProgress(Math.min(1, (epoch + i / order.length) / EPOCHS));
        if (epoch < EPOCHS) return setTimeout(chunk, 0);
        let correct = 0; for (const d of data) { const { p } = forward(d.f); let best = 0; for (let k = 1; k < K; k++) if (p[k] > p[best]) best = k; if (best === d.y) correct++; }
        net.ready = true;
        net.stats = { params: D * H + H + H * K + K, examples: data.length, intents: K - 1, epochs: EPOCHS, ms: Math.round(performance.now() - t0), accuracy: correct / data.length };
        resolve(net.stats);
      };
      setTimeout(chunk, 0);
    });
    return readyPromise;
  }
  function classify(text) {
    const { p } = forward(featurize(text));
    const ranked = LABELS.map((l, k) => ({ intent: l, p: p[k] })).sort((a, b) => b.p - a.p);
    return ranked;
  }

  /* ================= request parsing ================= */
  const FILLER = /^(?:it|this|that|the photo|the image|please|pls|thanks|thank you|now|also|then|some|a|an|the|me|for me|ok|okay)$/;
  function splitClauses(text) {
    const quotes = [];
    let t = String(text).replace(/["“”«»]([^"“”«»]{1,140})["“”«»]/g, (m, q) => { quotes.push(q.trim()); return ` QUOTE${quotes.length - 1} `; });
    t = t.replace(/(\d)\s*(?:s|sec\w*)?\s+and\s+(\d)/gi, "$1 to $2");
    t = t.replace(/black\s*(?:and|&|n)\s*white/gi, "blackwhite").replace(/teal\s*(?:and|&)\s*orange/gi, "tealorange").replace(/\bb\s*[&\/]\s*w\b/gi, "blackwhite");
    const parts = t.split(/\s*(?:[,;.!?]+|\band then\b|\bthen\b|\band also\b|\balso\b|\bplus\b|\band\b|\bwith\b|\+|&)\s*/i).map((s) => s.trim()).filter(Boolean);
    return { quotes, clauses: parts.map((p) => ({ text: p.replace(/QUOTE\d+/g, " ").replace(/\s+/g, " ").trim(), quote: (p.match(/QUOTE(\d+)/) || [])[1] })) };
  }
  function intensityOf(c) {
    if (/\b(slightly|a bit|a little|a touch|subtle|subtly|little|tiny|gently|gentle|bit|soft|light)\b/i.test(c)) return 0.5;
    if (/\b(extremely|max|maximum|super|hugely|insanely|massively)\b/i.test(c)) return 2;
    if (/\b(very|much|lot|lots|really|way|strong|strongly|heavy|heavily|significantly|tons|more)\b/i.test(c)) return 1.5;
    return 1;
  }
  const COLOR_WORDS = { white: "#ffffff", black: "#111111", red: "#e23b3b", orange: "#ff8a2b", yellow: "#ffd23f", gold: "#f2c14e", green: "#3fbf6b", teal: "#1fb5a6", blue: "#3b82f6", navy: "#1e2a5a", purple: "#8b5cf6", violet: "#8b5cf6", pink: "#ff6fae", magenta: "#e0349b", cream: "#f6eedc", gray: "#9aa0a6", grey: "#9aa0a6", silver: "#c9ced6" };
  function colorIn(c) { const m = String(c).toLowerCase().match(/\b(white|black|red|orange|yellow|gold|green|teal|blue|navy|purple|violet|pink|magenta|cream|gray|grey|silver)\b/); return m ? COLOR_WORDS[m[1]] : null; }
  function ratioIn(c) {
    const s = String(c).toLowerCase();
    const m = s.match(/(\d{1,2})\s*(?:[:x×\/]|by|\s)\s*(\d{1,2})/);
    if (m && +m[1] > 0 && +m[2] > 0) return +m[1] / +m[2];
    if (/square|1 1|instagram post/.test(s)) return 1;
    if (/story|wallpaper|phone|vertical|tiktok|reel/.test(s)) return 9 / 16;
    if (/portrait/.test(s)) return 4 / 5;
    if (/widescreen|cinema|panorama|banner|youtube/.test(s)) return 16 / 9;
    if (/landscape/.test(s)) return 3 / 2;
    return null;
  }
  function textFromRequest(full, quotes) {
    if (quotes.length) return quotes[0];
    const m = String(full).match(/\b(?:that says|saying|which says|says|that reads|reading|with the words|with the text|text|caption|title)\s*[:\-]?\s+(.{1,80})$/i);
    if (m && !/^(?:that|which|in|on|at|to|for|the photo|this)\b/i.test(m[1])) return m[1].replace(/\s+(?:in|at|on)\s+(?:the\s+)?(?:top|bottom|center|middle|corner)\b.*$/i, "").trim();
    return null;
  }

  /* ================= 2. vision ================= */
  function analyze(src) {
    const sm = downsample(src, 160), w = sm.width, h = sm.height, n = w * h;
    const d = sm.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const lum = new Float32Array(n), La = new Float32Array(n), Aa = new Float32Array(n), Ba = new Float32Array(n), alpha = new Float32Array(n);
    const hist = new Float64Array(256);
    let wsum = 0, sr = 0, sg = 0, sb = 0, msum = 0, mr = 0, mg = 0, mb = 0, ssat = 0, rgS = 0, ybS = 0, rgS2 = 0, ybS2 = 0;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3] / 255;
      alpha[i] = a;
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; lum[i] = l;
      const lab = srgbToLab(r, g, b); La[i] = lab[0]; Aa[i] = lab[1]; Ba[i] = lab[2];
      if (a < 0.05) continue;
      wsum += a; sr += r * a; sg += g * a; sb += b * a; hist[Math.min(255, (l * 255) | 0)] += a;
      if (l > 0.12 && l < 0.88) { msum += a; mr += r * a; mg += g * a; mb += b * a; }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b); ssat += (mx ? (mx - mn) / mx : 0) * a;
      const rg = r - g, yb = 0.5 * (r + g) - b; rgS += rg * a; ybS += yb * a; rgS2 += rg * rg * a; ybS2 += yb * yb * a;
    }
    wsum = wsum || 1;
    const pct = (q) => { let acc = 0; const target = q * wsum; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; } return 1; };
    let mean = 0, varr = 0; for (let i = 0; i < 256; i++) mean += (i / 255) * hist[i]; mean /= wsum;
    for (let i = 0; i < 256; i++) varr += Math.pow(i / 255 - mean, 2) * hist[i]; varr /= wsum;
    let clipLow = 0, clipHigh = 0; for (let i = 0; i < 4; i++) clipLow += hist[i]; for (let i = 251; i < 256; i++) clipHigh += hist[i];
    const rgM = rgS / wsum, ybM = ybS / wsum, rgSd = Math.sqrt(Math.max(0, rgS2 / wsum - rgM * rgM)), ybSd = Math.sqrt(Math.max(0, ybS2 / wsum - ybM * ybM));
    const colorfulness = (Math.sqrt(rgSd * rgSd + ybSd * ybSd) + 0.3 * Math.sqrt(rgM * rgM + ybM * ybM)) / 110;
    msum = msum || 1;
    const mid = { r: mr / msum, g: mg / msum, b: mb / msum };
    const castTemp = (mid.r - mid.b) / 255, castTint = (mid.g - (mid.r + mid.b) / 2) / 255;

    // palette: k-means in Lab
    const KM = 5, cent = [], sortedIdx = [];
    for (let i = 0; i < n; i += 3) if (alpha[i] > 0.5) sortedIdx.push(i);
    sortedIdx.sort((a, b) => La[a] - La[b]);
    for (let k = 0; k < KM; k++) { const i = sortedIdx[Math.floor(((k + 0.5) / KM) * sortedIdx.length)] ?? 0; cent.push([La[i], Aa[i], Ba[i]]); }
    let assign = new Int32Array(sortedIdx.length);
    for (let it = 0; it < 8; it++) {
      const acc = cent.map(() => [0, 0, 0, 0]);
      sortedIdx.forEach((i, s) => { let best = 0, bd = Infinity; for (let k = 0; k < KM; k++) { const dl = La[i] - cent[k][0], da = Aa[i] - cent[k][1], db = Ba[i] - cent[k][2], dd = dl * dl + da * da + db * db; if (dd < bd) { bd = dd; best = k; } } assign[s] = best; const a = acc[best]; a[0] += La[i]; a[1] += Aa[i]; a[2] += Ba[i]; a[3]++; });
      acc.forEach((a, k) => { if (a[3]) cent[k] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
    }
    const pal = cent.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    sortedIdx.forEach((i, s) => { const p = pal[assign[s]]; p.r += d[i * 4]; p.g += d[i * 4 + 1]; p.b += d[i * 4 + 2]; p.count++; });
    const palette = pal.filter((p) => p.count).map((p) => ({ r: p.r / p.count, g: p.g / p.count, b: p.b / p.count, share: p.count / sortedIdx.length })).sort((a, b) => b.share - a.share);
    palette.forEach((p) => (p.name = colorName(p)));

    // saliency (frequency-tuned, Achanta et al.) with a soft center prior
    const bl = boxBlur(La, w, h, 1), ba = boxBlur(Aa, w, h, 1), bb = boxBlur(Ba, w, h, 1);
    let mL = 0, mA = 0, mB = 0; for (let i = 0; i < n; i++) { mL += La[i]; mA += Aa[i]; mB += Ba[i]; } mL /= n; mA /= n; mB /= n;
    const sal = new Float32Array(n); let smax = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, dx = x / w - 0.5, dy = y / h - 0.5;
      const v = Math.sqrt((bl[i] - mL) ** 2 + (ba[i] - mA) ** 2 + (bb[i] - mB) ** 2) * (1 - 0.35 * Math.sqrt(dx * dx + dy * dy) * 1.41) * (alpha[i] > 0.05 ? 1 : 0);
      sal[i] = v; if (v > smax) smax = v;
    }
    let scx = 0, scy = 0, stot = 0;
    for (let i = 0; i < n; i++) { sal[i] /= smax || 1; const v = sal[i] * sal[i]; scx += (i % w) * v; scy += ((i / w) | 0) * v; stot += v; }
    const salCenter = { x: stot ? scx / stot / w : 0.5, y: stot ? scy / stot / h : 0.5 };

    // brightest light source
    const lb = boxBlur(lum, w, h, Math.max(2, Math.round(w / 40)));
    let bi = 0; for (let i = 1; i < n; i++) if (lb[i] > lb[bi]) bi = i;
    const bright = { x: (bi % w + 0.5) / w, y: (((bi / w) | 0) + 0.5) / h, v: lb[bi] };

    // horizon: strongest horizontal luminance edge between 20% and 80%
    const rowL = new Float32Array(h); for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += lum[y * w + x]; rowL[y] = s / w; }
    let hz = -1, hzv = 0; for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.8); y++) { const v = Math.abs(rowL[y - 2] - rowL[y + 2]); if (v > hzv) { hzv = v; hz = y; } }

    // sky: top band smooth and bright or blue-ish
    let skyEdge = 0, skyBlue = 0, skyL = 0, cnt = 0;
    for (let y = 1; y < Math.floor(h * 0.3); y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; skyEdge += Math.abs(lum[i] - lum[i - 1]) + Math.abs(lum[i] - lum[i - w]); skyBlue += Ba[i] < -5 ? 1 : 0; skyL += lum[i]; cnt++; }
    const sky = { smooth: 1 - clamp((skyEdge / (cnt || 1)) * 12, 0, 1), blue: skyBlue / (cnt || 1), lum: skyL / (cnt || 1) };

    // integral images for fast region queries
    const II = new Float64Array((w + 1) * (h + 1)), IX = new Float64Array((w + 1) * (h + 1)), IY = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let r = 0, rx = 0, ry = 0; for (let x = 0; x < w; x++) { const v = sal[y * w + x]; r += v; rx += v * x; ry += v * y; const o = (y + 1) * (w + 1) + x + 1; II[o] = II[o - w - 1] + r; IX[o] = IX[o - w - 1] + rx; IY[o] = IY[o - w - 1] + ry; } }
    const rect = (I, x0, y0, x1, y1) => { x0 = clamp(Math.round(x0), 0, w); x1 = clamp(Math.round(x1), 0, w); y0 = clamp(Math.round(y0), 0, h); y1 = clamp(Math.round(y1), 0, h); const W = w + 1; return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]; };

    return {
      w: src.width, h: src.height, sw: w, sh: h, lum, lb, sal, alpha,
      mean, std: Math.sqrt(varr), p1: pct(0.01), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
      clipLow: clipLow / wsum, clipHigh: clipHigh / wsum, saturation: ssat / wsum, colorfulness,
      castTemp, castTint, palette, salCenter, bright, horizon: hz >= 0 && hzv > 0.04 ? hz / h : null, sky,
      region: (fx0, fy0, fx1, fy1) => rect(II, fx0 * w, fy0 * h, fx1 * w, fy1 * h),
      regionX: (fx0, fy0, fx1, fy1) => rect(IX, fx0 * w, fy0 * h, fx1 * w, fy1 * h),
      regionY: (fx0, fy0, fx1, fy1) => rect(IY, fx0 * w, fy0 * h, fx1 * w, fy1 * h),
      lumAt: (fx, fy) => lb[clamp((fy * h) | 0, 0, h - 1) * w + clamp((fx * w) | 0, 0, w - 1)],
      salAt: (fx, fy) => sal[clamp((fy * h) | 0, 0, h - 1) * w + clamp((fx * w) | 0, 0, w - 1)],
      meanLum: (fx0, fy0, fx1, fy1) => { let s = 0, c = 0; for (let y = Math.floor(fy0 * h); y < Math.ceil(fy1 * h); y++) for (let x = Math.floor(fx0 * w); x < Math.ceil(fx1 * w); x++) { const i = clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1); s += lum[i]; c++; } return c ? s / c : 0.5; },
    };
  }

  // Best crop window. ar = target aspect (w/h) or null to keep the current aspect.
  function bestCrop(A, ar) {
    const w = A.sw, h = A.sh, total = A.region(0, 0, 1, 1) || 1;
    const imgAr = A.w / A.h, target = ar || imgAr;
    let maxW = 1, maxH = (A.w / target) / A.h; // in fractions of the image
    if (maxH > 1) { maxH = 1; maxW = (A.h * target) / A.w; }
    const scales = ar ? [1, 0.92, 0.85] : [0.9, 0.82, 0.75, 0.68];
    const thirdsScore = (cx, cy) => { let best = 1; for (const tx of [1 / 3, 2 / 3]) for (const ty of [1 / 3, 2 / 3]) best = Math.min(best, Math.hypot(cx - tx, cy - ty)); return 1 - Math.min(1, best / 0.25); };
    const score = (x, y, cw, ch) => {
      const inside = A.region(x, y, x + cw, y + ch); if (inside <= 0) return -9;
      const cov = inside / total, area = cw * ch;
      const cx = (A.regionX(x, y, x + cw, y + ch) / inside / w - x) / cw, cy = (A.regionY(x, y, x + cw, y + ch) / inside / h - y) / ch;
      const tb = thirdsScore(cx, cy);
      const ex = 2 / w, ey = 2 / h;
      const edge = (A.region(x, y, x + cw, y + ey) + A.region(x, y + ch - ey, x + cw, y + ch) + A.region(x, y, x + ex, y + ch) + A.region(x + cw - ex, y, x + cw, y + ch)) / ((2 * cw * ey + 2 * ch * ex) * total);
      const edgePenalty = Math.max(0, edge - 1) * 0.06;
      return ar ? cov + 0.18 * tb + 0.3 * area - edgePenalty : cov - 0.6 * area + 0.22 * tb - edgePenalty;
    };
    let best = null;
    for (const s of scales) {
      const cw = maxW * s, ch = maxH * s, step = 0.025;
      for (let y = 0; y <= 1 - ch + 1e-6; y += step) for (let x = 0; x <= 1 - cw + 1e-6; x += step) {
        const sc = score(x, y, cw, ch);
        if (!best || sc > best.sc) best = { x, y, w: cw, h: ch, sc };
      }
      if (ar) { // also try the centered window for each scale
        const x = (1 - cw) / 2, y = (1 - ch) / 2, sc = score(x, y, cw, ch); if (sc > best.sc) best = { x, y, w: cw, h: ch, sc };
      }
    }
    if (!ar) { const full = score(0, 0, 1, 1); if (!best || best.sc < full + 0.03) return null; }
    return best;
  }

  /* Background removal: border color model + connectivity from the edges. */
  function removeBackground(srcCanvas) {
    const sm = downsample(srcCanvas, 420), w = sm.width, h = sm.height, n = w * h;
    const d = sm.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const l = srgbToLab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2]; }
    // sample border band
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.03)), border = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < band || y < band || x >= w - band || y >= h - band) border.push(y * w + x);
    // k-means (k=3) on border colors
    const KB = 3, C = [];
    for (let k = 0; k < KB; k++) { const i = border[Math.floor(((k + 0.5) / KB) * border.length)]; C.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]); }
    for (let it = 0; it < 6; it++) {
      const acc = C.map(() => [0, 0, 0, 0]);
      for (const i of border) { let b = 0, bd = Infinity; for (let k = 0; k < KB; k++) { const dd = (lab[i * 3] - C[k][0]) ** 2 + (lab[i * 3 + 1] - C[k][1]) ** 2 + (lab[i * 3 + 2] - C[k][2]) ** 2; if (dd < bd) { bd = dd; b = k; } } const a = acc[b]; a[0] += lab[i * 3]; a[1] += lab[i * 3 + 1]; a[2] += lab[i * 3 + 2]; a[3]++; }
      acc.forEach((a, k) => { if (a[3]) C[k] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
    }
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) { let bd = Infinity; for (let k = 0; k < KB; k++) { const dd = (lab[i * 3] - C[k][0]) ** 2 + (lab[i * 3 + 1] - C[k][1]) ** 2 + (lab[i * 3 + 2] - C[k][2]) ** 2; if (dd < bd) bd = dd; } dist[i] = Math.sqrt(bd); }
    const ds = boxBlur(dist, w, h, 1);
    // Otsu threshold on distance
    let mxd = 0; for (let i = 0; i < n; i++) if (ds[i] > mxd) mxd = ds[i];
    const bins = 128, hist = new Float64Array(bins); for (let i = 0; i < n; i++) hist[Math.min(bins - 1, ((ds[i] / (mxd || 1)) * bins) | 0)]++;
    let sumAll = 0; for (let i = 0; i < bins; i++) sumAll += i * hist[i];
    let wB = 0, sumB = 0, bestT = 0, bestV = -1;
    for (let t = 0; t < bins; t++) { wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > bestV) { bestV = v; bestT = t; } }
    const thr = Math.max(9, Math.min(40, ((bestT + 0.5) / bins) * mxd));
    // flood fill background from the border through similar pixels
    const bg = new Uint8Array(n), stack = [];
    for (const i of border) if (ds[i] < thr && !bg[i]) { bg[i] = 1; stack.push(i); }
    while (stack.length) { const i = stack.pop(), x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !bg[j] && ds[j] < thr * 1.15) { bg[j] = 1; stack.push(j); } }
    // keep the largest foreground component
    const comp = new Int32Array(n).fill(-1); let bestC = -1, bestSize = 0, cid = 0;
    for (let s = 0; s < n; s++) { if (bg[s] || comp[s] >= 0) continue; let size = 0; const st = [s]; comp[s] = cid;
      while (st.length) { const i = st.pop(); size++; const x = i % w, y = (i / w) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !bg[j] && comp[j] < 0) { comp[j] = cid; st.push(j); } }
      if (size > bestSize) { bestSize = size; bestC = cid; } cid++; }
    const fgFrac = bestSize / n;
    if (fgFrac < 0.03 || fgFrac > 0.97) return { ok: false, reason: fgFrac < 0.03 ? "I couldn't find a clear subject against the background." : "The subject and background are too similar for me to separate." };
    let mask = new Float32Array(n); for (let i = 0; i < n; i++) mask[i] = comp[i] === bestC ? 1 : 0;
    mask = boxBlur(mask, w, h, 1);
    const mc = mk(w, h), mctx = mc.getContext("2d"), md = mctx.createImageData(w, h);
    for (let i = 0; i < n; i++) { md.data[i * 4 + 3] = clamp(Math.round((mask[i] - 0.15) / 0.7 * 255), 0, 255); }
    mctx.putImageData(md, 0, 0);
    const out = mk(srcCanvas.width, srcCanvas.height), o = out.getContext("2d");
    o.drawImage(srcCanvas, 0, 0);
    o.globalCompositeOperation = "destination-in"; o.imageSmoothingEnabled = true; o.imageSmoothingQuality = "high";
    o.drawImage(mc, 0, 0, out.width, out.height);
    return { ok: true, canvas: out, subjectShare: fgFrac };
  }

  /* ================= 3. generators ================= */
  function pickSkySpot(A, r, preferDark) {
    let best = null;
    for (let i = 0; i < 60; i++) {
      const x = 0.1 + r() * 0.8, y = 0.06 + r() * 0.36;
      const s = A.salAt(x, y) * 1.4 + (preferDark ? A.lumAt(x, y) : Math.abs(A.lumAt(x, y) - 0.6) * 0.3) + (A.horizon && y > A.horizon - 0.05 ? 2 : 0);
      if (!best || s < best.s) best = { x, y, s };
    }
    return best;
  }
  function textBand(A) {
    const top = A.region(0, 0, 1, 0.25), bottom = A.region(0, 0.75, 1, 1);
    return bottom <= top * 1.15 ? "bottom" : "top";
  }
  function caption(A, seedText) {
    const r = rngFrom(hashStr(seedText || "") ^ 0x55aa);
    const warm = A.castTemp > 0.04, cool = A.castTemp < -0.03;
    const time = A.mean < 0.22 ? (warm ? ["Ember night", "Late glow"] : ["After dark", "Night falls", "Blue hour"]) :
      A.mean < 0.42 ? (warm ? ["Dusk", "Golden hour", "Last light"] : ["Evening", "Twilight", "Quiet hour"]) :
      warm ? ["Golden afternoon", "Warm light", "Summer haze"] : cool ? ["Cool morning", "Clear day", "Fresh air"] : ["Daylight", "Open sky", "Still day"];
    const mood = A.colorfulness < 0.2 ? ["quiet", "soft", "still"] : A.colorfulness > 0.5 ? ["vivid", "bold", "bright"] : ["gentle", "calm", "lingering"];
    const hue = (A.palette.find((p) => !["black", "white", "charcoal", "silver"].includes(p.name)) || {}).name;
    const opts = [
      time[(r() * time.length) | 0],
      hue ? `${titleCase(mood[(r() * mood.length) | 0])} ${hue} ${time[0].toLowerCase()}` : titleCase(mood[0]) + " " + time[0].toLowerCase(),
      hue ? `${titleCase(hue)} ${time[(r() * time.length) | 0].toLowerCase()}` : time[1] || time[0],
    ];
    return opts[(r() * opts.length) | 0];
  }

  const JOBS = {
    text(ctx, A, w, h, p, r, env) {
      const fonts = env.fonts || {};
      const style = /handwrit|script|cursive/i.test(p.clause) ? "script" : /bold|modern|poster|headline/i.test(p.clause) ? "display" : /mono|typewriter|code/i.test(p.clause) ? "mono" : /sans|clean|simple/i.test(p.clause) ? "sans" : "serif";
      const family = fonts[style] || "Georgia, serif";
      const where = /\btop\b/i.test(p.clause) ? "top" : /\b(center|middle)\b/i.test(p.clause) ? "center" : /\bbottom\b/i.test(p.clause) ? "bottom" : textBand(A);
      const y = where === "top" ? 0.13 : where === "center" ? 0.5 : 0.87;
      const bandLum = A.meanLum(0.1, y - 0.08, 0.9, y + 0.08);
      const color = p.color || (bandLum > 0.6 ? "#16161a" : "#ffffff");
      const text = p.text;
      let size = Math.min(w, h) * (style === "script" ? 0.12 : 0.09) * (p.k >= 1.5 ? 1.35 : p.k <= 0.5 ? 0.7 : 1);
      ctx.font = `${style === "display" ? 700 : 600} ${size}px ${family}`;
      let lines = [text];
      if (ctx.measureText(text).width > w * 0.86) {
        const words = text.split(" "); lines = []; let cur = "";
        for (const wd of words) { const t = cur ? cur + " " + wd : wd; if (ctx.measureText(t).width > w * 0.86 && cur) { lines.push(cur); cur = wd; } else cur = t; }
        lines.push(cur);
        while (lines.length > 3 || lines.some((l) => ctx.measureText(l).width > w * 0.9)) { size *= 0.9; ctx.font = `${style === "display" ? 700 : 600} ${size}px ${family}`; if (size < 10) break; if (lines.length <= 3) break; }
      }
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = color;
      ctx.shadowColor = color === "#ffffff" || bandLum < 0.6 ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.45)"; ctx.shadowBlur = size * 0.3; ctx.shadowOffsetY = size * 0.04;
      const lh = size * 1.15, y0 = y * h - ((lines.length - 1) * lh) / 2;
      lines.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * lh));
      return { name: "Text: " + text.slice(0, 24), msg: `placed “${text}” at the ${where} in ${style === "serif" ? "an elegant serif" : style === "script" ? "a handwritten script" : style === "display" ? "a bold display face" : style === "mono" ? "a typewriter face" : "a clean sans"}` };
    },
    frame(ctx, A, w, h, p, r) {
      const m = Math.min(w, h), c = p.clause.toLowerCase();
      if (/polaroid|instant/.test(c)) {
        ctx.fillStyle = p.color || "#f7f4ee"; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "destination-out"; ctx.fillRect(m * 0.05, m * 0.05, w - m * 0.1, h - m * 0.05 - m * 0.2);
        return { name: "Polaroid frame", msg: "added an instant-photo frame with room to write underneath" };
      }
      if (/film|sprocket|35/.test(c)) {
        const t = m * 0.085; ctx.fillStyle = "#0d0d0f"; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "destination-out"; ctx.fillRect(m * 0.03, t, w - m * 0.06, h - 2 * t);
        ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "#e9e4d8";
        const hw = t * 0.32, hh = t * 0.42, gap = hw * 1.9;
        for (let x = gap * 0.5; x < w; x += gap) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, (t - hh) / 2, hw, hh, hw * 0.2) : ctx.rect(x, (t - hh) / 2, hw, hh); ctx.roundRect ? ctx.roundRect(x, h - t + (t - hh) / 2, hw, hh, hw * 0.2) : ctx.rect(x, h - t + (t - hh) / 2, hw, hh); ctx.fill(); }
        return { name: "Film frame", msg: "added a 35 mm film border with sprocket holes" };
      }
      if (/hand|drawn|sketch|doodle|wobbl/.test(c)) {
        ctx.strokeStyle = p.color || "#ffffff"; ctx.lineCap = ctx.lineJoin = "round";
        const inset = m * 0.045;
        for (let pass = 0; pass < 3; pass++) {
          ctx.lineWidth = m * (0.006 - pass * 0.0015); ctx.globalAlpha = 0.9 - pass * 0.2; ctx.beginPath();
          const pts = []; const side = (x0, y0, x1, y1) => { const steps = 14; for (let i = 0; i <= steps; i++) { const t = i / steps; pts.push([x0 + (x1 - x0) * t + gauss(r) * m * 0.003, y0 + (y1 - y0) * t + gauss(r) * m * 0.003]); } };
          side(inset, inset, w - inset, inset); side(w - inset, inset, w - inset, h - inset); side(w - inset, h - inset, inset, h - inset); side(inset, h - inset, inset, inset + m * 0.02);
          ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
          ctx.stroke();
        }
        return { name: "Hand-drawn frame", msg: "sketched a hand-drawn frame" };
      }
      const t = m * (/thin/.test(c) ? 0.02 : /thick|wide/.test(c) ? 0.07 : 0.04);
      ctx.fillStyle = p.color || (/black|dark/.test(c) ? "#111" : "#ffffff"); ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "destination-out"; ctx.fillRect(t, t, w - 2 * t, h - 2 * t);
      return { name: "Border", msg: "added a clean border" };
    },
    light_leak(ctx, A, w, h, p, r) {
      const c = p.clause.toLowerCase();
      const cx = /left/.test(c) ? 0 : /right/.test(c) ? w : r() < 0.5 ? 0 : w, cy = /bottom/.test(c) ? h : /top/.test(c) ? 0 : r() < 0.6 ? 0 : h;
      const R = Math.max(w, h);
      [[0, "255,120,40", 0.75, 0.55], [0.18, "255,60,80", 0.55, 0.42], [-0.12, "255,210,120", 0.6, 0.3]].forEach(([off, col, a, rad]) => {
        const x = cx + off * w, y = cy + off * h * 0.5, g = ctx.createRadialGradient(x, y, 0, x, y, R * rad);
        g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      });
      return { name: "Light leak", blend: "screen", msg: "added a warm light leak from the " + (cy ? "lower" : "upper") + (cx ? " right" : " left") };
    },
    glow(ctx, A, w, h, p) {
      const x = A.bright.x * w, y = A.bright.y * h, R = Math.max(w, h) * 0.55 * (p.k > 1 ? 1.2 : 1);
      const warm = p.warm ? "255,190,110" : "255,236,210";
      const g = ctx.createRadialGradient(x, y, 0, x, y, R); g.addColorStop(0, `rgba(${warm},0.65)`); g.addColorStop(0.35, `rgba(${warm},0.25)`); g.addColorStop(1, `rgba(${warm},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      return { name: p.warm ? "Golden glow" : "Glow", blend: "screen", opacity: 0.85, msg: "added a soft glow around the main light" };
    },
    flare(ctx, A, w, h) {
      const x = A.bright.x * w, y = A.bright.y * h, m = Math.max(w, h);
      let g = ctx.createRadialGradient(x, y, 0, x, y, m * 0.25); g.addColorStop(0, "rgba(255,248,230,0.95)"); g.addColorStop(0.08, "rgba(255,220,170,0.6)"); g.addColorStop(1, "rgba(255,180,120,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.translate(x, y); ctx.scale(1, 0.025); g = ctx.createRadialGradient(0, 0, 0, 0, 0, m * 0.6); g.addColorStop(0, "rgba(180,220,255,0.7)"); g.addColorStop(1, "rgba(120,170,255,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, m * 0.6, 0, 7); ctx.fill(); ctx.restore();
      const vx = w / 2 - x, vy = h / 2 - y;
      [[0.45, 0.025, "120,255,220", 0.18], [0.75, 0.05, "255,120,200", 0.12], [1.15, 0.018, "255,210,120", 0.25], [1.5, 0.08, "140,180,255", 0.08]].forEach(([t, rr, col, a]) => {
        const gx = x + vx * 2 * t, gy = y + vy * 2 * t, R = m * rr; const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, R);
        gg.addColorStop(0, `rgba(${col},${a})`); gg.addColorStop(0.8, `rgba(${col},${a * 0.8})`); gg.addColorStop(1, `rgba(${col},0)`); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(gx, gy, R, 0, 7); ctx.fill();
      });
      return { name: "Lens flare", blend: "screen", msg: "added a lens flare on the brightest light" };
    },
    stars(ctx, A, w, h, p, r) {
      const count = Math.round(320 * (w * h) / 1.7e6 * p.k + 80); let placed = 0;
      for (let i = 0; i < count * 4 && placed < count; i++) {
        const fx = r(), fy = Math.pow(r(), 1.5) * (A.horizon ? A.horizon : 0.7);
        if (A.lumAt(fx, fy) > 0.5) continue;
        const x = fx * w, y = fy * h, s = Math.pow(r(), 3) * Math.min(w, h) * 0.003 + 0.7;
        const tint = r(); ctx.fillStyle = tint < 0.15 ? "rgba(255,225,190,1)" : tint < 0.3 ? "rgba(200,220,255,1)" : "#fff";
        ctx.globalAlpha = 0.35 + r() * 0.65; ctx.beginPath(); ctx.arc(x, y, s, 0, 7); ctx.fill();
        if (r() < 0.05) { ctx.globalAlpha = 0.5; const g = ctx.createRadialGradient(x, y, 0, x, y, s * 8); g.addColorStop(0, "rgba(255,255,255,.6)"); g.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = g; ctx.fillRect(x - s * 8, y - s * 8, s * 16, s * 16); ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(x - s * 7, y); ctx.lineTo(x + s * 7, y); ctx.moveTo(x, y - s * 7); ctx.lineTo(x, y + s * 7); ctx.stroke(); }
        placed++;
      }
      ctx.globalAlpha = 1;
      return { name: "Stars", blend: "screen", msg: placed ? `scattered ${placed} stars across the darker sky` : "looked for dark sky for stars but found very little" };
    },
    birds(ctx, A, w, h, p, r) {
      const spot = pickSkySpot(A, r, false), n = Math.round((7 + r() * 8) * p.k), m = Math.min(w, h);
      const dark = A.lumAt(spot.x, spot.y) > 0.25;
      ctx.strokeStyle = dark ? "rgba(20,18,26,.88)" : "rgba(235,235,240,.85)"; ctx.lineCap = ctx.lineJoin = "round";
      for (let i = 0; i < n; i++) {
        const x = (spot.x + gauss(r) * 0.08) * w, y = (spot.y + gauss(r) * 0.035) * h, s = m * (0.012 + r() * 0.018), flap = 0.4 + r() * 0.9;
        ctx.save(); ctx.translate(x, y); ctx.rotate(gauss(r) * 0.15); ctx.lineWidth = s * 0.16;
        ctx.beginPath(); ctx.moveTo(-s, -s * 0.15 * flap); ctx.quadraticCurveTo(-s * 0.45, -s * 0.55 * flap, 0, 0); ctx.quadraticCurveTo(s * 0.45, -s * 0.55 * flap, s, -s * 0.15 * flap); ctx.stroke(); ctx.restore();
      }
      return { name: "Birds", msg: `added a flock of ${n} birds in an open patch of sky` };
    },
    sparkles(ctx, A, w, h, p, r) {
      const n = Math.round((18 + r() * 14) * p.k), m = Math.min(w, h);
      for (let i = 0; i < n; i++) {
        const near = r() < 0.65, x = (near ? A.bright.x + gauss(r) * 0.12 : r()) * w, y = (near ? A.bright.y + gauss(r) * 0.1 : r()) * h, R = m * (0.008 + Math.pow(r(), 2) * 0.03);
        const g = ctx.createRadialGradient(x, y, 0, x, y, R * 1.6); g.addColorStop(0, "rgba(255,245,215,.55)"); g.addColorStop(1, "rgba(255,245,215,0)"); ctx.fillStyle = g; ctx.fillRect(x - R * 2, y - R * 2, R * 4, R * 4);
        ctx.fillStyle = r() < 0.4 ? "#ffe39a" : "#fffaf0"; ctx.beginPath(); ctx.moveTo(x, y - R);
        ctx.quadraticCurveTo(x, y, x + R, y); ctx.quadraticCurveTo(x, y, x, y + R); ctx.quadraticCurveTo(x, y, x - R, y); ctx.quadraticCurveTo(x, y, x, y - R); ctx.fill();
      }
      return { name: "Sparkles", blend: "screen", msg: `added ${n} sparkles, clustered around the light` };
    },
    snow(ctx, A, w, h, p, r) {
      const n = Math.round(650 * (w * h) / 1.7e6 * p.k + 150), m = Math.min(w, h);
      for (let i = 0; i < n; i++) { const x = r() * w, y = r() * h, s = Math.pow(r(), 2.6) * m * 0.009 + 0.8; const g = ctx.createRadialGradient(x, y, 0, x, y, s); g.addColorStop(0, "rgba(255,255,255,.95)"); g.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = g; ctx.fillRect(x - s, y - s, s * 2, s * 2); }
      return { name: "Snow", msg: `let ${n} snowflakes fall` };
    },
    rain(ctx, A, w, h, p, r) {
      const n = Math.round(1100 * (w * h) / 1.7e6 * p.k + 200), m = Math.min(w, h), ang = 0.22;
      ctx.lineCap = "round";
      for (let i = 0; i < n; i++) { const x = r() * w * 1.2 - w * 0.1, y = r() * h, L = m * (0.02 + r() * 0.05); ctx.strokeStyle = `rgba(215,228,255,${0.15 + r() * 0.35})`; ctx.lineWidth = 0.6 + r() * 1.3; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - L * ang, y + L); ctx.stroke(); }
      return { name: "Rain", msg: "added falling rain" };
    },
    bokeh(ctx, A, w, h, p, r) {
      const n = Math.round((26 + r() * 14) * p.k), m = Math.min(w, h);
      const cols = A.palette.map((c) => brighten(c, 0.5)).concat([{ r: 255, g: 200, b: 120 }, { r: 255, g: 230, b: 180 }]);
      for (let i = 0; i < n; i++) { const c = cols[(r() * cols.length) | 0], x = r() * w, y = r() * h, R = m * (0.015 + Math.pow(r(), 1.5) * 0.06);
        ctx.fillStyle = css(c, 0.18 + r() * 0.15); ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill(); ctx.strokeStyle = css(c, 0.35); ctx.lineWidth = R * 0.08; ctx.stroke(); }
      return { name: "Bokeh", blend: "screen", msg: `added ${n} bokeh lights in the photo's own colors` };
    },
    confetti(ctx, A, w, h, p, r) {
      const n = Math.round(220 * p.k), m = Math.min(w, h), cols = ["#ff4d6d", "#ffd23f", "#3ec1d3", "#7b5cff", "#4cd964", "#ff8a2b", "#ffffff"];
      for (let i = 0; i < n; i++) { const x = r() * w, y = Math.pow(r(), 1.3) * h, s = m * (0.006 + r() * 0.01); ctx.save(); ctx.translate(x, y); ctx.rotate(r() * 6.28); ctx.fillStyle = cols[(r() * cols.length) | 0]; if (r() < 0.75) ctx.fillRect(-s, -s * 0.4, s * 2, s * 0.8); else { ctx.beginPath(); ctx.arc(0, 0, s * 0.6, 0, 7); ctx.fill(); } ctx.restore(); }
      return { name: "Confetti", msg: `threw ${n} pieces of confetti` };
    },
    hearts(ctx, A, w, h, p, r) {
      const n = Math.round((12 + r() * 10) * p.k), m = Math.min(w, h);
      for (let i = 0; i < n; i++) { const x = r() * w, y = (0.25 + Math.pow(r(), 0.7) * 0.75) * h, s = m * (0.015 + Math.pow(r(), 2) * 0.05);
        ctx.save(); ctx.translate(x, y); ctx.rotate(gauss(r) * 0.3); ctx.globalAlpha = 0.55 + r() * 0.4;
        const g = ctx.createLinearGradient(0, -s, 0, s); g.addColorStop(0, "#ff8fb8"); g.addColorStop(1, "#e2245a"); ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, -s * 0.25); ctx.bezierCurveTo(-s * 0.5, -s * 0.75, -s * 1.1, -s * 0.05, 0, s * 0.6); ctx.bezierCurveTo(s * 1.1, -s * 0.05, s * 0.5, -s * 0.75, 0, -s * 0.25); ctx.fill(); ctx.restore(); }
      return { name: "Hearts", msg: `floated ${n} hearts up the frame` };
    },
    moon(ctx, A, w, h, p, r) {
      const spot = pickSkySpot(A, r, true), m = Math.min(w, h), R = m * 0.05 * (p.k > 1 ? 1.3 : 1), x = spot.x * w, y = spot.y * h;
      const g = ctx.createRadialGradient(x, y, R * 0.8, x, y, R * 5); g.addColorStop(0, "rgba(255,248,225,.35)"); g.addColorStop(1, "rgba(255,248,225,0)"); ctx.fillStyle = g; ctx.fillRect(x - R * 5, y - R * 5, R * 10, R * 10);
      const body = mk(w, h), bc = body.getContext("2d");
      bc.fillStyle = "#f5efdc"; bc.beginPath(); bc.arc(x, y, R, 0, 7); bc.fill();
      const crescent = /crescent|half|thin/i.test(p.clause);
      if (crescent) { bc.globalCompositeOperation = "destination-out"; bc.beginPath(); bc.arc(x + R * 0.45, y - R * 0.2, R * 0.92, 0, 7); bc.fill(); }
      else { bc.fillStyle = "rgba(150,140,120,.18)"; for (let i = 0; i < 7; i++) { bc.beginPath(); bc.arc(x + gauss(r) * R * 0.4, y + gauss(r) * R * 0.4, R * (0.08 + r() * 0.18), 0, 7); bc.fill(); } }
      if (crescent) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.arc(x + R * 0.45, y - R * 0.2, R * 0.92, 0, 7, true); ctx.clip("evenodd"); }
      ctx.globalCompositeOperation = "destination-out"; ctx.beginPath(); ctx.arc(x, y, R * 1.02, 0, 7); ctx.fill(); ctx.globalCompositeOperation = "source-over";
      if (crescent) ctx.restore();
      ctx.drawImage(body, 0, 0);
      return { name: crescent ? "Crescent moon" : "Moon", msg: `hung a ${crescent ? "crescent" : "full"} moon in the darkest open sky` };
    },
    sunset_stripes(ctx, A, w, h, p, r) {
      const m = Math.min(w, h), c = p.clause.toLowerCase();
      if (/sun|synth|vapor|outrun/.test(c) || !/stripe/.test(c)) {
        const x = (A.salCenter.x < 0.5 ? 0.68 : 0.32) * w, y = (A.horizon || 0.55) * h - m * 0.08, R = m * 0.2;
        const g = ctx.createLinearGradient(0, y - R, 0, y + R); g.addColorStop(0, "#ffe25c"); g.addColorStop(0.55, "#ff7a59"); g.addColorStop(1, "#d6338a");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill();
        ctx.globalCompositeOperation = "destination-out";
        for (let i = 0; i < 6; i++) { const yy = y + R * (0.05 + i * 0.17), t = R * (0.025 + i * 0.022); ctx.fillRect(x - R, yy, R * 2, t); }
        ctx.globalCompositeOperation = "source-over";
        return { name: "Retro sun", blend: "screen", opacity: 0.92, msg: "added a striped retro sun on the horizon" };
      }
      const cols = ["#e94f37", "#f39237", "#f6c445", "#68b0ab", "#3c6e71"], sw = m * 0.035;
      ctx.save(); ctx.translate(w, h * 0.15); ctx.rotate(Math.PI / 4.5);
      cols.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(-w * 2, i * sw, w * 4, sw); }); ctx.restore();
      return { name: "Retro stripes", opacity: 0.9, msg: "laid 70s stripes across the corner" };
    },
    clouds(ctx, A, w, h, p, r) {
      const fog = /fog|mist|haze/i.test(p.clause), m = Math.max(w, h);
      if (fog) { const base = (A.horizon || 0.6) * h;
        for (let i = 0; i < 70; i++) { const x = r() * w, y = base + gauss(r) * h * 0.08, R = m * (0.08 + r() * 0.15); const g = ctx.createRadialGradient(x, y, 0, x, y, R); g.addColorStop(0, `rgba(235,238,245,${0.06 + r() * 0.08})`); g.addColorStop(1, "rgba(235,238,245,0)"); ctx.fillStyle = g; ctx.fillRect(x - R, y - R, R * 2, R * 2); }
        return { name: "Fog", blend: "screen", msg: "rolled low fog along the horizon" };
      }
      const n = Math.round(4 + r() * 4);
      for (let c = 0; c < n; c++) { const s = pickSkySpot(A, r, false), cx = s.x * w, cy = s.y * h, size = m * (0.04 + r() * 0.05);
        for (let i = 0; i < 16; i++) { const x = cx + gauss(r) * size * 1.4, y = cy + gauss(r) * size * 0.35 - Math.abs(gauss(r)) * size * 0.3, R = size * (0.5 + r() * 0.7); const g = ctx.createRadialGradient(x, y - R * 0.2, 0, x, y, R); g.addColorStop(0, "rgba(255,255,255,.75)"); g.addColorStop(0.7, "rgba(240,242,248,.45)"); g.addColorStop(1, "rgba(230,232,240,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill(); } }
      return { name: "Clouds", opacity: 0.9, msg: `painted ${n} clouds into open sky` };
    },
    split_tone(ctx, A, w, h, p, r, env) {
      const src = env.source, sd = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data, out = ctx.createImageData(w, h), od = out.data;
      for (let i = 0; i < sd.length; i += 4) { const l = (0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]) / 255; od[i] = 20 + l * 235; od[i + 1] = 120 + l * 20; od[i + 2] = 135 - l * 95; od[i + 3] = sd[i + 3]; }
      ctx.putImageData(out, 0, 0);
      return { name: "Teal & orange grade", blend: "soft-light", opacity: 0.6, msg: "graded shadows teal and highlights orange" };
    },
    abstract(ctx, A, w, h, p, r) {
      const cols = A.palette.map((c) => brighten(c, 0.35)), m = Math.max(w, h);
      for (let i = 0; i < 9; i++) { const c = cols[i % cols.length]; ctx.strokeStyle = css(c, 0.55); ctx.lineWidth = m * (0.003 + r() * 0.01); ctx.beginPath(); ctx.moveTo(-0.1 * w, r() * h); ctx.bezierCurveTo(r() * w, r() * h, r() * w, r() * h, 1.1 * w, r() * h); ctx.stroke(); }
      for (let i = 0; i < 14; i++) { const c = cols[(r() * cols.length) | 0]; ctx.fillStyle = css(c, 0.25); ctx.beginPath(); ctx.arc(r() * w, r() * h, m * (0.01 + r() * 0.05), 0, 7); ctx.fill(); }
      return { name: "Abstract art", blend: "screen", opacity: 0.9, msg: "painted abstract ribbons and circles from the photo's palette" };
    },
  };
  function renderJob(job, A, source, env = {}) {
    const w = source.width, h = source.height, c = mk(w, h), ctx = c.getContext("2d");
    const r = rngFrom(job.seed != null ? job.seed : hashStr(job.kind + (job.clause || "")) ^ (Date.now() & 0xffff));
    const res = JOBS[job.kind](ctx, A, w, h, job, r, { ...env, source });
    return { canvas: c, name: res.name, blend: res.blend || "source-over", opacity: res.opacity ?? 1, msg: res.msg };
  }

  /* ================= 4. planner ================= */
  const RANGE = { hue: [-180, 180], fade: [0, 100], sepia: [0, 100], mono: [0, 100], vignette: [0, 100], grain: [0, 100], blur: [0, 100], sharpen: [0, 100] };
  const rng = (k) => RANGE[k] || [-100, 100];
  const ART = new Set(["light_leak", "glow", "flare", "stars", "birds", "sparkles", "snow", "rain", "bokeh", "confetti", "hearts", "moon", "sunset_stripes", "clouds", "frame", "add_text"]);
  const PRETTY = { auto_enhance: "auto-enhance", brighten: "brighter", darken: "darker", contrast_up: "more contrast", contrast_down: "less contrast", warmer: "warmer", cooler: "cooler", saturate: "more color", desaturate: "less color", black_white: "black & white", sepia: "sepia", vintage: "vintage film", cinematic: "cinematic", moody: "moody", golden_hour: "golden hour", vignette_add: "vignette", vignette_remove: "no vignette", grain_add: "grain", grain_remove: "no grain", sharpen: "sharpen", soften: "soften", shadows_up: "lift shadows", highlights_down: "recover highlights", fix_color: "white balance", crop_smart: "smart crop", crop_ratio: "crop to ratio", rotate: "rotate", flip: "flip", add_text: "text", frame: "frame", light_leak: "light leak", glow: "glow", flare: "lens flare", stars: "stars", birds: "birds", sparkles: "sparkles", snow: "snow", rain: "rain", bokeh: "bokeh", confetti: "confetti", hearts: "hearts", moon: "moon", sunset_stripes: "retro sun", clouds: "clouds", remove_bg: "remove background", reset: "reset", critique: "critique", trim_start: "trim start", trim_end: "trim end", shorten: "shorten", slow_down: "slow motion", speed_up: "speed up", normal_speed: "normal speed", mute: "mute", unmute: "unmute", scene_split: "split scenes", fade_in: "fade in", fade_out: "fade out", reframe: "follow subject" };
  const VIDEO_INTENTS = new Set(["trim_start", "trim_end", "shorten", "slow_down", "speed_up", "normal_speed", "mute", "unmute", "scene_split", "fade_in", "fade_out", "reframe"]);
  const PHOTO_ONLY = new Set(["rotate", "flip", "remove_bg"]);
  function secondsIn(c) {
    const s = String(c).toLowerCase();
    if (/half a second/.test(s)) return 0.5;
    let m = s.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/);
    if (m) return +m[1];
    if (/\b(?:a|one|the first|the last)\s+second\b/.test(s)) return 1;
    m = s.match(/\b(\d+(?:\.\d+)?)\b/); if (m && !/\d\s*x\b|x\s*\d/.test(s)) return +m[1];
    return null;
  }
  function rangeIn(c) {
    const m = String(c).toLowerCase().match(/(\d+(?:\.\d+)?)\s*(?:s|sec\w*)?\s*(?:to|-|–|until|through)\s*(\d+(?:\.\d+)?)/);
    return m && +m[2] > +m[1] ? { a: +m[1], b: +m[2] } : null;
  }
  function speedIn(c) {
    const s = String(c).toLowerCase();
    let m = s.match(/(\d+(?:\.\d+)?)\s*x\b/) || s.match(/\bx\s*(\d+(?:\.\d+)?)/) || s.match(/(\d+(?:\.\d+)?)\s*times/);
    if (m && +m[1] > 0) return +m[1];
    if (/quarter/.test(s)) return 0.25; if (/half/.test(s)) return 0.5; if (/double|twice/.test(s)) return 2; if (/triple/.test(s)) return 3; if (/quadruple/.test(s)) return 4;
    return null;
  }

  function critique(A) {
    const notes = [], sugg = []; let score = 10;
    if (A.mean < 0.28) { notes.push("The image sits dark overall, so midtone detail is getting lost."); sugg.push("brighten a bit and lift the shadows"); score -= 1.5; }
    else if (A.mean > 0.68) { notes.push("Exposure runs bright; the lightest areas are close to washing out."); sugg.push("darken slightly and recover highlights"); score -= 1.5; }
    else notes.push("Exposure is well balanced through the midtones.");
    if (A.clipHigh > 0.03) { notes.push(`About ${Math.round(A.clipHigh * 100)}% of the frame is blown to pure white.`); sugg.push("recover highlights"); score -= 1; }
    if (A.clipLow > 0.08) { notes.push(`Around ${Math.round(A.clipLow * 100)}% of the frame is crushed to pure black.`); sugg.push("lift shadows"); score -= 0.5; }
    if (A.std < 0.14) { notes.push("Tonal range is narrow, which reads as flat."); sugg.push("add contrast"); score -= 1; }
    else if (A.std > 0.32) notes.push("Contrast is strong and graphic.");
    if (Math.abs(A.castTemp) > 0.07) { notes.push(`There's a noticeable ${A.castTemp > 0 ? "warm" : "cool"} cast in the neutral tones${A.castTemp > 0 && A.mean < 0.5 ? ", which suits a sunset but not daylight" : ""}.`); sugg.push("fix the white balance"); score -= 0.5; }
    if (Math.abs(A.castTint) > 0.04) { notes.push(`Neutrals lean ${A.castTint > 0 ? "green" : "magenta"}.`); sugg.push("fix the colors"); score -= 0.5; }
    if (A.colorfulness < 0.15) { notes.push("Colors are muted; it could go black and white or get a vibrance lift."); sugg.push("more vivid colors"); score -= 0.5; }
    else if (A.colorfulness > 0.75) { notes.push("Colors are very saturated and may look artificial."); sugg.push("slightly less saturation"); score -= 0.5; }
    const sc = A.salCenter, nearThirds = [1 / 3, 2 / 3].some((t) => Math.abs(sc.x - t) < 0.08) || [1 / 3, 2 / 3].some((t) => Math.abs(sc.y - t) < 0.08);
    if (Math.abs(sc.x - 0.5) < 0.07 && Math.abs(sc.y - 0.5) < 0.07) { notes.push("The visual weight sits dead center, which feels static."); sugg.push("crop to a stronger composition"); score -= 1; }
    else if (nearThirds) notes.push("The main point of interest lands near a rule-of-thirds line, which is good.");
    if (A.horizon && Math.abs(A.horizon - 0.5) < 0.05) { notes.push("The horizon cuts the frame in half; moving it to a third usually reads better."); sugg.push("crop to a stronger composition"); score -= 0.5; }
    const pal = A.palette.slice(0, 3).map((p) => p.name);
    notes.push(`Dominant colors: ${[...new Set(pal)].join(", ")}.`);
    if (!sugg.length) sugg.push("add a subtle vignette", "add film grain", "golden hour glow");
    return { text: `Score ${Math.max(1, Math.round(score * 2) / 2)}/10. ` + notes.join(" "), suggestions: [...new Set(sugg)].slice(0, 4) };
  }

  function plan(request, opts) {
    if (!net.ready) throw { code: "not_ready", message: "The AI is still training. Try again in a moment." };
    const { mode = "edit", adj: cur = {}, image } = opts;
    const A = analyze(image);
    const { quotes, clauses } = splitClauses(request || "");
    const understood = [], missed = [];
    for (const c of clauses) {
      if (!c.text && c.quote !== undefined) { understood.push({ intent: "add_text", p: 1, clause: "", quote: quotes[+c.quote], fromQuote: true }); continue; }
      if (!c.text || FILLER.test(normalize(c.text))) continue;
      const top = classify(c.text)[0];
      if (top.intent === "unknown" || top.p < 0.38) { missed.push(c.text); continue; }
      understood.push({ intent: top.intent, p: top.p, clause: c.text, quote: c.quote !== undefined ? quotes[+c.quote] : undefined });
    }
    // dedupe: keep the strongest instance of each intent; a bare quote merges into a text intent
    const byIntent = new Map();
    for (const u of understood) { const prev = byIntent.get(u.intent); if (!prev) byIntent.set(u.intent, u); else if (u.quote && !prev.quote) prev.quote = u.quote; }
    let intents = [...byIntent.values()];
    if (intents.some((u) => u.fromQuote) && intents.filter((u) => u.intent === "add_text").length === 1 && !intents.find((u) => u.intent === "add_text").clause) {
      // only a quote was given: treat as caption request
    }
    if (mode === "critique" || intents.some((u) => u.intent === "critique")) return { critique: critique(A), analysis: A, understood: intents.filter((u) => u.intent === "critique") };

    const adj = { ...cur }, notes = [], jobs = [], video = []; let crop = null, rotate = 0, flip = null, reset = false, removeBg = false;
    const isVideo = mode === "video" || mode === "video-art";
    const addA = (k, v) => { const [a, b] = rng(k); adj[k] = Math.round(clamp((adj[k] || 0) + v, a, b)); };
    const atLeast = (k, v) => { const [a, b] = rng(k); adj[k] = Math.round(clamp(Math.max(adj[k] || 0, v), a, b)); };
    const set = (k, v) => { const [a, b] = rng(k); adj[k] = Math.round(clamp(v, a, b)); };

    if (!intents.length && (mode === "art" || mode === "video-art")) intents = [{ intent: "abstract", p: 1, clause: request || "" }];
    for (const u of intents) {
      const k = intensityOf(u.clause), cl = u.clause;
      if (!isVideo && VIDEO_INTENTS.has(u.intent)) { notes.push(`“${cl}” is a video edit, so switch to Video mode at the top to use it`); continue; }
      if (isVideo && PHOTO_ONLY.has(u.intent)) { notes.push(`${PRETTY[u.intent]} isn't available for video yet`); continue; }
      if (isVideo && (VIDEO_INTENTS.has(u.intent) || u.intent === "crop_ratio" || u.intent === "crop_smart")) {
        switch (u.intent) {
          case "trim_start": video.push({ op: "trim_start", s: secondsIn(cl) ?? 1 }); break;
          case "trim_end": video.push({ op: "trim_end", s: secondsIn(cl) ?? 1 }); break;
          case "shorten": { const r = rangeIn(cl); if (r) video.push({ op: "keep", a: r.a, b: r.b }); else { const sec = secondsIn(cl); video.push(sec ? { op: "keep", a: 0, b: sec } : { op: "keep_share", share: 0.75 }); } break; }
          case "slow_down": { let sp = speedIn(cl) ?? (k > 1.2 ? 0.25 : 0.5); if (sp > 1) sp = 1 / sp; video.push({ op: "speed", v: sp }); break; }
          case "speed_up": { let sp = speedIn(cl) ?? (/timelapse|hyperlapse/i.test(cl) ? 4 : k > 1.2 ? 3 : 2); if (sp < 1) sp = 1 / sp; video.push({ op: "speed", v: sp }); break; }
          case "normal_speed": video.push({ op: "speed", v: 1 }); break;
          case "mute": video.push({ op: "mute", v: true }); break;
          case "unmute": video.push({ op: "mute", v: false }); break;
          case "scene_split": video.push({ op: "scenes" }); break;
          case "fade_in": video.push({ op: "fade_in", s: secondsIn(cl) ?? 1 }); break;
          case "fade_out": video.push({ op: "fade_out", s: secondsIn(cl) ?? 1 }); break;
          case "reframe": case "crop_smart": video.push({ op: "follow" }); break;
          case "crop_ratio": { const ar = ratioIn(cl) || ratioIn(request) || (/tiktok|reel|short|story|vertical/i.test(request) ? 9 / 16 : 1); video.push({ op: "ratio", ar }); video.push({ op: "follow" }); break; }
        }
        continue;
      }
      switch (u.intent) {
        case "reset": for (const key of Object.keys(adj)) adj[key] = 0; reset = true; notes.push("reset all adjustments"); break;
        case "auto_enhance": {
          const ev = clamp(Math.log2(0.47 / Math.max(0.04, A.mean)), -0.8, 0.8); addA("exposure", ev * 40 * k);
          const spread = A.p99 - A.p1; if (spread < 0.85) addA("contrast", clamp((0.85 - spread) * 70, 4, 25) * k); else addA("contrast", 6 * k);
          if (A.p5 < 0.05 || A.mean < 0.35) addA("shadows", 18 * k); if (A.clipHigh > 0.015 || A.p99 > 0.97) addA("highlights", -22 * k);
          addA("temperature", clamp(-A.castTemp * 70, -15, 15)); addA("tint", clamp(A.castTint * 90, -12, 12));
          addA("vibrance", (A.colorfulness < 0.3 ? 20 : 8) * k); atLeast("sharpen", 15);
          notes.push(`auto-enhanced from the histogram (exposure ${ev >= 0 ? "+" : ""}${(ev * 0.8).toFixed(2)} EV, balanced color, recovered tones)`); break;
        }
        case "brighten": addA("exposure", 24 * k); if (A.mean < 0.3) addA("shadows", 12 * k); notes.push("brightened the exposure"); break;
        case "darken": addA("exposure", -22 * k); if (A.clipHigh > 0.02) addA("highlights", -15 * k); notes.push("darkened the exposure"); break;
        case "contrast_up": addA("contrast", 22 * k); notes.push("added contrast"); break;
        case "contrast_down": addA("contrast", -22 * k); notes.push("softened the contrast"); break;
        case "warmer": addA("temperature", 24 * k); notes.push("warmed the colors"); break;
        case "cooler": addA("temperature", -24 * k); notes.push("cooled the colors"); break;
        case "saturate": addA("saturation", 16 * k); addA("vibrance", 18 * k); notes.push("boosted the color"); break;
        case "desaturate": addA("saturation", -28 * k); notes.push("muted the colors"); break;
        case "black_white": set("mono", 100); addA("contrast", (/high|strong|punch|dramatic/i.test(cl) ? 28 : 12)); notes.push("converted to black & white"); break;
        case "sepia": set("sepia", 75 * Math.min(1.3, k)); atLeast("fade", 12); notes.push("toned it sepia"); break;
        case "vintage": atLeast("fade", 28 * k); atLeast("grain", 30 * k); addA("temperature", 12); addA("saturation", -10); addA("contrast", -4); atLeast("vignette", 25); notes.push("gave it a faded vintage-film look"); break;
        case "cinematic": addA("contrast", 18 * k); addA("saturation", -10); atLeast("fade", 10); atLeast("vignette", 30); jobs.push({ kind: "split_tone", clause: cl, k }); notes.push("applied a cinematic grade"); break;
        case "moody": addA("exposure", -12 * k); addA("contrast", 24 * k); addA("saturation", -18 * k); addA("highlights", -15); addA("temperature", -8); atLeast("vignette", 45 * Math.min(1.5, k)); notes.push("made it dark and moody"); break;
        case "golden_hour": addA("temperature", 32 * k); addA("tint", 6); addA("vibrance", 14 * k); addA("highlights", -8); jobs.push({ kind: "glow", clause: cl, k, warm: true }); notes.push("bathed it in golden-hour light"); break;
        case "vignette_add": atLeast("vignette", 38 * k); notes.push("added a vignette"); break;
        case "vignette_remove": set("vignette", 0); notes.push("removed the vignette"); break;
        case "grain_add": atLeast("grain", 30 * k); notes.push("added film grain"); break;
        case "grain_remove": set("grain", 0); notes.push("removed the grain"); break;
        case "sharpen": atLeast("sharpen", 40 * k); notes.push("sharpened details"); break;
        case "soften": atLeast("blur", 18 * k); notes.push("softened it with a blur"); break;
        case "shadows_up": addA("shadows", 34 * k); notes.push("lifted the shadows"); break;
        case "highlights_down": addA("highlights", -34 * k); notes.push("recovered the highlights"); break;
        case "fix_color": addA("temperature", clamp(-A.castTemp * 140, -35, 35)); addA("tint", clamp(A.castTint * 160, -30, 30)); notes.push(Math.abs(A.castTemp) < 0.02 && Math.abs(A.castTint) < 0.015 ? "checked the white balance (already neutral)" : `neutralized a ${A.castTemp > 0 ? "warm" : "cool"} ${Math.abs(A.castTint) > 0.02 ? (A.castTint > 0 ? "and green " : "and magenta ") : ""}cast`); break;
        case "crop_smart": { const c = bestCrop(A, null); if (c) { crop = c; notes.push("cropped toward the subject on a rule-of-thirds line"); } else notes.push("checked the composition and it's already well balanced, so I didn't crop"); break; }
        case "crop_ratio": { const ar = ratioIn(cl) || ratioIn(request) || 1; const c = bestCrop(A, ar); if (c) { crop = c; notes.push(`cropped to ${ar === 1 ? "square" : ar.toFixed(2) + ":1"} around the subject`); } break; }
        case "rotate": rotate = /180|upside/i.test(cl) ? 180 : /left|counter|anti/i.test(cl) ? 270 : 90; notes.push(`rotated ${rotate === 270 ? "left" : rotate === 180 ? "180°" : "right"}`); break;
        case "flip": flip = /vertical|upside|top/i.test(cl) ? "v" : "h"; notes.push(flip === "v" ? "flipped vertically" : "mirrored horizontally"); break;
        case "remove_bg": removeBg = true; break;
        case "add_text": { const text = u.quote || textFromRequest(request, quotes) || caption(A, request); jobs.push({ kind: "text", clause: cl, k, text, color: colorIn(cl) }); break; }
        case "frame": jobs.push({ kind: "frame", clause: cl, k, color: colorIn(cl) }); break;
        case "abstract": jobs.push({ kind: "abstract", clause: cl, k }); break;
        default: if (JOBS[u.intent]) jobs.push({ kind: u.intent, clause: cl, k }); break;
      }
    }
    if (!intents.length) throw { code: "not_understood", missed, message: missed.length ? `I didn't understand “${missed.join("”, “")}”.` : "Tell me what to change." };
    return { adjustments: adj, resetAdjustments: reset, crop, rotate, flip, removeBackground: removeBg, jobs, video, notes, missed, understood: intents.filter((u) => u.intent !== "abstract").map((u) => ({ intent: u.intent, label: PRETTY[u.intent] || u.intent, p: u.p })) };
  }
  function sentence(parts) {
    const p = parts.filter(Boolean); if (!p.length) return "";
    const s = p.length === 1 ? p[0] : p.slice(0, -1).join(", ") + " and " + p[p.length - 1];
    return titleCase(s) + ".";
  }

  global.FastAI = {
    version: "1.0",
    train, get ready() { return net.ready; }, get stats() { return net.stats; },
    classify, analyze, plan, renderJob, removeBackground, critique, sentence, rngFrom, hashStr,
    skills: Object.keys(PRETTY).map((k) => PRETTY[k]),
  };
})(window);
