# Fast Edit

A photo **and video** editor that runs in the browser, with **its own AI, built from scratch**. Fast Edit AI runs entirely on your device: there's no account and no API key, and your photos never leave your computer.

## Fast Edit AI

Everything lives in [`fastai.js`](fastai.js), with no libraries or outside services.

| Part | What it does |
| --- | --- |
| **Language model** | A neural network written by hand: hashed word, word-pair and letter-trigram features → 48 tanh units → softmax over 81 skills (photo, video, sound and conversation) (about 100k parameters). It trains in the browser on page load from about 4,600 generated phrases and takes a couple of seconds. The letter trigrams let it handle typos ("remove the backround", "add vigentte"). A request is split into clauses ("warmer, crop to 4:5 and add stars"), and each clause is classified with a confidence score. Requests it doesn't recognize are rejected rather than guessed at. |
| **Vision** | Measures exposure percentiles, contrast, clipping, gray-world color cast and colorfulness. It also finds a k-means color palette, a frequency-tuned saliency map (where the eye goes), the brightest light source, the horizon and the sky. |
| **Planner** | Turns intents plus analysis into edits: histogram-based auto-enhance, white balance, smart crops that put the subject on a rule-of-thirds line, ratio crops, rotate/flip, and background removal (a border color model + flood fill + largest-component mask). |
| **Generators** | Procedural layers placed using the analysis: captions (with auto-generated titles), frames (clean, polaroid, film, hand-drawn), stars, birds, moon, clouds/fog, sparkles, lens flare, glow, light leak, snow, rain, bokeh, confetti, hearts, retro sun/stripes, and a teal-and-orange grade. |
| **Critique** | Scores the photo and explains exposure, clipping, color cast, saturation and composition, with one-click fixes. |

Try: `warmer with a soft vignette`, `cinematic teal & orange, crop to 16:9`, `add a caption that says "Hello"`, `remove the background`, `add birds and a crescent moon`, `make it snow`.

## Chat with Fast Edit AI

The AI tab is a chat, in the style of ChatGPT or Claude, with one conversation for photos and one for videos. Fast Edit AI decides whether each message is conversation or an edit:

- **Edits**: "make it warmer and add a vignette", "blur the background", "trim the first 2 seconds", "vertical for TikTok".
- **Follow-ups**: "stronger", "a bit less", "undo that".
- **Questions**: "how do I crop?", "how do I export?", "is my photo uploaded anywhere?" are answered from a built-in guide to Fast Edit.
- **Attach files**: tap 📎 in the chat (or drop files on it) to give Fast Edit AI your videos, photos and a song. Send them with a request like "make a video about my trip to Rome", or with no message, and it adds them and edits everything into a finished video with a thumbnail. In Photo mode, attaching a photo opens it and carries out any request you sent with it.
- **Editing by itself**: "edit it for me" (optionally "…about my trip to Rome" or "…in 30 seconds") does the whole edit of your footage on its own: splits scenes, keeps the best parts of long videos, removes silent pauses, cleans up and evens out the sound, balances the color, adds a slow zoom to photos, crossfades on every cut, a title intro, fades, and music ducking. Then it makes a thumbnail. It's all one Undo step.
- **Thumbnails**: "make a thumbnail" (or "…called \"My Trip\"") picks the most eye-catching frame (sharp, colorful, well exposed, with a clear subject), punches up the color, outlines the subject when there is one, and sets a big bold title at 1280 × 720. It appears in the chat with **Download** and **Edit in Photo mode** buttons, where the title is its own layer. In Photo mode it turns the current photo into a thumbnail.
- **Creating**: "make a video about Fast Edit" builds an animated title-card video when there's no footage, or edits your footage with that title when there is; "make a poster about Summer Sale" designs a poster from your photo.
- **Small talk**: hello, thanks, "who are you", "what can you do", and a joke if you ask.

