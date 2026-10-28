// GET /api/provider-resolve?id=<provider id>&tmdb=<id>&type=movie|tv[&season=1&episode=1]
// Runs the configured provider on the server (so secrets never reach the browser) and returns only playable stream objects:
//   { streams: [{link,type,server,quality,headers?}] }   or   { error: { code, message } }
const { loadRegistry } = require("./_lib/provider-registry");
const { resolve, ResolveError } = require("./_lib/provider-resolve");
const { allowedOrigin, keyOk } = require("./_lib/origin");

const STATUS = { BAD_REQUEST: 400, PROVIDER_NOT_FOUND: 404, TYPE_NOT_SUPPORTED: 422, PROVIDER_UNAVAILABLE: 503, BACKEND_FAILURE: 502, UNSUPPORTED_FORMAT: 502, MEDIA_UNAVAILABLE: 502, NO_MEDIA: 404 };

module.exports = async (req, res) => {
  const send = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(body)); };
  const origin = allowedOrigin(req) || (keyOk(req) ? "*" : "");
  if (!origin) return send(403, { error: { code: "FORBIDDEN", message: "Origin not allowed" } });
  res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "Origin");
  if (req.method === "OPTIONS") { res.setHeader("access-control-allow-methods", "GET,OPTIONS"); res.statusCode = 204; return res.end(); }
  const q = Object.fromEntries(new URL(req.url, "http://x").searchParams);
  let id = String(q.id || "");
  try {
    const reg = await loadRegistry();
    const p = reg.providers.find((x) => x.id === id);
    if (!p) {
      const d = reg.diagnostics.find((x) => x.id === id);
      if (!d) throw new ResolveError("PROVIDER_NOT_FOUND", "no provider configuration with this id (configuration file missing or not loaded)");
      const code = d.status === "unavailable" ? "PROVIDER_UNAVAILABLE" : "PROVIDER_NOT_FOUND";
      throw new ResolveError(code, d.status === "unavailable" ? "the provider is configured but a server-side requirement (environment variable or adapter module) is missing" : `provider configuration is ${d.status}`);
    }
    const r = await resolve(p, q);
    send(200, { provider: p.id, mock: p.mock, streams: r.streams });
  } catch (e) {
    const code = e instanceof ResolveError ? e.code : "BACKEND_FAILURE";
    console.warn(`[provider-resolve] ${id.slice(0, 40)} ${code}`); // code only: no URLs, headers or tokens in logs
    send(STATUS[code] || 502, { error: { code, message: e instanceof ResolveError ? e.message : "unexpected error" } });
  }
};
