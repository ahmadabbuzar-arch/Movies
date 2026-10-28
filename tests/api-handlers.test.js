// HTTP-level tests of /api/provider-configs and /api/provider-resolve (MOCK providers only).
process.env.PROVIDER_ALLOW_HTTP = "1"; process.env.PROXY_ALLOW_PRIVATE = "1";
process.env.APP_KEY = "test-app-key"; process.env.PROVIDER_TEST_TOKEN = "SENTINEL-SECRET-123"; process.env.PROVIDER_DIAG_KEY = "diag-key-1";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const mock = require("./helpers/mock-server"), { createServer } = require("./helpers/dev-server");
const ROOT = path.join(__dirname, "..");
let M, srv, base, logs = [];
const def = (id, api, extra = {}) => ({ schema: "popcornnet.provider/1", id, name: "Mock " + id, mock: true, kind: "http-json", request: { url: `${M.base}/api/${api}/{type}/{tmdb}`, timeoutMs: 2000, ...(extra.request || {}) }, response: { streamsPath: "data.streams", fields: { url: "file", type: "format", quality: "res", label: "name" } }, ...(extra.top || {}) });
const get = (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }));
const K = "&k=test-app-key";

test.before(async () => {
  M = await mock.start();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pn-api-"));
  fs.writeFileSync(path.join(d, "a.json"), JSON.stringify([def("good", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_TEST_TOKEN}" }, query: { api_key: "${env:PROVIDER_TEST_TOKEN}" } } }), def("boom", "err500"), def("needs-env", "ok", { request: { headers: { Authorization: "Bearer ${env:PROVIDER_UNSET_ONE}" } } })]));
  fs.writeFileSync(path.join(d, "b.json"), "{ not json");
  process.env.PROVIDER_CONFIG_DIR = d;
  srv = createServer(ROOT); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.address().port}`;
  const w = console.warn; console.warn = (...a) => { logs.push(a.join(" ")); }; test.after(() => { console.warn = w; });
});
test.after(() => { srv.close(); M.close(); });

test("access: requests without same-origin or APP_KEY are refused", async () => {
  assert.equal((await get("/api/provider-resolve?id=good&tmdb=1&type=movie")).status, 403);
  assert.equal((await get("/api/provider-configs")).status, 403);
});
test("registry endpoint: ready provider listed, bad file and missing env diagnosed, nothing sensitive exposed", async () => {
  const r = await get("/api/provider-configs?" + K.slice(1)), j = JSON.parse(r.text);
  assert.equal(r.status, 200); assert.deepEqual(j.providers.map((p) => p.id).sort(), ["boom", "good"]);
  const byId = Object.fromEntries(j.diagnostics.map((d) => [d.id || d.file, d]));
  assert.equal(byId["needs-env"].status, "unavailable"); assert.match(byId["b.json"].errors[0].message, /malformed JSON/);
  for (const bad of [mock.SECRET, "PROVIDER_UNSET_ONE", "PROVIDER_TEST_TOKEN", "Bearer", M.base]) assert.ok(!r.text.includes(bad), "leaked " + bad);
  const det = JSON.parse((await get("/api/provider-configs?" + K.slice(1) + "&key=diag-key-1")).text);
  assert.deepEqual(det.diagnostics.find((d) => d.id === "needs-env").missingEnv, ["PROVIDER_UNSET_ONE"]);
  assert.ok(!JSON.stringify(det).includes(mock.SECRET));
});
test("resolve endpoint: success returns streams only; failures return codes and never echo upstream bodies or the token", async () => {
  logs.length = 0;
  const ok = await get(`/api/provider-resolve?id=good&tmdb=603&type=movie${K}`), j = JSON.parse(ok.text);
  assert.equal(ok.status, 200); assert.deepEqual(j.streams.map((s) => s.type), ["m3u8", "mp4", "webm"]); assert.equal(j.mock, true);
  const cases = [["boom", "movie", 502, "BACKEND_FAILURE"], ["nope", "movie", 404, "PROVIDER_NOT_FOUND"], ["needs-env", "movie", 503, "PROVIDER_UNAVAILABLE"], ["good", "bogus", 400, "BAD_REQUEST"]];
  const all = [ok.text];
  for (const [id, type, status, code] of cases) { const r = await get(`/api/provider-resolve?id=${id}&tmdb=1&type=${type}${K}`); all.push(r.text); assert.equal(r.status, status, id); assert.equal(JSON.parse(r.text).error.code, code); }
  const blob = all.join("\n") + logs.join("\n");
  assert.ok(!blob.includes(mock.SECRET) && !blob.includes("Bearer") && !blob.includes(M.base + "/api"), "no secret / provider API URL in responses or logs (media URLs are expected in stream links)");
  assert.ok(logs.every((l) => /^\[provider-resolve\] [\w-]* [A-Z_]+$/.test(l)), "logs hold provider id and code only: " + logs.join("|"));
});
test("api/_* files are not served as static files", async () => {
  for (const p of ["/api/_provider-configs/a.json", "/api/_lib/provider-schema.js", "/api/_provider-adapters/README.md"]) assert.equal((await get(p)).status, 404, p);
});
test("missing configuration directory: endpoints still answer", async () => {
  const keep = process.env.PROVIDER_CONFIG_DIR; process.env.PROVIDER_CONFIG_DIR = path.join(os.tmpdir(), "nope-" + Date.now());
  delete require.cache[require.resolve("../api/_lib/provider-registry")]; delete require.cache[require.resolve("../api/provider-configs")]; delete require.cache[require.resolve("../api/provider-resolve")];
  try {
    const j = JSON.parse((await get("/api/provider-configs?" + K.slice(1))).text); assert.deepEqual(j.providers, []); assert.match(j.notes[0], /not found/);
    const r = await get(`/api/provider-resolve?id=good&tmdb=1&type=movie${K}`); assert.equal(r.status, 404);
  } finally { process.env.PROVIDER_CONFIG_DIR = keep; }
});
