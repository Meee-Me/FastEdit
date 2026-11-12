# Fast Edit

A layer-based photo editor that runs in the browser, with **its own AI, built from scratch**. Fast Edit AI runs entirely on your device: there's no account and no API key, and your photos never leave your computer. You can also connect your own agent.

## Fast Edit AI

Everything lives in [`fastai.js`](fastai.js), with no libraries or outside services.

| Part | What it does |
| --- | --- |
| **Language model** | A neural network written by hand: hashed word, word-pair and letter-trigram features → 48 tanh units → softmax over 47 editing skills (about 100k parameters). It trains in the browser on page load from about 2,700 generated phrases and takes a couple of seconds. The letter trigrams let it handle typos ("remove the backround", "add vigentte"). A request is split into clauses ("warmer, crop to 4:5 and add stars"), and each clause is classified with a confidence score. Requests it doesn't recognize are rejected rather than guessed at. |
| **Vision** | Measures exposure percentiles, contrast, clipping, gray-world color cast and colorfulness. It also finds a k-means color palette, a frequency-tuned saliency map (where the eye goes), the brightest light source, the horizon and the sky. |
| **Planner** | Turns intents plus analysis into edits: histogram-based auto-enhance, white balance, smart crops that put the subject on a rule-of-thirds line, ratio crops, rotate/flip, and background removal (a border color model + flood fill + largest-component mask). |
| **Generators** | Procedural layers placed using the analysis: captions (with auto-generated titles), frames (clean, polaroid, film, hand-drawn), stars, birds, moon, clouds/fog, sparkles, lens flare, glow, light leak, snow, rain, bokeh, confetti, hearts, retro sun/stripes, and a teal-and-orange grade. |
| **Critique** | Scores the photo and explains exposure, clipping, color cast, saturation and composition, with one-click fixes. |

Try: `warmer with a soft vignette`, `cinematic teal & orange, crop to 16:9`, `add a caption that says "Hello"`, `remove the background`, `add birds and a crescent moon`, `make it snow`.

## Editor

- **Layers:** visibility, opacity, 15 blend modes, reorder, duplicate, merge, fill, place image
- **Tools:** brush, eraser, text, eyedropper, crop, rotate, flip, move, pan
- **Adjustments:** 16 sliders plus presets and a before/after compare
- **Files:** open, drag in or paste images; export PNG, JPEG or WebP; 30-step undo

## Connect your own agent

**Connect agent** → **Your own agent** sends requests to any HTTPS endpoint:

```http
POST <your agent URL>
Authorization: Bearer <token>        # only if you set one
Content-Type: application/json

{ "protocol": "fastedit.agent/v1", "task": "edit" | "art" | "critique" | "ping",
  "prompt": "<instructions, including the JSON shape Fast Edit expects back>",
  "image": { "media_type": "image/jpeg", "data": "<base64>" } | null }
```

Reply `200` with `{ "text": "<reply containing the JSON>" }` or with the JSON object itself. The endpoint must send CORS headers allowing the Fast Edit origin.

## Deploy

It's a static site with no build step. On Vercel, import the repository and deploy. No environment variables are needed.
