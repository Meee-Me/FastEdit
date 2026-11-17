// Fast Edit connector for AI apps (MCP over HTTP, Vercel function): Claude, ChatGPT and any other
// app that supports remote MCP servers.
//
// In the AI app: add a custom connector / remote MCP server -> paste the link Fast Edit shows
// (https://fast-edit-nine.vercel.app/api/mcp?s=<your private code>).
//
// This function holds no files and no keys of its own. It turns Claude's tool calls into
// commands in a small relay (Supabase), which the user's open Fast Edit tab picks up, runs
// and answers. The private code in the link is the only thing that connects the two.

const SUPA = "https://tcrprxgwhfsdkfiatmpe.supabase.co";
const KEY = "sb_publishable_s2o1OqqvDAPJHv94xmJNRQ_HiZ9nNYO"; // publishable: safe to ship; the relay only exposes 5 locked-down functions
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id, accept",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

const TOOLS = [
  { name: "fastedit_look", description: "Take a screenshot of what's in the user's Fast Edit editor right now (the photo, or the current video frame) and report what's open. Call this first, and again after edits to check the result.",
    inputSchema: { type: "object", properties: { at_seconds: { type: "number", description: "Video only: look at this time in the timeline (seconds). Default: the playhead." } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "fastedit_do", description: "Tell Fast Edit AI (the editor's on-device assistant) to do something, in plain English, exactly as the user would type it in its chat. Works for both modes. Photo: \"make it warmer\", \"blur the background\", \"add a caption saying Hello\", \"make a thumbnail\". Video: \"trim the first 2 seconds\", \"make it 15 seconds with the best parts\", \"cinematic and vertical for TikTok\", \"find upbeat music\", \"add a whoosh sound\", \"edit it for me\", \"make a video about my trip\". One clear instruction per call works best; then call fastedit_look to check the result. Returns the assistant's reply and a screenshot.",
    inputSchema: { type: "object", properties: { request: { type: "string", description: "What to do, in plain English." } }, required: ["request"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "fastedit_undo", description: "Undo the last change in Fast Edit.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "fastedit_mode", description: "Switch the editor between Photo and Video mode.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["photo", "video"] } }, required: ["mode"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "fastedit_result", description: "Get the result of a slow fastedit_do (one that said it was still running), using the id it gave.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
];
const TAB_TOOLS = { fastedit_look: "look", fastedit_do: "do", fastedit_undo: "undo", fastedit_mode: "mode" };

const reply = (body, status = 200, extra = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra } });
const rpcOk = (id, result) => reply({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => reply({ jsonrpc: "2.0", id, error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(fn, args) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify(args) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw Object.assign(new Error((data && data.message) || `relay ${r.status}`), { status: r.status });
  return data;
}
const asText = (text, isError) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
function fromTab(res) {
  if (!res) return asText("Fast Edit didn't answer.", true);
  const content = [];
  if (res.text) content.push({ type: "text", text: String(res.text).slice(0, 6000) });
  if (res.image && /^[A-Za-z0-9+/=]+$/.test(res.image) && res.image.length < 1_400_000) content.push({ type: "image", data: res.image, mimeType: "image/jpeg" });
  if (!content.length) content.push({ type: "text", text: "Done." });
  return { content, ...(res.error ? { isError: true } : {}) };
}
async function waitFor(s, id, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await rpc("fe_result", { p_session: s, p_id: id });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return asText("That command has expired. Ask again.", true);
    if (row.status === "done") return fromTab(row.result);
    await sleep(500);
  }
  return asText(`Fast Edit is still working on it (command ${id}). Call fastedit_result with id ${id} in a few seconds.`);
}

async function callTool(s, name, args) {
  if (name === "fastedit_result") return waitFor(s, Math.floor(+args.id), 20000);
  const tool = TAB_TOOLS[name];
  if (!tool) return asText(`Unknown tool ${name}.`, true);
  const tab = (await rpc("fe_tab", { p_session: s }))[0];
  if (!tab || Date.now() - new Date(tab.last_seen).getTime() > 20000) {
    return asText("Fast Edit isn't open right now. Ask the user to open https://fast-edit-nine.vercel.app in their browser, tap \"Connect AI\", and turn on the connection. Then try again.", true);
  }
  if (tool === "do" && !(typeof args.request === "string" && args.request.trim())) return asText("Give a request, like \"make it warmer\".", true);
  if (tool === "mode" && !["photo", "video"].includes(args.mode)) return asText("mode must be photo or video.", true);
  const clean = tool === "do" ? { request: String(args.request).slice(0, 1000) } : tool === "mode" ? { mode: args.mode } : tool === "look" && Number.isFinite(+args.at_seconds) ? { at: +args.at_seconds } : {};
  const id = await rpc("fe_push", { p_session: s, p_tool: tool, p_args: clean });
  return waitFor(s, id, tool === "do" ? 45000 : 20000);
}

async function handle(msg, s) {
  const { id, method, params } = msg || {};
  const isNote = id === undefined || id === null;
  if (method === "initialize") {
    const want = params && params.protocolVersion;
    return rpcOk(id, { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "Fast Edit", version: "1.0.0" },
      instructions: "Fast Edit is a photo and video editor running in the user's browser. Use fastedit_look to see it, fastedit_do to make changes in plain English, and fastedit_look again to check the result." });
  }
  if (method === "ping") return rpcOk(id, {});
  if (method === "tools/list") return rpcOk(id, { tools: TOOLS });
  if (method === "tools/call") {
    try { return rpcOk(id, await callTool(s, params && params.name, (params && params.arguments) || {})); }
    catch (e) { return rpcOk(id, asText(e.status === 400 || e.status === 404 ? "This connector link isn't valid. Copy a new one from Fast Edit." : `Couldn't reach Fast Edit's relay: ${e.message}`, true)); }
  }
  if (isNote) return reply(null, 202);
  return rpcErr(id, -32601, `Method not found: ${method}`);
}

export async function POST(request) {
  const s = new URL(request.url).searchParams.get("s") || "";
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(s)) return reply({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing or invalid connector code. Copy the link from Fast Edit." } }, 401);
  let body; try { body = await request.json(); } catch { return rpcErr(null, -32700, "Parse error"); }
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await handle(m, s); if (r.status !== 202) out.push(await r.json()); }
    return out.length ? reply(out) : reply(null, 202);
  }
  return handle(body, s);
}
export function GET() { return reply({ error: "This is Fast Edit's connector for Claude. Add it in Claude under Settings > Connectors, using the link from Fast Edit." }, 405, { allow: "POST, OPTIONS" }); }
export function DELETE() { return reply(null, 204); }
export function OPTIONS() { return new Response(null, { status: 204, headers: cors }); }
