// Fast Edit "sounds like" helper (Vercel function).
//
// GET /api/spotify?url=<open.spotify.com track link>
//
// Reads a Spotify song's public details (title, artist, year, length) from its public page
// and the artist's genres from MusicBrainz, so Fast Edit can find a free song with a similar
// style. It never fetches or returns Spotify audio: Spotify songs are only played in
// Spotify's own player, for listening.

const UA = "FastEdit/1.0 (+https://fast-edit-nine.vercel.app; finds free music in a similar style)";
const cors = { "access-control-allow-origin": "*" };
const json = (status, body, cache) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cache || "no-store", ...cors } });
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export async function GET(request) {
  const raw = new URL(request.url).searchParams.get("url") || "";
  const m = raw.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]{22})(?:[/?#].*)?$/) || raw.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (!m) return json(400, { code: "bad_link", error: "Paste a Spotify song link, like https://open.spotify.com/track/…" });
  const id = m[1], page = `https://open.spotify.com/track/${id}`;

  let html;
  try {
    const r = await fetch(page, { headers: { "user-agent": UA, "accept-language": "en" } });
    if (r.status === 404) return json(404, { code: "not_found", error: "Spotify doesn't have that song." });
    if (!r.ok) return json(502, { code: "spotify", error: `Spotify answered ${r.status}. Try again in a moment.` });
    html = await r.text();
  } catch { return json(502, { code: "spotify", error: "Couldn't reach Spotify. Try again in a moment." }); }
  const meta = (k) => decode((html.match(new RegExp(`<meta (?:property|name)="${k}" content="([^"]*)"`)) || [])[1]);
  const title = meta("og:title"), desc = meta("og:description").split(" · ");
  if (!title) return json(502, { code: "spotify", error: "Couldn't read that song's details from Spotify." });
  const artist = desc[0] || "", album = desc[1] || "", year = +(meta("music:release_date") || "").slice(0, 4) || +(desc.find((x) => /^\d{4}$/.test(x)) || 0) || null;

  let genres = [];
  if (artist) {
    try {
      const q = new URLSearchParams({ query: `artist:"${artist.split(/,| & | feat\.? /i)[0].trim()}"`, fmt: "json", limit: "1" });
      const mb = () => fetch(`https://musicbrainz.org/ws/2/artist/?${q}`, { headers: { "user-agent": UA, accept: "application/json" } });
      let r = await mb();
      if (r.status === 503) { await new Promise((ok) => setTimeout(ok, 1100)); r = await mb(); } // MusicBrainz allows about one request a second
      if (r.ok) { const a = ((await r.json()).artists || [])[0]; if (a && a.score >= 90) genres = (a.tags || []).sort((x, y) => y.count - x.count).slice(0, 6).map((t) => t.name); }
    } catch {}
  }
  return json(200, {
    id, title, artist, album, year, duration: +meta("music:duration") || null, image: meta("og:image"), genres,
    embed: `https://open.spotify.com/embed/track/${id}`, link: page,
  }, "public, max-age=86400");
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, OPTIONS" } }); }
