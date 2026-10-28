// Real-browser test (Playwright + Chromium): loads the actual index.html from a local dev server with MOCK providers.
// Run: node tests/e2e-browser.js      (needs ffmpeg and a Chromium/Chrome; no internet. hls.js comes from a CDN, so HLS playback is NOT covered here.)
process.env.PROVIDER_ALLOW_HTTP = "1"; process.env.PROXY_ALLOW_PRIVATE = "1"; process.env.PROVIDER_TEST_TOKEN = "SENTINEL-SECRET-123";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/home/claude/.npm-global/lib/node_modules/playwright");
const mock = require("./helpers/mock-server"), { createServer } = require("./helpers/dev-server");
const ROOT = path.join(__dirname, "..");
const results = [];
const check = (name, fn) => Promise.resolve().then(fn).then(() => { results.push(["PASS", name]); console.log("PASS", name); }, (e) => { results.push(["FAIL", name + " :: " + e.message]); console.log("FAIL", name, "::", e.message); });

(async () => {
  const M = await mock.start();
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "pn-site-")), cfg = path.join(site, "cfgdir"); fs.mkdirSync(cfg);
  fs.cpSync(path.join(ROOT, "api"), path.join(site, "api"), { recursive: true }); fs.cpSync(path.join(ROOT, "providers"), path.join(site, "providers"), { recursive: true });
  for (const f of ["index.html", "blocked.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(site, f));
  // pre-existing provider formats must keep working. Two separate scenarios, because the original loader (unchanged) ignores
  // embed-template .json files when a single-file .js bundle sits in the same folder.
  const PROV = path.join(site, "providers");
  const SCEN = {
    "legacy embed-template .json": () => fs.writeFileSync(path.join(PROV, "mock-embed.json"), JSON.stringify({ name: "Mock Embed", movie: "https://embed.example/movie/{tmdb}", tv: "https://embed.example/tv/{tmdb}/{season}/{episode}" })),
    "legacy native .js": () => fs.writeFileSync(path.join(PROV, "mock-native.js"), `module.exports = { id: "mock-native", name: "Mock Native", async getStreams(id){ return [{ link: ${JSON.stringify(M.base + "/media/test.webm")}, type: "webm", server: "mock native" }]; } };`),
  };
  const d = (id, api, extra = {}) => ({ schema: "popcornnet.provider/1", id, name: "Mock " + id, mock: true, kind: "http-json", request: { url: `${M.base}/api/${api}/{type}/{tmdb}`, timeoutMs: 2000, ...(extra.request || {}) }, response: { streamsPath: "data.streams", fields: { url: "file", type: "format", quality: "res", label: "name" }, ...(extra.response || {}) }, ...(extra.top || {}) });
  fs.writeFileSync(path.join(cfg, "all.json"), JSON.stringify([
    d("http", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" }, query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } } }),
    d("vp9", "vp9"), d("empty", "empty"), d("html", "html"), d("backend-down", "err500"),
    d("post-only", "empty", { request: { method: "POST" } }), d("needs-env", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_NOT_SET_ANYWHERE}" } } }),
  ]));
  fs.writeFileSync(path.join(cfg, "broken.json"), "{ \"schema\": ");
  process.env.PROVIDER_CONFIG_DIR = cfg; process.chdir(site);
  const srv = createServer(site); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${srv.address().port}`;

  let browser, used;
  for (const opt of [{ executablePath: "/opt/google/chrome/chrome" }, {}]) { try { browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], ...opt }); used = opt.executablePath || "playwright chromium"; break; } catch (e) { console.log("launch failed:", (opt.executablePath || "default"), e.message.split("\n")[0]); } }
  if (!browser) { console.log("NO BROWSER AVAILABLE"); process.exit(2); }
  console.log("browser:", used, await browser.version());
  const page = await browser.newPage(); const requests = [], pageErrors = [];
  page.on("request", (r) => requests.push({ url: r.url(), headers: r.headers() })); page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route(/cdnjs|jsdelivr|unpkg|v3-cinemeta|image\.tmdb|fonts\.g/, (r) => r.abort()); // offline sandbox: external hosts are unreachable
  for (const [label, setup] of Object.entries(SCEN)) {
    for (const f of fs.readdirSync(PROV)) if (/^mock-/.test(f)) fs.unlinkSync(path.join(PROV, f)); setup();
    await page.goto(base + "/?" + Date.now() + "#debug"); await page.waitForSelector("pre.diag", { timeout: 20000 });
    const rep = await page.$eval("pre.diag", (e) => e.textContent), ids = await page.evaluate(() => S.providers.map((p) => p.id));
    if (label.includes("native")) console.log("---- #debug report ----\n" + rep + "\n-----------------------");
    await check(`existing provider still loads: ${label}`, () => { assert.match(rep, label.includes("embed") ? /Mock Embed/ : /Mock Native/); assert.ok(ids.includes(label.includes("embed") ? "mock-embed" : "mock-native"), ids.join()); });
    await check(`configured providers register alongside it (${label})`, () => { assert.ok(ids.includes("cfg-http")); assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.join()); });
  }
  const report = await page.$eval("pre.diag", (e) => e.textContent), ids = await page.evaluate(() => S.providers.map((p) => p.id));
  await check("configured providers report: ready / invalid / unsupported / unavailable", () => {
    assert.match(report, /configured providers \(5 ready of 8\)/); assert.match(report, /http: ready/); assert.match(report, /post-only: unsupported — unsupported: request\.method POST/);
    assert.match(report, /needs-env: unavailable/); assert.match(report, /broken\.json: invalid — malformed JSON/);
  });
  await check("unsupported / unavailable definitions are not registered as providers", () => { for (const id of ["cfg-needs-env", "cfg-post-only"]) assert.ok(!ids.includes(id), id); });
  const streams = await page.evaluate(async () => (await S.providers.find((p) => p.id === "cfg-http").getStream({ link: "603" })).map((s) => ({ type: s.type, link: s.link, server: s.server, quality: s.quality })));
  await check("configured provider returns verified streams through the existing loader/normaliser", () => assert.deepEqual(streams.map((s) => s.type), ["m3u8", "mp4", "webm"]));
  const call = (id) => page.evaluate(async (id) => { try { return { ok: await S.providers.find((p) => p.id === id).getStream({ link: "603" }) }; } catch (e) { return { err: e.message }; } }, id);
  await check("no stream for the title -> empty result with a diagnostic in the player log", async () => { const r = await call("cfg-empty"); assert.deepEqual(r.ok, []); assert.match(await page.evaluate(() => PLOG.join("\n")), /\[config:empty\] NO_MEDIA/); });
  await check("web page instead of media -> UNSUPPORTED_FORMAT message", async () => { const r = await call("cfg-html"); assert.match(r.err, /^\[UNSUPPORTED_FORMAT\].*web page/); });
  await check("backend failure -> BACKEND_FAILURE message", async () => { const r = await call("cfg-backend-down"); assert.match(r.err, /^\[BACKEND_FAILURE\].*HTTP 500/); });

  const webm = streams.find((s) => s.type === "webm"), mp4 = (await page.evaluate(async () => (await S.providers.find((p) => p.id === "cfg-vp9").getStream({ link: "603" }))))[0];
  const play = (s) => page.evaluate(async (s) => {
    const box = document.createElement("div"); box.dataset.title = "MOCK test pattern"; document.body.append(box);
    let err = ""; const stop = mountPlayer(box, s, "", (m) => { err = m; }, {}, null, {});
    const v = box.querySelector("video"); const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !(v.currentTime > 0.6) && !err) await new Promise((r) => setTimeout(r, 200));
    const out = { time: v.currentTime, w: v.videoWidth, h: v.videoHeight, err, src: v.currentSrc.replace(/^http:\/\/[^/]+/, "") }; stop(); box.remove(); return out;
  }, s);
  await check("MOCK WebM stream plays in the existing player (currentTime advances, frames decoded)", async () => { const r = await play(webm); console.log("   ", JSON.stringify(r)); assert.ok(r.time > 0.6 && r.w === 320 && !r.err, JSON.stringify(r)); });
  await check("MOCK MP4 (VP9 in MP4; this browser has no H.264) stream plays in the existing player", async () => { const r = await play(mp4); console.log("   ", JSON.stringify(r)); assert.ok(r.time > 0.6 && r.w === 320 && !r.err, JSON.stringify(r)); });

  await check("browser never talked to the provider API nor carried the secret", () => {
    assert.ok(!requests.some((r) => r.url.startsWith(M.base + "/api")), "browser called the provider API directly");
    assert.ok(!requests.some((r) => /SENTINEL|Bearer/.test(r.url + JSON.stringify(r.headers))), "secret in a browser request");
  });
  await check("no uncaught page errors", () => assert.deepEqual(pageErrors, []));
  const sources = await page.content(); await check("secret absent from rendered page and script text", () => assert.ok(!sources.includes(mock.SECRET)));

  await browser.close(); srv.close(); M.close();
  const failed = results.filter((r) => r[0] === "FAIL"); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
