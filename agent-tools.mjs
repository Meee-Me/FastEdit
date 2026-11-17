// The tools an AI gets for Fast Edit. One definition, used by the in-panel chat (Claude, ChatGPT, others)
// and by the private connector link (api/mcp.mjs). The code that runs them is in agent.js / video.js.

const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const num = (description) => ({ type: "number", description });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const ADJ = "exposure, contrast, highlights, shadows (-100..100), fade (0..100), temperature (cool..warm), tint (green..magenta), saturation, vibrance (-100..100), hue (-180..180), sepia, mono (0..100), vignette (0..100), grain (0..100), blur (0..100), sharpen (0..100, photo only)";
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOLS = [
  { name: "fastedit_look", description: "Look at the user's work: a screenshot of the photo, or of the current video frame, plus a description of what's open (photo: size and layers with ids; video: clips, overlays with ids, music, adjustments). Call it before you start and to check your results.",
    inputSchema: obj({ at_seconds: num("Video only: look at this moment of the timeline instead of the playhead.") }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "fastedit_make_video", description: "Make a video from scratch, scene by scene, the way you would storyboard it. Each scene is a full-screen animated title card with your own text, colors, font and timing; scenes are joined with transitions. Use it for intros, promos, slideshows' title cards, stories, quote videos. Write the actual words and choose the colors and pacing yourself. With real footage already on the timeline the scenes go at the start (or the end) instead of replacing it. Afterwards refine with fastedit_timeline, fastedit_text, fastedit_adjust and fastedit_media (music), then look.",
    inputSchema: obj({
      scenes: { type: "array", minItems: 1, maxItems: 30, description: "The scenes in order.", items: obj({
        text: str("The main line (keep it short enough to read in the time)."), sub: str("A smaller second line (optional)."), seconds: num("1 to 15, default 3."),
        bg: { type: "array", items: str("color"), minItems: 1, maxItems: 2, description: "Background: one color or two (a gradient), e.g. [\"#0b1d3a\", \"#7b2ff7\"]. Any CSS color." },
        angle: num("Gradient angle in degrees, default 135."), text_color: str("Text color, default white."), accent: str("Accent bar color, default amber."),
        font: str("Typeface.", { enum: ["display", "serif", "sans", "mono", "script"] }), size: str("Text size.", { enum: ["small", "medium", "large", "huge"] }),
        anim: str("How the text enters.", { enum: ["rise", "fade", "zoom", "slide", "type"] }), blobs: { type: "boolean", description: "Drifting soft light in the background (default true)." }, bar: { type: "boolean", description: "Accent bar under the text (default true)." },
      }, ["text"]) },
      aspect: str("Shape of the video.", { enum: ["16:9", "9:16", "1:1", "4:5", "5:4", "4:3", "3:4", "21:9"] }),
      position: str("replace = the whole video (default when there's no real footage), start or end = add to your footage.", { enum: ["replace", "start", "end"] }),
      transition: obj({ type: str("Between scenes (default cross, 0.5 s).", { enum: ["cross", "wipe", "slide", "zoom", "none"] }), seconds: num("0.2 to 1.5") }),
      particles: str("Floating particles over the scenes.", { enum: ["none", "bokeh", "snow", "confetti", "sparkles", "hearts", "rain"] }),
      fade_in: num("Seconds of fade in at the start."), fade_out: num("Seconds of fade out at the end."),
    }, ["scenes"]), annotations: W },
  { name: "fastedit_timeline", description: "Edit the video timeline with exact operations, applied in order (up to 40 per call). Times are in seconds on the timeline; clips are numbered from 0 (see fastedit_look). Operations: trim_start{seconds}, trim_end{seconds}, keep{from,to}, cut{from,to}, split{at}, delete_clip{index}, move_clip{index,to}, duplicate_clip{index}, clip{index,speed?,in?,out?,ken_burns?}, speed{value 0.25..4 for everything}, fade_in{seconds}, fade_out{seconds}, aspect{ratio: 16:9|9:16|1:1|4:5|5:4|4:3|3:4|21:9|original}, transitions{type: cross|wipe|slide|zoom|none, seconds, index? (one clip) }, mute{on}, volume{value 0..2}, music_volume{value 0..1.5}, ken_burns{on} (slow zoom on photos), remove_silence{long?}, best_moments{seconds} (shorten to the best parts), split_scenes (cut at scene changes), audio{fx: level|hum|voice|bass|reset}, duck{on} (music dips under speech), remove_overlay{id}, edit_overlay{id,start?,end?,x?,y?,scale?,animation?: fade|fly|pop|push|slide}.",
    inputSchema: obj({ ops: { type: "array", minItems: 1, maxItems: 40, items: { type: "object", properties: { op: str("The operation name.") }, required: ["op"], additionalProperties: true } } }, ["ops"]), annotations: W },
  { name: "fastedit_text", description: "Add text. Video: a text overlay for a time range (start/end in seconds; omit both for the whole video), with position, style, color, size and an entrance animation. Photo: a new text layer; x and y are fractions of the picture (0..1, 0.5 is the middle), size is a fraction of the picture height.",
    inputSchema: obj({
      text: str("The words."), start: num("Video: when it appears (seconds)."), end: num("Video: when it disappears."),
      position: str("Video: top, center or bottom.", { enum: ["top", "center", "bottom"] }), style: str("Video: look of the lettering.", { enum: ["serif", "bold", "sans", "handwritten", "typewriter"] }),
      font: str("Photo: sans, display, serif, mono, script, or a Google font name like \"Bebas Neue\"."), color: str("Any CSS color."),
      size: str("Video: text size (default medium).", { enum: ["small", "medium", "large", "huge"] }), size_fraction: num("Photo: size as a fraction of the picture height, 0.01 to 0.6 (default 0.08)."),
      x: num("Video: offset from the center, -1..1. Photo: 0..1 across."), y: num("Video: offset from the center, -1..1. Photo: 0..1 down."), scale: num("Video: size multiplier."),
      animation: str("Video: entrance and exit.", { enum: ["fade", "fly", "pop", "push", "slide"] }),
      weight: num("Photo: 100..900, default 700."), align: str("Photo: text alignment around x.", { enum: ["left", "center", "right"] }), stroke_color: str("Photo: outline color."), shadow: { type: "boolean", description: "Photo: soft shadow (default true)." }, max_width: num("Photo: wrap width as a fraction of the picture, default 0.9."),
    }, ["text"]), annotations: W },
  { name: "fastedit_adjust", description: `Set color and light, exactly, on the current photo or on the whole video. values: ${ADJ}. Or apply a look (Warm film, Cool matte, Noir, Punchy, Faded sepia), reset everything, or (video) switch the cinematic grade. Values you give replace the current ones.`,
    inputSchema: obj({ values: { type: "object", description: "Adjustment name -> number.", additionalProperties: { type: "number" } }, look: str("A look name."), reset: { type: "boolean" }, cinematic: { type: "boolean", description: "Video: cinematic split-tone grade on or off." } }), annotations: W },
  { name: "fastedit_shape", description: "Photo: draw a shape or gradient on a new layer, for backgrounds, banners, color washes and frames. x, y, width, height are fractions of the picture (0..1).",
    inputSchema: obj({ shape: str("What to draw.", { enum: ["rect", "ellipse", "gradient"] }), x: num("Left edge, default 0."), y: num("Top edge, default 0."), width: num("Default 1."), height: num("Default 1."), color: str("Fill color."),
      colors: { type: "array", items: str("color"), minItems: 2, maxItems: 5, description: "Gradient colors." }, angle: num("Gradient angle in degrees, default 90 (top to bottom)."), radius: num("Rounded corners for rect, as a fraction of the shorter side (0..0.5)."),
      opacity: num("Layer opacity 0..1."), blend: str("Blend mode, e.g. multiply, screen, overlay, soft-light."), name: str("Layer name.") }, ["shape"]), annotations: W },
  { name: "fastedit_layers", description: "Photo layers. action: list, set (id plus any of opacity 0..1, blend, visible, name, x, y), delete, duplicate, move (id, to = position from the bottom, 0 is the bottom), select. Layer ids come from fastedit_look.",
    inputSchema: obj({ action: str("What to do.", { enum: ["list", "set", "delete", "duplicate", "move", "select"] }), id: num("Layer id."), opacity: num("0..1"), blend: str("Blend mode."), visible: { type: "boolean" }, name: str("New name."), x: num("Offset in pixels."), y: num("Offset in pixels."), to: num("New position.") }, ["action"]), annotations: W },
  { name: "fastedit_canvas", description: "Photo: change the picture itself. action: crop (x, y, width, height as fractions 0..1 of the picture), rotate (degrees 90, 180 or 270), flip (direction h or v), new (a blank picture: width and height in pixels, color).",
    inputSchema: obj({ action: str("What to do.", { enum: ["crop", "rotate", "flip", "new"] }), x: num("crop left, 0..1"), y: num("crop top, 0..1"), width: num("crop width 0..1, or new width in px"), height: num("crop height 0..1, or new height in px"), degrees: num("90, 180 or 270"), direction: str("flip direction", { enum: ["h", "v"] }), color: str("new picture color") }, ["action"]), annotations: W },
  { name: "fastedit_filter", description: "Photo: apply a filter to the active layer: blur{r}, motion{a,d}, unsharp{amt,r}, noise{amt,mono}, pixelate{s}, emboss{mix}, edges, posterize{n}, threshold{t}, invert. params are the letters in braces (all optional).",
    inputSchema: obj({ name: str("Filter.", { enum: ["blur", "motion", "unsharp", "noise", "pixelate", "emboss", "edges", "posterize", "threshold", "invert"] }), params: { type: "object", additionalProperties: { type: "number" } } }, ["name"]), annotations: W },
  { name: "fastedit_media", description: "Marketplace media, always free to use: original music composed on the device, Creative Commons songs, sound effects, photos. action: find_music (query like \"chill lofi\"; picks a song that fits the video's length; adds it with credit), compose_music (mood: upbeat, chill, cinematic, energetic, happy, dreamy), remove_music, add_sound (name like whoosh, impact, riser, pop, ding, click), find_photo (query; a free photo added as a layer, or a clip in video), add_credits (credits for the Creative Commons media used, at the end of the video). Never use copyrighted songs.",
    inputSchema: obj({ action: str("What to do.", { enum: ["find_music", "compose_music", "remove_music", "add_sound", "find_photo", "add_credits"] }), query: str("What to look for."), mood: str("Mood for composed music."), name: str("Sound effect name.") }, ["action"]), annotations: W },
  { name: "fastedit_do", description: "Hand a short request to Fast Edit's built-in assistant, a small on-device model, in plain English. Use it for what only it can do: remove or blur the background, select the subject, animated effects (snow, rain, confetti, sparkles, light leaks, frames, stars, birds), thumbnails, critique. It understands short commands, not long or subtle ones, so give one clear step at a time. For anything the precise tools above can do, use them instead.",
    inputSchema: obj({ request: str("What to do, in plain English.") }, ["request"]), annotations: W },
  { name: "fastedit_undo", description: "Undo the last change.", inputSchema: obj({}), annotations: W },
  { name: "fastedit_mode", description: "Switch the editor between photo and video mode.", inputSchema: obj({ mode: str("Mode.", { enum: ["photo", "video"] }) }, ["mode"]), annotations: { ...W, idempotentHint: true } },
  { name: "fastedit_export", description: "Save the finished video: exports it and the browser downloads the file. Only do this when the user asks for it or the video is finished and they want it saved.",
    inputSchema: obj({}), annotations: W },
];

const q = (s, n = 60) => String(s ?? "").slice(0, n);
export const LABELS = {
  fastedit_look: () => "looked at your work",
  fastedit_make_video: (a) => `storyboarded a video (${(a.scenes || []).length} scene${(a.scenes || []).length === 1 ? "" : "s"})`,
  fastedit_timeline: (a) => `edited the timeline (${(a.ops || []).map((o) => o.op).slice(0, 4).join(", ")}${(a.ops || []).length > 4 ? "…" : ""})`,
  fastedit_text: (a) => `added text “${q(a.text, 40)}”`,
  fastedit_adjust: (a) => (a.look ? `applied the “${q(a.look)}” look` : a.reset ? "reset the colors" : "set colors and light"),
  fastedit_shape: (a) => `drew a ${q(a.shape)}`,
  fastedit_layers: (a) => `layers: ${q(a.action)}`,
  fastedit_canvas: (a) => `picture: ${q(a.action)}`,
  fastedit_filter: (a) => `applied the ${q(a.name)} filter`,
  fastedit_media: (a) => ({ find_music: `looked for music (${q(a.query)})`, compose_music: `composed ${q(a.mood, 20) || "original"} music`, remove_music: "removed the music", add_sound: `added a ${q(a.name, 30)} sound`, find_photo: `looked for a photo (${q(a.query)})`, add_credits: "added the credits" }[a.action] || "used the Marketplace"),
  fastedit_do: (a) => `asked Fast Edit AI: ${q(a.request, 80)}`,
  fastedit_undo: () => "undid the last change",
  fastedit_mode: (a) => `switched to ${q(a.mode, 10)} mode`,
  fastedit_export: () => "exported the video",
};
export const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
