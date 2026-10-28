// Turns "tmdb id + movie/tv + season/episode" into a list of playable, verified stream objects for ONE registered provider.
// Every failure maps to a diagnostic code so the player can say what is wrong:
//   TYPE_NOT_SUPPORTED, PROVIDER_UNAVAILABLE, BACKEND_FAILURE, UNSUPPORTED_FORMAT, MEDIA_UNAVAILABLE, NO_MEDIA
const { safeFetch, readLimited, FetchError } = require("./safe-fetch");
const { MEDIA_TYPES, ENV_RE } = require("./provider-schema");

const DRM_KEYS = ["drm", "license", "licenseUrl", "license_url", "widevine", "playready", "fairplay", "keyId", "key_id", "pssh"];
const MAX_STREAMS = 20;

class ResolveError extends Error { constructor(code, message) { super(message); this.code = code; } }

const getPath = (obj, p) => {
  if (!p) return obj;
  return String(p).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce((o, k) => (o != null && typeof o === "object" ? o[k] : undefined), obj);
};
const fill = (tpl, a, enc, env) => String(tpl).replace(/\{tmdb\}/g, a.tmdb).replace(/\{type\}/g, a.type).replace(/\{season\}/g, a.season).replace(/\{episode\}/g, a.episode)
  .replace(ENV_RE, (_m, n) => enc(env[n] ?? ""));
const guessType = (u) => { try { const p = new URL(u).pathname; return /\.m3u8$/i.test(p) ? "m3u8" : /\.mpd$/i.test(p) ? "mpd" : /\.(mp4|m4v)$/i.test(p) ? "mp4" : /\.webm$/i.test(p) ? "webm" : ""; } catch { return ""; } };
const hostOk = (host, list) => !list || !list.length || list.some((p) => (p.startsWith("*.") ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p));

function cleanArgs(q) {
  const tmdb = String(q.tmdb || ""), type = q.type === "tv" ? "tv" : q.type === "movie" ? "movie" : "";
  if (!/^\d{1,10}$/.test(tmdb) || !type) throw new ResolveError("BAD_REQUEST", "tmdb must be a number and type must be movie or tv");
  const num = (v) => (v == null || v === "" ? 1 : /^\d{1,4}$/.test(String(v)) ? Number(v) : NaN);
  const season = num(q.season), episode = num(q.episode);
  if (Number.isNaN(season) || Number.isNaN(episode)) throw new ResolveError("BAD_REQUEST", "season and episode must be numbers");
  return { tmdb, type, season, episode };
}

// Raw items (from an http-json response or an adapter) -> verified stream objects. `dropped` collects the reason for every rejected item.
async function toStreams(items, p, dropped, { fetcher = safeFetch, allowHttp = false } = {}) {
  const rs = p.def.response || {}, f = rs.fields || {}, pb = p.def.playback || {};
  const out = [], seen = new Set();
  const drop = (reason) => dropped.push(reason);
  const fld = (o, key) => (f[key] ? getPath(o, f[key]) : undefined); // a mapping is optional; without one only the default names are tried
  for (const raw of items.slice(0, 60)) {
    if (out.length >= MAX_STREAMS) break;
    const o = typeof raw === "string" ? { url: raw } : raw && typeof raw === "object" ? raw : null;
    if (!o) { drop("unsupported: entry is not an object or URL"); continue; }
    if (DRM_KEYS.some((k) => o[k] != null && o[k] !== false)) { drop("unsupported: DRM-protected stream"); continue; }
    const url = String(fld(o, "url") ?? o.url ?? o.file ?? o.src ?? o.link ?? o.stream ?? "").trim();
    if (!url) { drop("unsupported: entry has no URL"); continue; }
    let u; try { u = new URL(url); } catch { drop("unsupported: entry URL is not absolute"); continue; }
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) { drop("unsupported: stream URL is not https"); continue; }
    if (u.username || u.password) { drop("unsupported: stream URL contains credentials"); continue; }
    if (!hostOk(u.hostname, pb.allowedHosts)) { drop("blocked: stream host is not in playback.allowedHosts"); continue; }
    let type = String(fld(o, "type") ?? o.type ?? o.format ?? "").toLowerCase().replace(/^hls$/, "m3u8").replace(/^dash$/, "mpd") || guessType(url) || rs.defaultType || "";
    if (type === "mpd") { drop("unsupported: DASH (.mpd) streams are not supported by the player"); continue; }
    if (!MEDIA_TYPES.includes(type)) { drop(`unsupported: ${type ? `media type "${type}"` : "media type could not be determined (an HLS/MP4 URL or a type field is required)"}`); continue; }
    if (seen.has(url)) continue; seen.add(url);
    if (pb.verify !== false) { // never hand the player a web page or a dead link
      try {
        const r = await fetcher(url, { headers: { ...(pb.headers || {}), range: "bytes=0-2047" }, timeoutMs: 7000, allowHttp });
        if (r.status >= 400) { drop(`unavailable: media host answered HTTP ${r.status}`); try { await r.body?.cancel(); } catch {} continue; }
        const ct = (r.headers.get("content-type") || "").toLowerCase(), head = await readLimited(r, 2048);
        if (/text\/html|application\/xhtml/.test(ct) || /^\s*<(!doctype|html)/i.test(head.toString("utf8", 0, 64))) { drop("unsupported: URL is a web page, not a media file"); continue; }
        if (type === "m3u8" && !head.toString("utf8").replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U")) { drop("unsupported: URL is not an HLS playlist"); continue; }
        if (type !== "m3u8" && /^(text\/|application\/(json|xml))/.test(ct)) { drop(`unsupported: URL returned ${ct.split(";")[0]}, not video`); continue; }
        if (type !== "m3u8" && !head.length) { drop("unavailable: media host returned no data"); continue; }
      } catch (e) { drop(`unavailable: media host ${e instanceof FetchError ? e.message : "check failed"}`); continue; }
    }
    const lang = fld(o, "language") ?? o.language ?? o.lang;
    out.push({ link: url, type, server: String(fld(o, "label") ?? o.label ?? o.name ?? o.server ?? p.name).slice(0, 60), quality: String(fld(o, "quality") ?? o.quality ?? o.resolution ?? o.res ?? "").slice(0, 12),
      ...(lang ? { language: String(lang).slice(0, 20) } : {}), ...(pb.headers && Object.keys(pb.headers).length ? { headers: pb.headers } : {}) });
  }
  return out;
}

