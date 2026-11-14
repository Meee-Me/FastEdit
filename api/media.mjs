// Fast Edit media download helper (Vercel function).
//
// GET /api/media?type=audio|images&id=<Openverse id>
//
// Browsers can't download most Creative Commons files directly (their hosts don't allow
// cross-site downloads), so this fetches them for the editor. It is NOT an open proxy:
// it only accepts an Openverse item id, looks that item up on Openverse itself, and
// downloads exactly the file Openverse lists for it (audio or image, up to 25 MB).
// If the source site refuses, it says so; it never tries to get around a refusal.

const UA = "FastEdit/1.0 (+https://fast-edit-nine.vercel.app; Creative Commons media for video editing)";
const MAX = 25 * 1024 * 1024;
const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-fastedit-title, x-fastedit-credit, x-fastedit-license" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const id = q.get("id") || "", type = q.get("type") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !["audio", "images"].includes(type)) {
    return json(400, { code: "bad_request", error: "Ask for an Openverse item: ?type=audio|images&id=<id>." });
  }
  let item;
  try {
    const r = await fetch(`https://api.openverse.org/v1/${type}/${id}/`, { headers: { "user-agent": UA, accept: "application/json" } });
    if (r.status === 404) return json(404, { code: "not_found", error: "That item isn't on Openverse any more." });
    if (!r.ok) return json(502, { code: "openverse", error: `Openverse answered ${r.status}. Try again in a moment.` });
    item = await r.json();
  } catch {
    return json(502, { code: "openverse", error: "Couldn't reach Openverse. Try again in a moment." });
  }
  let target;
  try { target = new URL(item.url); } catch { return json(502, { code: "no_file", error: "Openverse doesn't list a file for that item." }); }
  if (target.protocol !== "https:") return json(502, { code: "no_file", error: "That file isn't served securely, so Fast Edit won't download it." });

  let up;
  try { up = await fetch(target, { headers: { "user-agent": UA }, redirect: "follow" }); }
  catch { return json(502, { code: "source_unreachable", error: `Couldn't reach ${item.source || target.hostname}. Pick another item.` }); }
  if (!up.ok) return json(502, { code: "source_refused", error: `${item.source || target.hostname} didn't allow the download (it answered ${up.status}). Preview still works; pick another item to use.` });

  const ct = (up.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const want = type === "audio" ? /^audio\//.test(ct) || ct === "application/octet-stream" : /^image\//.test(ct);
  if (!want) return json(502, { code: "wrong_type", error: "The source sent something that isn't " + (type === "audio" ? "audio" : "an image") + "." });
  const len = +up.headers.get("content-length") || 0;
  if (len > MAX) return json(413, { code: "too_large", error: `That file is ${(len / 1048576).toFixed(0)} MB; the limit is 25 MB. Pick a shorter one.` });

  // stream it through, stopping at the size limit
  let sent = 0;
  const limited = up.body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) { sent += chunk.byteLength; if (sent > MAX) ctrl.error(new Error("too large")); else ctrl.enqueue(chunk); },
  }));
  const ascii = (s) => encodeURIComponent(String(s || "").slice(0, 300));
  return new Response(limited, {
    status: 200,
    headers: {
      "content-type": type === "audio" && ct === "application/octet-stream" ? "audio/mpeg" : ct,
      "cache-control": "public, max-age=86400",
      "x-fastedit-title": ascii(item.title), "x-fastedit-credit": ascii(item.attribution), "x-fastedit-license": ascii(`${item.license} ${item.license_version || ""}`.trim()),
      ...(len ? { "content-length": String(len) } : {}),
      ...cors,
    },
  });
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, OPTIONS" } }); }
