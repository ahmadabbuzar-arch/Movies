// Same access rule as api/proxy.js: same-origin pages, ALLOWED_ORIGINS, or a request carrying &k=<APP_KEY>.
function allowedOrigin(req) {
  const host = req.headers.host, src = req.headers.origin || req.headers.referer || "";
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  try { const o = new URL(src); if (o.host === host || extra.includes(o.origin)) return o.origin; } catch { /* no origin */ }
  return req.headers["sec-fetch-site"] === "same-origin" ? `https://${host}` : "";
}
function keyOk(req) {
  const key = process.env.APP_KEY; if (!key) return false;
  try { return new URL(req.url, "http://x").searchParams.get("k") === key; } catch { return false; }
}
module.exports = { allowedOrigin, keyOk };
