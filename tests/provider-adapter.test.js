// Run: node --test tests/      (needs ffmpeg for the generated MOCK media; no network access)
// Every provider below is a MOCK served by tests/helpers/mock-server.js. Nothing here proves that any real provider works.
process.env.PROVIDER_ALLOW_HTTP = "1";   // the mock server is plain http on localhost
process.env.PROXY_ALLOW_PRIVATE = "1";
process.env.PROVIDER_TEST_TOKEN = "SENTINEL-SECRET-123"; // fake token the MOCK API requires (resolver reads process.env)   // allow 127.0.0.1 (same switch api/proxy.js uses for local tests)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const probe = (args) => new Promise((res, rej) => execFile("ffprobe", args, { timeout: 20000 }, (e, out) => (e ? rej(e) : res(JSON.parse(out))))); // async: a sync call would block the in-process mock server
const mock = require("./helpers/mock-server");
const { validate } = require("../api/_lib/provider-schema");
const { loadRegistry, publicView } = require("../api/_lib/provider-registry");
const { resolve, toStreams } = require("../api/_lib/provider-resolve");

const ROOT = path.join(__dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pn-cfg-"));
const write = (dir, name, v) => fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v, null, 2));
const SCHEMA = "popcornnet.provider/1";
const httpDef = (id, api, extra = {}) => ({ schema: SCHEMA, id, name: "Mock " + id, mock: true, kind: "http-json",
  request: { url: `{BASE}/api/${api}/{type}/{tmdb}`, timeoutMs: 2000, ...(extra.request || {}) },
  response: { streamsPath: "data.streams", fields: { url: "file", type: "format", quality: "res", label: "name" }, ...(extra.response || {}) }, ...(extra.top || {}) });
const withBase = (def, base) => JSON.parse(JSON.stringify(def).replaceAll("{BASE}", base));

let M;
test.before(async () => { M = await mock.start(); });
test.after(() => M.close());
const regFor = async (defs, env = {}) => { const d = tmp(); defs.forEach((x, i) => write(d, `p${i}.json`, withBase(x, M.base))); return loadRegistry({ configDir: d, adapterDir: path.join(__dirname, "fixtures", "adapters"), env: { ...process.env, ...env } }); };
const one = async (def, env, q = { tmdb: "603", type: "movie" }) => { const r = await regFor([def], env); assert.equal(r.providers.length, 1, JSON.stringify(r.diagnostics)); return resolve(r.providers[0], q); };
const rejectsWith = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });

