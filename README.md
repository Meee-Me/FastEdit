# Fast Edit

A layer-based photo editor that runs in the browser, with an AI tool you can point at the built-in AI, your own Anthropic key, or **your own agent**.

## Features

- **Layers:** visibility, opacity, 15 blend modes, reorder, duplicate, merge down, fill, place image
- **Tools:** brush, eraser (size, opacity, softness), text, eyedropper, crop with ratios, rotate, flip, move, pan
- **Adjustments:** exposure (EV), contrast, highlights, shadows, fade, temperature, tint, saturation, vibrance, hue, vignette, grain, sharpen, blur, sepia, black & white, plus presets and a before/after compare
- **AI tool:**
  - *Edit photo:* describe an edit and the AI applies adjustments, crops, rotations, and adds text, shapes, glows and frames on a new layer
  - *Generate art:* the AI draws SVG artwork onto a new layer
  - *Critique:* feedback plus suggested edits you can apply in one click
- Open, drag in, or paste images. Export PNG, JPEG or WebP. 30-step undo.

## Connect your agent

Click **Connect agent** in the AI tab and pick one option:

| Option | What it does |
| --- | --- |
| **Fast Edit AI (built in)** | Uses Claude through this deployment's `/api/ai` function and the site owner's `ANTHROPIC_API_KEY`. |
| **Your Anthropic API key** | Each visitor uses their own key. It's saved only in their browser and passed through `/api/ai` to Anthropic per request; the server never stores it. |
| **Your own agent** | Any HTTPS endpoint that speaks the protocol below: your own server, an automation tool, or another model. |
| **Claude on claude.ai** | Shown automatically when the page is opened as a claude.ai artifact. |

### Agent protocol (`fastedit.agent/v1`)

```http
POST <your agent URL>
Authorization: Bearer <token>        # only if you set one
Content-Type: application/json

{
  "protocol": "fastedit.agent/v1",
  "task": "edit" | "art" | "critique" | "ping",
  "prompt": "<full instructions, including the JSON shape Fast Edit expects back>",
  "image": { "media_type": "image/jpeg", "data": "<base64>" } | null
}
```

Reply `200` with `{ "text": "<model reply containing the JSON>" }`, or with the requested JSON object itself. On failure, reply non-2xx with `{ "error": "message" }`. Your endpoint must send CORS headers allowing the Fast Edit origin.

The simplest agent forwards `prompt` and `image` to any vision model and returns its text.

## Deploy on Vercel

1. Import this repository in Vercel (no build step is needed).
2. Optional environment variables:
   - `ANTHROPIC_API_KEY`: turns on the built-in AI. Without it, visitors connect their own key or agent.
   - `FASTEDIT_ACCESS_CODE`: requires a shared code before the built-in AI can spend your key. Strongly recommended on a public URL.
   - `FASTEDIT_MODEL`: model override. The default is `claude-opus-5-5`.

## Local development

```bash
npm install
npx vercel dev
```
