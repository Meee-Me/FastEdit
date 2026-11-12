// Fast Edit AI endpoint (Vercel Node function).
//
// GET  /api/ai  -> { configured, accessCodeRequired, model }
// POST /api/ai  -> { text, truncated }
//   body:    { prompt: string, image?: { media_type, data /* base64 */ } }
//   headers: x-anthropic-key  (optional: the visitor's own Anthropic API key, used for this request only, never stored)
//            x-access-code    (required when FASTEDIT_ACCESS_CODE is set and no visitor key is sent)
//
// Environment:
//   ANTHROPIC_API_KEY     key for the built-in AI (optional; without it visitors must bring their own key or agent)
//   FASTEDIT_ACCESS_CODE  optional shared code that gates the built-in key so strangers can't spend it
//   FASTEDIT_MODEL        optional model override (default claude-opus-5-5)
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.FASTEDIT_MODEL || "claude-opus-5-5";
// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-2", "claude-fable-5-1", "claude-sonnet-5-5"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_PROMPT_CHARS = 200_000;
const MAX_IMAGE_B64 = 5_000_000;

const fail = (res, status, code, error) => res.status(status).json({ code, error });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      accessCodeRequired: Boolean(process.env.FASTEDIT_ACCESS_CODE),
      model: MODEL,
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const visitorKey = typeof req.headers["x-anthropic-key"] === "string" ? req.headers["x-anthropic-key"].trim() : "";
  if (!visitorKey) {
    const required = process.env.FASTEDIT_ACCESS_CODE;
    if (required && req.headers["x-access-code"] !== required) {
      return fail(res, 401, "access_code", "This Fast Edit needs an access code for the built-in AI. Enter it under Connect agent, or use your own key or agent.");
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return fail(res, 503, "not_configured", "The built-in AI isn't set up on this deployment. Open Connect agent and use your own Anthropic key or your own agent.");
    }
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return fail(res, 400, "bad_request", "Missing prompt.");
  if (prompt.length > MAX_PROMPT_CHARS) return fail(res, 413, "prompt_too_large", "That request is too long.");

  const content = [];
  const img = body.image;
  if (img) {
    if (!IMAGE_TYPES.has(img.media_type) || typeof img.data !== "string" || img.data.length > MAX_IMAGE_B64) {
      return fail(res, 400, "image_rejected", "The image must be a JPEG, PNG, WebP or GIF under about 3.5 MB.");
    }
    content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  }
  content.push({ type: "text", text: prompt });

  const client = new Anthropic({ apiKey: visitorKey || process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 115_000 });

  try {
    const params = {
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content }],
    };
    if (FALLBACK_MODELS.has(MODEL)) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const message = await client.beta.messages.create(params);

    if (message.stop_reason === "refusal") return fail(res, 422, "refused", "Claude declined this request.");
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!text.trim()) return fail(res, 502, "empty_completion", "Claude didn't return anything. Try again.");
    return res.status(200).json({ text, truncated: message.stop_reason === "max_tokens" });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return fail(res, 401, "bad_key", visitorKey ? "Anthropic rejected that API key. Check it under Connect agent." : "The server's Anthropic key was rejected.");
    }
    if (err instanceof Anthropic.RateLimitError) return fail(res, 429, "rate_limited", "Too many requests right now. Wait a minute, then try again.");
    if (err instanceof Anthropic.BadRequestError) return fail(res, 400, "bad_request", err.message);
    if (err instanceof Anthropic.APIConnectionTimeoutError) return fail(res, 504, "timeout", "Claude took too long. Try a simpler request.");
    if (err instanceof Anthropic.APIConnectionError) return fail(res, 502, "upstream_error", "Couldn't reach Anthropic. Try again.");
    if (err instanceof Anthropic.APIError) return fail(res, 502, "upstream_error", "Anthropic returned an error. Try again shortly.");
    console.error(err);
    return fail(res, 500, "server_error", "Something went wrong on the server.");
  }
}
