// Minimal local stand-in for Vercel: /api/<name> -> api/<name>.js (plain Node req/res handlers), everything else static.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

function createServer(siteDir) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
    const m = /^\/api\/([a-z-]+)$/.exec(p);
    if (m) {
      const f = path.join(siteDir, "api", m[1] + ".js");
      if (!fs.existsSync(f)) { res.statusCode = 404; return res.end("no such function"); }
      try { return await require(f)(req, res); } catch (e) { res.statusCode = 500; return res.end("function crashed"); }
    }
    const file = path.join(siteDir, p === "/" ? "index.html" : p);
    if (!file.startsWith(siteDir) || p.startsWith("/api/") || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found"); } // api/_* is never served
    res.setHeader("content-type", MIME[path.extname(file)] || "application/octet-stream"); res.end(fs.readFileSync(file));
  });
}
module.exports = { createServer };