/* 1. valid configuration */
test("1. valid http-json configuration loads and is ready", async () => {
  const r = await regFor([httpDef("good", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" }, query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } } })], { PROVIDER_TEST_TOKEN: mock.SECRET });
  assert.equal(r.providers.length, 1); assert.equal(r.diagnostics[0].status, "ready");
  assert.deepEqual(r.providers[0].caps.formats, ["m3u8", "mp4", "webm"]);
});

/* 2. invalid JSON */
test("2. malformed JSON gives a useful error and does not stop other files", async () => {
  const d = tmp(); write(d, "broken.json", '{"schema": "popcornnet.provider/1", "id": '); write(d, "good.json", withBase(httpDef("good", "empty"), M.base));
  const r = await loadRegistry({ configDir: d, env: process.env });
  const bad = r.diagnostics.find((x) => x.file === "broken.json");
  assert.equal(bad.status, "invalid"); assert.match(bad.errors[0].message, /malformed JSON/);
  assert.equal(r.providers.length, 1);
});
test("2b. field-level validation errors name the field", () => {
  const v = validate({ schema: SCHEMA, id: "Bad Id", kind: "http-json" });
  const paths = v.errors.map((e) => e.path); assert.ok(paths.includes("id") && paths.includes("name") && paths.includes("request") && paths.includes("response"));
});

/* 3. missing config files */
test("3. missing configuration directory does not crash", async () => {
  const r = await loadRegistry({ configDir: path.join(os.tmpdir(), "does-not-exist-" + Date.now()), env: process.env });
  assert.deepEqual(r.providers, []); assert.match(r.notes[0], /not found/);
});
test("3b. empty directory is fine", async () => { const r = await loadRegistry({ configDir: tmp(), env: process.env }); assert.equal(r.providers.length, 0); });

/* duplicates, disabled, versions, unsupported features */
test("duplicate ids are registered once", async () => {
  const r = await regFor([httpDef("same", "empty"), httpDef("same", "ok")]);
  assert.equal(r.providers.length, 1); assert.equal(r.diagnostics[1].status, "duplicate");
});
test("disabled provider is not registered", async () => { const r = await regFor([httpDef("off", "empty", { top: { enabled: false } })]); assert.equal(r.providers.length, 0); assert.equal(r.diagnostics[0].status, "disabled"); });
test("unsupported features are reported, not faked", async () => {
  const r = await regFor([
    { ...httpDef("v2", "empty"), schema: "popcornnet.provider/2" },
    httpDef("post", "empty", { request: { method: "POST" } }),
    httpDef("html", "empty", { response: { format: "html" } }),
    httpDef("dashdef", "empty", { response: { defaultType: "mpd" } }),
    httpDef("login", "empty", { top: { requires: { login: true } } }),
    httpDef("drm", "empty", { top: { playback: { widevine: "x" } } }),
  ]);
  assert.equal(r.providers.length, 0);
  assert.deepEqual(r.diagnostics.map((d) => d.status), Array(6).fill("unsupported"));
  assert.match(r.diagnostics[0].unsupported[0], /version/); assert.match(r.diagnostics[1].unsupported[0], /POST/); assert.match(r.diagnostics[2].unsupported[0], /HTML/);
  assert.match(r.diagnostics[3].unsupported[0], /DASH/); assert.match(r.diagnostics[4].unsupported[0], /login/); assert.match(r.diagnostics[5].unsupported[0], /DRM/);
});

/* 8. secrets */
test("8a. hard-coded credentials, URL credentials and non-PROVIDER env names are rejected", () => {
  const bad = (patch) => validate({ ...httpDef("x", "ok"), ...patch }).errors.map((e) => e.message).join(" | ");
  assert.match(bad({ request: { url: "https://a.example/{tmdb}", headers: { Authorization: "Bearer abc" } } }), /hard-coded credential/);
  assert.match(bad({ request: { url: "https://a.example/{tmdb}", headers: { Cookie: "sid=1" } } }), /hard-coded credential/);
  assert.match(bad({ request: { url: "https://a.example/{tmdb}", query: { api_key: "abc" } } }), /hard-coded credential/);
  assert.match(bad({ request: { url: "https://a.example/{tmdb}?api_key=abc" } }), /looks like a credential/);
  assert.match(bad({ request: { url: "https://user:pw@a.example/{tmdb}" } }), /credentials in the URL/);
  assert.match(bad({ request: { url: "https://a.example/{tmdb}", headers: { Authorization: "${env:APP_KEY}" } } }), /must start with PROVIDER_/);
  assert.match(bad({ playback: { headers: { Authorization: "${env:PROVIDER_X}" } } }), /sent to the browser/);
  assert.match(bad({ playback: { headers: { Referer: "${env:PROVIDER_X}" } } }), /sent to the browser/);
});
test("8b. remote configurations cannot read env secrets or carry credentials", async () => {
  const defs = [httpDef("rem1", "ok", { request: { query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } } }), httpDef("rem2", "ok", { request: { headers: { Authorization: "Bearer abc" } } }), httpDef("rem3", "empty")].map((d) => withBase(d, M.base));
  const fetcher = async () => new Response(JSON.stringify({ providers: defs }));
  const r = await loadRegistry({ configDir: tmp(), env: { ...process.env, PROVIDER_CONFIG_URL: "https://config.example/x.json", PROVIDER_TEST_TOKEN: "t" }, fetcher });
  assert.deepEqual(r.diagnostics.map((d) => d.status), ["invalid", "invalid", "ready"]);
  assert.ok(r.diagnostics.every((d) => d.source === "remote"));
});
test("8c. secret is sent to the provider API only, never returned, never in the public registry view", async () => {
  M.seen.length = 0;
  const env = { PROVIDER_TEST_TOKEN: mock.SECRET };
  const def = httpDef("good", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" }, query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } }, top: { playback: { headers: { Referer: "https://example.org/" } } } });
  const r = await regFor([def], env), out = await resolve(r.providers[0], { tmdb: "603", type: "movie" });
  assert.ok(M.seen.some((s) => s.auth === `Bearer ${mock.SECRET}`), "provider API did receive the token");
  const blob = JSON.stringify(out) + JSON.stringify(publicView(r)) + JSON.stringify(publicView(r, { detailed: true }));
  assert.ok(!blob.includes(mock.SECRET) && !/Bearer|api_key|127\.0\.0\.1:\d+\/api/.test(JSON.stringify(publicView(r))), "no secret / request details in client-visible data");
  assert.deepEqual(out.streams[0].headers, { Referer: "https://example.org/" });
});
test("8d. credentials are not forwarded when a media URL redirects to another origin", async () => {
  M.seen.length = 0;
  const def = httpDef("leak", "leak", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" } }, response: { fields: { url: "file" } }, top: { playback: { verify: true } } });
  const r = await regFor([def], { PROVIDER_TEST_TOKEN: mock.SECRET }); await resolve(r.providers[0], { tmdb: "1", type: "movie" });
  const hop = M.seen.find((s) => s.url.startsWith("OTHER")); assert.ok(hop, "redirect was followed");
  assert.equal(hop.auth, ""); // the probe never sent Authorization to the media host in the first place, and redirect drops custom headers
});

/* 4/5. playable streams (MOCK media generated by ffmpeg) */
test("5. authorised MOCK streams resolve, are verified, and are valid media (ffprobe)", async () => {
  const def = httpDef("good", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" }, query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } } });
  const r = await regFor([def], { PROVIDER_TEST_TOKEN: mock.SECRET }), out = await resolve(r.providers[0], { tmdb: "603", type: "movie" });
  assert.deepEqual(out.streams.map((s) => s.type), ["m3u8", "mp4", "webm"]);
  for (const s of out.streams) {
    const j = await probe(["-v", "error", "-show_entries", "format=duration", "-of", "json", s.link]);
    assert.ok(Number(j.format.duration) > 2, `${s.type} duration`);
  }
});
test("5b. HLS also plays through the existing api/proxy.js rewrite (APP_KEY path)", async () => {
  process.env.APP_KEY = "test-app-key"; const proxy = require("../api/proxy.js");
  const srv = http.createServer((q, s) => { q.headers["x-forwarded-proto"] = "http"; proxy(q, s); }); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/api/proxy?u=${encodeURIComponent(M.base + "/media/test.m3u8")}&k=test-app-key`;
    const j = await probe(["-v", "error", "-allowed_extensions", "ALL", "-show_entries", "format=duration", "-of", "json", u]);
    assert.ok(Number(j.format.duration) > 2);
  } finally { srv.close(); delete process.env.APP_KEY; }
});
test("TV requests fill season/episode; embed kind returns an iframe link without probing", async () => {
  const d = tmp(); write(d, "e.json", { schema: SCHEMA, id: "emb", name: "Mock embed", mock: true, kind: "embed", embed: { movie: "https://embed.example/movie/{tmdb}", tv: "https://embed.example/tv/{tmdb}/{season}/{episode}" } });
  const r = await loadRegistry({ configDir: d, env: process.env }), tv = await resolve(r.providers[0], { tmdb: "1396", type: "tv", season: "2", episode: "5" });
  assert.deepEqual(tv.streams[0], { link: "https://embed.example/tv/1396/2/5", type: "embed", server: "Mock embed" });
});

/* 6/7. failure diagnostics */
const needs = { PROVIDER_TEST_TOKEN: mock.SECRET };
const cases = [
  ["err500", "BACKEND_FAILURE", /HTTP 500/], ["notjson", "UNSUPPORTED_FORMAT", /not JSON/], ["badshape", "UNSUPPORTED_FORMAT", /no list of streams/],
  ["empty", "NO_MEDIA", /no streams/], ["html", "UNSUPPORTED_FORMAT", /web page/], ["fakehls", "UNSUPPORTED_FORMAT", /not an HLS playlist/], ["dead", "MEDIA_UNAVAILABLE", /HTTP 404/],
  ["dash", "UNSUPPORTED_FORMAT", /DASH/], ["drm", "UNSUPPORTED_FORMAT", /DRM/], ["notype", "UNSUPPORTED_FORMAT", /could not be determined/],
];
for (const [api, code, re] of cases) test(`7. ${api} -> ${code}`, async () => {
  const r = await regFor([httpDef("c", api)], needs);
  await assert.rejects(resolve(r.providers[0], { tmdb: "1", type: "movie" }), (e) => { assert.equal(e.code, code, e.message); assert.match(e.message, re); assert.ok(!e.message.includes(mock.SECRET)); return true; });
});
test("7a. plain-http stream URLs are rejected when http is not explicitly allowed", async () => {
  const r = await regFor([httpDef("c", "empty")]), dropped = [];
  const out = await toStreams([{ url: "http://example.com/a.mp4" }, { url: "https://u:p@example.com/a.mp4" }], r.providers[0], dropped, { allowHttp: false });
  assert.equal(out.length, 0); assert.deepEqual(dropped, ["unsupported: stream URL is not https", "unsupported: stream URL contains credentials"]);
});
test("7b. backend timeout, unreachable backend and unknown movie type", async () => {
  let r = await regFor([httpDef("slow", "slow", { request: { timeoutMs: 1000 } })]);
  await rejectsWith(resolve(r.providers[0], { tmdb: "1", type: "movie" }), "BACKEND_FAILURE");
  r = await regFor([{ ...httpDef("down", "ok"), request: { url: "http://127.0.0.1:9/{tmdb}", timeoutMs: 1500 } }]);
  await rejectsWith(resolve(r.providers[0], { tmdb: "1", type: "movie" }), "BACKEND_FAILURE");
  r = await regFor([httpDef("c", "empty", { request: { url: undefined, movieUrl: `{BASE}/api/empty/movie/{tmdb}` } })]);
  await rejectsWith(resolve(r.providers[0], { tmdb: "1", type: "tv" }), "TYPE_NOT_SUPPORTED");
  await rejectsWith(resolve(r.providers[0], { tmdb: "abc", type: "movie" }), "BAD_REQUEST");
});
test("allowedHosts rejects media from other hosts", async () => {
  const r = await regFor([httpDef("c", "ok", { top: { playback: { allowedHosts: ["media.example.org"] } }, request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" }, query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } } })], needs);
  await assert.rejects(resolve(r.providers[0], { tmdb: "1", type: "movie" }), (e) => { assert.equal(e.code, "UNSUPPORTED_FORMAT"); assert.match(e.message, /allowedHosts/); return true; });
});

/* 6. unavailable providers */
test("6. missing env var -> unavailable, public view hides the variable name, detailed view shows it", async () => {
  const def = httpDef("needs", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_NOT_SET}" } } });
  const r = await regFor([def], { PROVIDER_NOT_SET: "" });
  assert.equal(r.providers.length, 0); assert.equal(r.diagnostics[0].status, "unavailable");
  assert.ok(!JSON.stringify(publicView(r)).includes("PROVIDER_NOT_SET")); assert.deepEqual(publicView(r, { detailed: true }).diagnostics[0].missingEnv, ["PROVIDER_NOT_SET"]);
});
test("6b. adapter kind: missing module is reported; present MOCK module works; undeclared env is not visible to it", async () => {
  const defs = [{ schema: SCHEMA, id: "ad-missing", name: "Missing adapter", kind: "adapter", adapter: "no-such-adapter" }, { schema: SCHEMA, id: "ad-mock", name: "Mock adapter", mock: true, kind: "adapter", adapter: "mock-test-adapter" }];
  let r = await regFor(defs, { PROVIDER_MOCK_ADAPTER_URL: `${M.base}/media/test.mp4` });
  assert.equal(r.diagnostics[0].status, "unavailable"); assert.match(r.diagnostics[0].errors[0].message, /custom backend code that does not exist/);
  assert.equal(r.providers.length, 1); const aenv = { ...process.env, PROVIDER_MOCK_ADAPTER_URL: `${M.base}/media/test.mp4`, PROVIDER_TEST_TOKEN: "must-not-be-visible" };
  const out = await resolve(r.providers[0], { tmdb: "1", type: "movie" }, { env: aenv }); assert.equal(out.streams[0].type, "mp4");
  await rejectsWith(resolve(r.providers[0], { tmdb: "1", type: "tv" }, { env: aenv }), "TYPE_NOT_SUPPORTED");
  r = await regFor(defs, { PROVIDER_MOCK_ADAPTER_URL: "" }); assert.equal(r.diagnostics[1].status, "unavailable");
});
test("adapter name cannot traverse directories", () => { assert.ok(validate({ schema: SCHEMA, id: "x", name: "x", kind: "adapter", adapter: "../../etc/passwd" }).errors.length); });

/* 8e. no secrets in the frontend code */
test("8e. no secrets, cookies or provider URLs in frontend files", () => {
  for (const f of ["index.html", "provider-diagnostics.html"]) {
    const t = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!t.includes(mock.SECRET)); assert.ok(!/\$\{env:/.test(t.replace(/\$\{env:\.\.\.\}/g, "")), f + " must not contain env references");
  }
  const block = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").split("/* pn-config-adapter:start */")[1].split("/* pn-config-adapter:end */")[0];
  assert.ok(!/cookie|authorization|token|secret/i.test(block.replace(/\/\/.*$/gm, "").replace(/APP_KEY/g, "")), "adapter block handles no credentials");
});

/* frontend adapter block, run against stubs */
function frontend(fetchImpl) {
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").split("/* pn-config-adapter:start */")[1].split("/* pn-config-adapter:end */")[0];
  const logs = [], win = {};
  const ctx = vm.createContext({ window: win, API: "", APP_KEY: "", fetch: fetchImpl, plog: (t) => logs.push(t), enc: encodeURIComponent, S: { providers: [], failed: [] }, URLSearchParams, console });
  vm.runInContext(src + "\nthis.__api = { resolveConfigured, configProviderSource, configReport };", ctx);
  return { api: ctx.__api, ctx, logs, win };
}
test("frontend: generated provider source exposes getStreams and calls the server route", async () => {
  const calls = []; const { api, win } = frontend(async (u) => { calls.push(u); return { ok: true, json: async () => ({ streams: [{ link: "https://x/y.m3u8", type: "m3u8" }] }) }; });
  const mod = { exports: {} }; new Function("module", "window", api.configProviderSource("my-id", "My Name"))(mod, win);
  assert.equal(mod.exports.id, "cfg-my-id"); assert.equal(mod.exports.name, "My Name");
  const s = await mod.exports.getStreams(603, "movie"); assert.equal(s[0].type, "m3u8");
  const tv = await mod.exports.getStreams(1396, "tv", 2, 5); assert.match(calls[1], /id=my-id&tmdb=1396&type=tv&season=2&episode=5/); assert.ok(tv.length);
});
test("frontend: NO_MEDIA is an empty result, other codes throw with the code visible", async () => {
  const reply = (code) => async () => ({ ok: false, status: 502, json: async () => ({ error: { code, message: "m" } }) });
  assert.equal((await frontend(reply("NO_MEDIA")).api.resolveConfigured("a", 1, "movie")).length, 0);
  for (const code of ["BACKEND_FAILURE", "UNSUPPORTED_FORMAT", "MEDIA_UNAVAILABLE", "PROVIDER_UNAVAILABLE"]) await assert.rejects(frontend(reply(code)).api.resolveConfigured("a", 1, "movie"), new RegExp(`\\[${code}\\]`));
  const f = frontend(async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(f.api.resolveConfigured("a", 1, "movie"), /BACKEND_FAILURE/); assert.match(f.logs[0], /not reachable/);
});
test("frontend: diagnostics report lists status and unsupported features", () => {
  const f = frontend(async () => ({})); f.ctx.S.cfg = { providers: [{}], diagnostics: [{ id: "a", status: "ready", errors: [], unsupported: [] }, { id: "b", status: "unsupported", errors: [], unsupported: ["request.method POST"] }], notes: [] };
  const rep = vm.runInContext("configReport()", f.ctx); assert.match(rep, /1 ready of 2/); assert.match(rep, /b: unsupported — unsupported: request\.method POST/);
});
