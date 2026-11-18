// Fast Edit connector for AI apps (MCP over HTTP, Vercel function): Claude, ChatGPT and any other
// app that supports remote MCP servers.
//
// In the AI app: add a custom connector / remote MCP server -> paste the link Fast Edit shows
// (https://fast-edit-nine.vercel.app/api/mcp?s=<your private code>).
//
// This function holds no files and no keys of its own. It turns Claude's tool calls into
// commands in a small relay (Supabase), which the user's open Fast Edit tab picks up, runs
// and answers. The private code in the link is the only thing that connects the two.

import { TOOLS as SHARED, BY_NAME } from "../agent-tools.mjs";

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
  ...SHARED.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  { name: "fastedit_result", description: "Get the result of a slow tool call (one that said it was still running), using the id it gave.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
];
TOOLS.push({ name: "fastedit_inbox", description: "Read what the user typed in Fast Edit's chat panel for you. Call it whenever the user tells you to check Fast Edit, and at the start of a session. Then do what they asked with the other fastedit tools. Pass after = the highest seq you've already seen to get only new messages.",
  inputSchema: { type: "object", properties: { after: { type: "number", description: "Only messages newer than this seq." } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } });
const SLOW = new Set(["fastedit_do", "fastedit_make_video", "fastedit_timeline", "fastedit_media", "fastedit_export"]);

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
  if (name === "fastedit_inbox") {
    const tab = (await rpc("fe_tab", { p_session: s }))[0];
    if (!tab) return asText("Fast Edit isn't open. Ask the user to open https://fast-edit-nine.vercel.app, tap \"Connect AI\", and turn on the connection.", true);
    const open = Date.now() - new Date(tab.last_seen).getTime() < 20000, after = Number.isFinite(+args.after) ? +args.after : 0;
    const msgs = ((tab.info && tab.info.inbox) || []).filter((m) => m.seq > after);
    if (msgs.length && open) { // tell the open tab these were read, so Fast Edit AI doesn't also do them
      try { await rpc("fe_push", { p_session: s, p_tool: "inbox_read", p_args: { upto: msgs[msgs.length - 1].seq } }); } catch {}
    }
    const body = msgs.length ? msgs.map((m) => `#${m.seq} (${m.mode} mode): ${m.text}`).join("\n") : "No new messages.";
    return asText(`${body}${msgs.length ? `\n\n(latest seq: ${msgs[msgs.length - 1].seq})` : ""}${open ? "" : "\n\nNote: Fast Edit isn't open in the browser right now, so edits won't work until the user opens it."}`);
  }
  if (!BY_NAME[name]) return asText(`Unknown tool ${name}.`, true);
  const tab = (await rpc("fe_tab", { p_session: s }))[0];
  if (!tab || Date.now() - new Date(tab.last_seen).getTime() > 20000) {
    return asText("Fast Edit isn't open right now. Ask the user to open https://fast-edit-nine.vercel.app in their browser, tap \"Connect AI\", and turn on the connection. Then try again.", true);
  }
  const json = JSON.stringify(args || {});
  if (json.length > 15000) return asText("That request is too large. Send it in smaller steps.", true);
  const id = await rpc("fe_push", { p_session: s, p_tool: name.replace(/^fastedit_/, ""), p_args: JSON.parse(json) });
  return waitFor(s, id, SLOW.has(name) ? 45000 : 20000);
}

async function handle(msg, s) {
  const { id, method, params } = msg || {};
  const isNote = id === undefined || id === null;
  if (method === "initialize") {
    const want = params && params.protocolVersion;
    return rpcOk(id, { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "Fast Edit", version: "1.0.0" },
      instructions: "Fast Edit is a photo and video editor running in the user's browser. Use fastedit_look to see their work. Then use your own judgment and creativity: the precise tools (text, colors, shapes, layers, a scene-by-scene video maker, an exact timeline editor, free music and sounds) let you make real edits, and fastedit_do hands short requests to a small built-in assistant for things only it can do (remove or blur a background, animated effects, thumbnails). Look again to check results." });
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
