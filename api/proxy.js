// Vercel serverless function: /api/proxy?u=<url>&h=<json headers>
// Lets the browser app fetch sites that block CORS, send headers like Referer,
// and play HLS (.m3u8) streams. Works for GET/POST/HEAD.
//
// Optional env vars (Vercel -> Settings -> Environment Variables):
//   ALLOWED_ORIGINS  comma list of extra origins allowed to use this proxy (e.g. your GitHub Pages URL)
const dns = require("node:dns").promises;
const net = require("node:net");
const { Readable } = require("node:stream");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function isPrivateIp(ip) {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

async function assertPublicHost(host) {
  if (process.env.PROXY_ALLOW_PRIVATE === "1") return; // local testing only
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    // DNS can fail transiently on serverless (EBUSY / EAI_AGAIN): retry a few times
    for (let i = 0; ; i++) {
      try {
        // c-ares resolver first (not the shared libuv threadpool, which returns EBUSY under load)
        const out = [];
        for (const fn of ["resolve4", "resolve6"]) { try { out.push(...(await dns[fn](host)).map((address) => ({ address }))); } catch { /* none */ } }
        addrs = out.length ? out : await dns.lookup(host, { all: true }); break;
      }
      catch (e) {
        if (i >= 3 || !/EBUSY|EAI_AGAIN|ETIMEOUT|ECONNREFUSED/.test(String(e.code || e.message))) throw e;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Blocked address");
}

async function safeFetch(url, init) {
  let u = url, method = init.method, body = init.body;
  for (let i = 0; i < 5; i++) {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Bad protocol");
    await assertPublicHost(parsed.hostname);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 25000);
    const r = await fetch(u, { ...init, method, body, redirect: "manual", signal: ac.signal });
    clearTimeout(t);
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      u = new URL(loc, u).href;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
      continue;
    }
    return { r, url: u };
  }
  throw new Error("Too many redirects");
}

function allowedOrigin(req) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer || "";
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const o = new URL(src);
    if (o.host === host || extra.includes(o.origin)) return o.origin;
  } catch { /* no origin */ }
  return req.headers["sec-fetch-site"] === "same-origin" ? `https://${host}` : "";
}

module.exports = async (req, res) => {
  const fail = (code, msg) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: msg })); };
  const origin = allowedOrigin(req);
  if (!origin) return fail(403, "Origin not allowed");
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-expose-headers", "content-type,content-range,accept-ranges,x-final-url");
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET,POST,HEAD,OPTIONS");
    res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] || "*");
    res.statusCode = 204; return res.end();
  }

  try {
    const q = new URL(req.url, "http://x").searchParams;
    const target = q.get("u") || "";
    const hjson = q.get("h") || "{}";
    let custom = {};
    try { custom = JSON.parse(hjson) || {}; } catch { /* ignore */ }

    const headers = { "user-agent": UA };
    for (const [k, v] of Object.entries(custom)) if (!/^(host|content-length|connection)$/i.test(k)) headers[k.toLowerCase()] = String(v);
    if (req.headers.range) headers.range = req.headers.range;
    const ct0 = req.headers["content-type"];
    if (ct0 && !headers["content-type"] && !["GET", "HEAD"].includes(req.method)) headers["content-type"] = ct0;

    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      const b = req.body;
      if (Buffer.isBuffer(b) || typeof b === "string") body = b;
      else if (b && typeof b === "object") body = /urlencoded/.test(ct0 || "") ? new URLSearchParams(b).toString() : JSON.stringify(b);
      else { const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks); }
    }

    const { r, url } = await safeFetch(target, { method: req.method, headers, body });
    const ct = r.headers.get("content-type") || "";
    res.statusCode = r.status;
    res.setHeader("x-final-url", url);

    if (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(url)) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const self = `${proto}://${req.headers.host}${(req.url || "").split("?")[0]}`;
      const prox = (abs) => `${self}?u=${encodeURIComponent(abs)}&h=${encodeURIComponent(hjson)}`;
      const text = (await r.text()).split(/\r?\n/).map((line) => {
        if (!line.trim()) return line;
        if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${prox(new URL(u, url).href)}"`);
        return prox(new URL(line.trim(), url).href);
      }).join("\n");
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.end(text);
    }

    const encoded = r.headers.get("content-encoding");
    for (const h of ["content-type", "content-range", "accept-ranges", "content-length"]) {
      const v = r.headers.get(h);
      if (v && !(encoded && h === "content-length")) res.setHeader(h, v);
    }
    if (!r.body || req.method === "HEAD") return res.end();
    const stream = Readable.fromWeb(r.body);
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.end());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) fail(502, e.message); else res.end();
  }
};