It's still the on-device AI built from scratch, not a large language model: it can't answer general knowledge questions, and it says so politely.

## Pro photo tools

- **Menu bar**: File (new, open, place, open/save `.fedit` project, export), Edit (fill, clear, copy/cut to new layer), Image (Curves & Levels, auto tone, image size, crop to selection, rotate, flip), Layer (new, duplicate, delete, merge down, flatten), Select (all, deselect, inverse, select subject, feather, grow), Filter, View.
- **Selections**: rectangle, ellipse, lasso and magic wand (Shift adds, Alt subtracts), plus AI **Select subject**. Brushes, fills, gradients, the clone stamp and filters stay inside the selection.
- **Tools**: shapes (rectangle, rounded, ellipse, line, arrow), gradient (linear, radial, to transparent), paint bucket, clone stamp.
- **Filters with live preview**: Gaussian blur, motion blur, unsharp mask, add noise, pixelate, emboss, find edges, posterize, threshold, invert.
- **Curves & Levels**: master and per-channel curves over a live histogram, plus input/output levels.
- **Layer masks**: hide parts of a layer without erasing them. Add a mask (or one from a selection), click its thumbnail, then the brush hides and the eraser reveals. Turn it off, apply it or delete it. Masks follow crops, rotations, resizes, merges and project files.

## Video mode

Switch to **Video** at the top. Everything runs on your device in [`video.js`](video.js).

- **Timeline:** add several videos, play and scrub, trim each clip's start and end, split at the playhead, reorder, duplicate, delete, and set per-clip speed from 0.25× to 4×.
- **Look:** the same adjustments and presets as photos (except sharpen) applied to every frame, plus a teal-and-orange movie grade.
- **Framing:** 16:9, 9:16 (TikTok, Reels, Shorts), 1:1 or 4:5, with **Follow the subject**, which tracks where the eye goes across the video and keeps it in frame.
- **Text and effects:** captions with timing, moving effects (snow, rain, confetti, sparkles, bokeh, hearts) and still overlays (light leak, glow, flare, stars, moon, birds, fog, retro sun, frames).
- **Sound:** mute, volume up to 200%, fade in/out from and to black, and smart audio tools:
  - **Remove silent parts** decodes the soundtrack, measures loudness 20 times a second, finds pauses against the video's own noise floor and cuts them (with a little padding so words aren't clipped).
  - **Even out loudness** compresses peaks and sets a steady level from the measured loudness.
  - **Reduce hum and rumble** detects 50 or 60 Hz mains hum and notches it and its harmonics out, plus a low cut.
  - **Clearer voices** (presence EQ) and **bass boost**.
- **Color tab**: lift / gamma / gain color wheels, master and per-channel curves, and live waveform, vectorscope and histogram scopes.
- **Transitions** between clips: crossfade, dip to black or white, wipe, slide and zoom, per cut or on every cut. When the outgoing clip has footage past its cut, it keeps playing through the transition instead of freezing.
- **Keyframe animation**: captions, effects and overlays have position, size and opacity that can change over time. Add keyframes at the playhead (moving a slider sets one), or use presets: fly in, pop, slide across, slow push, fade. Or ask the AI to "animate the text".
- **Video and photos on top**: a second track for picture-in-picture, logos or reaction videos, placed, sized and keyframed like any overlay.
- **Music track**: add an MP3, WAV or M4A, set its volume and start, and let it **duck** automatically whenever someone speaks. It fades out at the end and is included in exports.
- **Photos as clips**, shown for 4 seconds by default, with an optional slow zoom.
- **Timeline**: zoom in and out (Ctrl + scroll), drag clip edges to trim, and see each clip's sound as a waveform.
- **Smart shortening:** "make it 15 seconds" keeps the moments with the most movement, sound and color, in order. "Keep the first 10 seconds" or "keep 3 to 8 seconds" still cut exactly.
- **Scene detection:** finds hard cuts by comparing frames and splits the timeline there.
- **Fast Edit AI:** understands requests like "trim the first 2 seconds, slow motion and fade in", "cinematic and vertical for TikTok", "split at scene changes", "speed up 2x and mute", or "falling snow and a caption that says “Winter”".
- **Export:** 480p, 720p or 1080p at 30 fps as MP4.
  - **Frame by frame (exact)**, the default where the browser supports WebCodecs: each frame is rendered and encoded individually, the sound is mixed offline (clips at their speed with the sound effects, music with fades and ducking), and it keeps working if you switch tabs. Titles, photos and effects render faster than real time; camera footage is usually slower, because each frame is located individually in the source.
  - **Real time**: records the video while it plays through once. Keep the tab visible.
  - MP4 packaging uses [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT, in `vendor/`).