async function fetchJson(p, a, fetcher, allowHttp, env) {
  const rq = p.def.request, tpl = rq.url || (a.type === "tv" ? rq.tvUrl : rq.movieUrl);
  let u; try { u = new URL(fill(tpl, a, encodeURIComponent, env)); } catch { throw new ResolveError("BACKEND_FAILURE", "request URL could not be built"); }
  for (const [k, v] of Object.entries(rq.query || {})) u.searchParams.set(k, fill(v, a, (x) => x, env));
  const headers = { accept: "application/json" };
  for (const [k, v] of Object.entries(rq.headers || {})) headers[k.toLowerCase()] = fill(v, a, (x) => x, env);
  let r;
  try { r = await fetcher(u.href, { headers, timeoutMs: rq.timeoutMs || 10000, allowHttp }); }
  catch (e) { throw new ResolveError("BACKEND_FAILURE", e instanceof FetchError ? `provider backend: ${e.message}` : "provider backend request failed"); }
  if (r.status === 404) { try { await r.body?.cancel(); } catch {} throw new ResolveError("NO_MEDIA", "the provider does not have this title (HTTP 404)"); }
  if (!r.ok) { try { await r.body?.cancel(); } catch {} throw new ResolveError("BACKEND_FAILURE", `provider backend answered HTTP ${r.status}`); }
  const text = (await readLimited(r, 1000000)).toString("utf8");
  try { return JSON.parse(text); } catch { throw new ResolveError("UNSUPPORTED_FORMAT", "provider response is not JSON"); }
}

async function resolve(p, query, { fetcher = safeFetch, env = process.env, allowHttp = env.PROVIDER_ALLOW_HTTP === "1" } = {}) {
  const a = cleanArgs(query);
  if (!p.caps[a.type]) throw new ResolveError("TYPE_NOT_SUPPORTED", `this provider does not support ${a.type === "tv" ? "series" : "movies"}`);
  const dropped = [];
  let items;
  if (p.kind === "embed") {
    const tpl = p.def.embed[a.type];
    return { streams: [{ link: fill(tpl, a, encodeURIComponent, env), type: "embed", server: p.name }], dropped };
  }
  if (p.kind === "adapter") {
    const adapterEnv = Object.fromEntries(p.adapter.requiredEnv.map((n) => [n, env[n]])); // the adapter only sees the variables it declared
    try {
      items = await Promise.race([p.adapter.mod.resolve({ tmdbId: a.tmdb, type: a.type, season: a.season, episode: a.episode, env: adapterEnv, fetch: (u, o) => fetcher(u, { allowHttp, ...o }), readLimited }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 20000))]);
    } catch (e) { throw new ResolveError("BACKEND_FAILURE", `adapter "${p.def.adapter}" failed: ${e instanceof FetchError ? e.message : "error"}`); }
    if (!Array.isArray(items)) throw new ResolveError("UNSUPPORTED_FORMAT", `adapter "${p.def.adapter}" must return an array`);
  } else {
    const j = await fetchJson(p, a, fetcher, allowHttp, env);
    const node = getPath(j, p.def.response.streamsPath || "");
    items = Array.isArray(node) ? node : node && typeof node === "object" ? [node] : null;
    if (!items) throw new ResolveError("UNSUPPORTED_FORMAT", `response has no list of streams at "${p.def.response.streamsPath || "(root)"}"`);
  }
  if (!items.length) throw new ResolveError("NO_MEDIA", "the provider returned no streams for this title");
  const streams = await toStreams(items, p, dropped, { fetcher, allowHttp });
  if (!streams.length) {
    const unsupported = dropped.some((d) => /^unsupported|^blocked/.test(d));
    throw new ResolveError(unsupported ? "UNSUPPORTED_FORMAT" : "MEDIA_UNAVAILABLE", `${items.length} stream(s) returned but none playable: ${[...new Set(dropped)].slice(0, 3).join("; ")}`);
  }
  return { streams, dropped };
}

module.exports = { resolve, toStreams, cleanArgs, ResolveError, getPath };
