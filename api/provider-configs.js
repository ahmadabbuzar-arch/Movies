// GET /api/provider-configs -> the configured providers that are ready, plus a diagnostic for every definition.
// Never returns URLs, headers, query values, cookies, tokens or environment variable names.
// Detailed diagnostics (which env variable is missing) need PROVIDER_DIAG_KEY and ?key=<that value>.
const { loadRegistry, publicView } = require("./_lib/provider-registry");
const { allowedOrigin, keyOk } = require("./_lib/origin");

module.exports = async (req, res) => {
  const send = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(body)); };
  const origin = allowedOrigin(req) || (keyOk(req) ? "*" : "");
  if (!origin) return send(403, { error: "Origin not allowed" });
  res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "Origin");
  if (req.method === "OPTIONS") { res.setHeader("access-control-allow-methods", "GET,OPTIONS"); res.statusCode = 204; return res.end(); }
  try {
    const q = new URL(req.url, "http://x").searchParams, dk = process.env.PROVIDER_DIAG_KEY;
    const detailed = !!dk && q.get("key") === dk;
    send(200, publicView(await loadRegistry(), { detailed }));
  } catch (e) { send(500, { error: "provider registry failed", code: "REGISTRY_FAILURE" }); }
};