## Photo editor

- **Layers:** visibility, opacity, 15 blend modes, reorder, duplicate, merge, fill, place image
- **Tools:** brush, eraser, text, eyedropper, crop, rotate, flip, move, pan
- **Adjustments:** 16 sliders plus presets and a before/after compare
- **Files:** open, drag in or paste images; export PNG, JPEG or WebP; 30-step undo

## Marketplace

**Marketplace** (in the photo menu bar, or top right in Video mode) has free media and add-ons:

- **Music**: Fast Edit originals, composed on your device to fit the video's length (`composer.js`: upbeat, chill, cinematic, energetic, happy, dreamy). They're yours, with no credit needed. Also Creative Commons songs from Jamendo, ccMixter and Wikimedia via [Openverse](https://openverse.org), with previews.
- **Sound effects**: 8 originals made on your device (whoosh, impact, riser, pop, ding, click, swipe, glitch) plus Creative Commons sounds. They go on the sound track at the playhead; click one on the timeline to remove it. They're included in exports.
- **Photos**: Creative Commons photos. In Photo mode they become a new layer; in Video mode, a clip.
- **Looks**, **Effects**, **Templates** (several AI steps in one go) and **Fonts** (Google Fonts).
- **Credits**: every Creative Commons item you use is listed with the credit its license asks for. You can copy the list or add it to the end of the video. "Commercial use OK" (on by default) hides non-commercial licenses. Nothing is No-Derivatives.

Fast Edit AI uses the Marketplace too:

- "find upbeat music" or "find a different song" picks a song close to the video's length.
- "compose cinematic music" writes an original track.
- "add a whoosh sound", "find a photo of mountains" and "add credits to the end" also work.
- If a song can't be downloaded, it composes an original instead.

Fast Edit doesn't download from Google or take copyrighted songs. Everything comes with a license that allows reuse.

`api/media.mjs` is a small Vercel function that downloads an Openverse item for the browser, because most hosts don't allow downloads from other sites.

- It takes only an Openverse id, looks the item up, and fetches exactly the file Openverse lists, up to 25 MB.
- It isn't an open proxy.
- If a host refuses (Freesound often does), Fast Edit says so. Photos then fall back to Openverse's own copy, and the AI picks another item or uses an original.

## Deluxe account

Fast Edit is a Deluxe website. **Sign in with Deluxe Main** (top right) uses your Deluxe account, and the ∷ menu links every Deluxe website. Signing in is optional; guests can use everything.

- **My looks** (in both Adjust tabs) saves your current adjustments as a named look that works on photos and videos. Signed in, looks are kept in your Deluxe account (`Deluxe.data`, key `looks`) on every device. As a guest they stay in this browser and move into your account when you sign in.
- Your photos and videos are never uploaded; only the looks are saved to Deluxe Main.
- Deluxe Main must list Fast Edit's address (`https://fast-edit-nine.vercel.app`) as the `edit` website in its `worker/apps.js`, or sign-in is refused.

## Deploy

It's a static site with no build step, plus one function in `api/` (the Marketplace download helper). On Vercel, import the repository and deploy. No environment variables are needed.
