// Server-side fetch used by the provider adapter: public hosts only, bounded time and size,
// credentials are never forwarded to a different origin on redirect.
const dns = require("node:dns").promises;
const net = require("node:net");

const UA = "Mozilla/5.0 (compatible; PopcornNet-provider/1.0)";
const KEEP_ON_CROSS_ORIGIN = /^(accept|accept-language|user-agent|range)$/i;

function isPrivateIp(ip) {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

async function assertPublicHost(host) {
  if (process.env.PROXY_ALLOW_PRIVATE === "1") return; // local testing only (same switch as api/proxy.js)
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    const out = [];
    for (const fn of ["resolve4", "resolve6"]) { try { out.push(...(await dns[fn](host)).map((address) => ({ address }))); } catch { /* none */ } }
    addrs = out.length ? out : await dns.lookup(host, { all: true });
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("blocked address");
}

class FetchError extends Error { constructor(kind, message) { super(message); this.kind = kind; } } // kind: timeout | network | blocked | redirects

// Returns the Response (body not yet read). Messages never contain the URL, because URLs may carry credentials.
async function safeFetch(url, { headers = {}, timeoutMs = 10000, method = "GET", allowHttp = false } = {}) {
  let u = url, h = { "user-agent": UA, ...headers };
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop < 4; hop++) {
    let parsed; try { parsed = new URL(u); } catch { throw new FetchError("blocked", "invalid URL"); }
    if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) throw new FetchError("blocked", "only https is allowed");
    try { await assertPublicHost(parsed.hostname); } catch { throw new FetchError("blocked", "address not allowed"); }
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), Math.max(1, deadline - Date.now()));
    let r;
    try { r = await fetch(u, { method, headers: h, redirect: "manual", signal: ac.signal }); }
    catch (e) { clearTimeout(t); throw new FetchError(ac.signal.aborted ? "timeout" : "network", ac.signal.aborted ? "request timed out" : "network error"); }
    clearTimeout(t);
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      const next = new URL(loc, u);
      if (next.origin !== parsed.origin) h = Object.fromEntries(Object.entries(h).filter(([k]) => KEEP_ON_CROSS_ORIGIN.test(k))); // drop credentials/custom headers
      u = next.href; try { await r.body?.cancel(); } catch { /* ignore */ }
      continue;
    }
    return r;
  }
  throw new FetchError("redirects", "too many redirects");
}

async function readLimited(res, max) { // reads at most `max` bytes, then stops the download
  const chunks = []; let n = 0;
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); n += value.length;
      if (n >= max) break;
    }
  } finally { try { await reader.cancel(); } catch { /* ignore */ } }
  return Buffer.concat(chunks).subarray(0, max);
}

module.exports = { safeFetch, readLimited, FetchError, isPrivateIp };
