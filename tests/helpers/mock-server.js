// MOCK provider backend for tests. Everything here is synthetic: media is a generated test pattern (ffmpeg testsrc), not a real title.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SECRET = "SENTINEL-SECRET-123"; // the fake token the mock API insists on; tests assert it never leaks

function makeMedia(dir) {
  const run = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dir });
  const src = ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
  run([...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "test.mp4"]);
  run([...src, "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "aac", "-shortest", "test-vp9.mp4"]); // MP4 container, VP9 video: decodes in browsers without H.264
  run([...src, "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libvorbis", "-shortest", "test.webm"]);
  run([...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_filename", "seg%d.ts", "test.m3u8"]);
}
const TYPES = { ".mp4": "video/mp4", ".webm": "video/webm", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t" };

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pn-media-")); makeMedia(dir);
  const seen = []; // every request the mock received: { url, auth, cookie }
  let base, other;
  const media = (req, res) => {
    const f = path.join(dir, path.basename(new URL(req.url, "http://x").pathname));
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end("nope"); }
    const buf = fs.readFileSync(f), m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    res.setHeader("content-type", TYPES[path.extname(f)] || "application/octet-stream"); res.setHeader("accept-ranges", "bytes"); res.setHeader("access-control-allow-origin", "*");
    if (m) { const a = +m[1], b = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1; res.statusCode = 206; res.setHeader("content-range", `bytes ${a}-${b}/${buf.length}`); return res.end(buf.subarray(a, b + 1)); }
    res.end(buf);
  };
  const json = (res, code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    seen.push({ url: req.url, auth: req.headers.authorization || "", cookie: req.headers.cookie || "", apikey: req.headers["x-api-key"] || "" });
    if (p.startsWith("/media/")) { req.url = p.slice(6); return media(req, res); }
    if (p === "/page.html") { res.setHeader("content-type", "text/html"); return res.end("<!doctype html><html><body>Watch movie</body></html>"); }
    if (p === "/fake.m3u8") { res.setHeader("content-type", "application/vnd.apple.mpegurl"); return res.end("this is not a playlist"); }
    if (p === "/dead.mp4") { res.statusCode = 404; return res.end("gone"); }
    if (p.startsWith("/leak/")) { res.statusCode = 302; res.setHeader("location", `${other}/after-redirect`); return res.end(); }
    const m = /^\/api\/(\w+)(?:\/(movie|tv)\/(\d+))?/.exec(p);
    if (!m) { res.statusCode = 404; return res.end(); }
    const [, name] = m, S = (arr) => ({ data: { streams: arr } });
    switch (name) {
      case "ok": // requires the secret token, like a real authorised API would
        if (req.headers.authorization !== `Bearer ${SECRET}` || u.searchParams.get("api_key") !== SECRET) return json(res, 401, { error: "unauthorised" });
        return json(res, 200, S([{ file: `${base}/media/test.m3u8`, format: "hls", res: "180p", name: "Mock HLS" }, { file: `${base}/media/test.mp4`, format: "mp4", res: "180p", name: "Mock MP4" }, { file: `${base}/media/test.webm`, res: "180p", name: "Mock WebM" }]));
      case "vp9": return json(res, 200, S([{ file: `${base}/media/test-vp9.mp4`, format: "mp4", res: "180p", name: "Mock MP4 (VP9)" }]));
      case "empty": return json(res, 200, S([]));
      case "err500": return json(res, 500, { error: "boom " + SECRET });
      case "slow": return setTimeout(() => json(res, 200, S([])), 3000);
      case "notjson": return json(res, 200, "<html>hello</html>");
      case "badshape": return json(res, 200, { data: { nothing: true } });
      case "html": return json(res, 200, S([{ file: `${base}/page.html`, type: "mp4" }]));
      case "fakehls": return json(res, 200, S([{ file: `${base}/fake.m3u8` }]));
      case "dead": return json(res, 200, S([{ file: `${base}/dead.mp4` }]));
      case "dash": return json(res, 200, S([{ file: `${base}/stream.mpd`, format: "dash" }]));
      case "drm": return json(res, 200, S([{ file: `${base}/media/test.mp4`, drm: { widevine: "https://license.example/x" } }]));
      case "notype": return json(res, 200, S([{ file: `${base}/media/stream` }]));
      case "http": return json(res, 200, S([{ file: "http://example.com/a.mp4" }]));
      case "leak": return json(res, 200, S([{ file: `${base}/leak/video.mp4` }]));
      default: res.statusCode = 404; return res.end();
    }
  });
  const otherServer = http.createServer((req, res) => { seen.push({ url: "OTHER" + req.url, auth: req.headers.authorization || "", cookie: req.headers.cookie || "", apikey: req.headers["x-api-key"] || "" }); res.setHeader("content-type", "video/mp4"); res.end(Buffer.alloc(64)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); await new Promise((r) => otherServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`; other = `http://127.0.0.1:${otherServer.address().port}`;
  return { base, other, dir, seen, SECRET, close: () => { server.close(); otherServer.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { start, SECRET };
