// Provider registry: reads definitions (local directory and/or PROVIDER_CONFIG_URL), validates them, drops duplicates,
// checks server-side requirements (env variables, adapter modules) and reports a diagnostic for every definition.
const fs = require("node:fs");
const path = require("node:path");
const { validate } = require("./provider-schema");
const { safeFetch, readLimited } = require("./safe-fetch");

const CONFIG_DIR = process.env.PROVIDER_CONFIG_DIR || path.join(__dirname, "..", "_provider-configs"); // env override: tests / other layouts
const ADAPTER_DIR = process.env.PROVIDER_ADAPTER_DIR || path.join(__dirname, "..", "_provider-adapters");
const ENV_NAME_OK = /^PROVIDER_[A-Z0-9_]+$/;

const flatten = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.providers) ? j.providers : [j]);

function readLocal(dir) {
  const out = [], notes = [];
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n) && !/^(package|tsconfig)\.json$/i.test(n)).sort(); }
  catch (e) { notes.push(e.code === "ENOENT" ? `configuration directory not found (${path.basename(dir)}): no configured providers` : `cannot read configuration directory: ${e.code || "error"}`); return { out, notes }; }
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, n), "utf8"); if (text.length > 200000) throw new Error("file larger than 200 KB"); }
    catch (e) { out.push({ file: n, source: "local", error: `cannot read file: ${e.message}` }); continue; }
    try { flatten(JSON.parse(text)).forEach((def, i) => out.push({ file: n, index: i, source: "local", def })); }
    catch (e) { out.push({ file: n, source: "local", error: `malformed JSON: ${e.message}` }); }
  }
  return { out, notes };
}

let remoteCache = { at: 0, key: "", value: null };
async function readRemote(env, fetcher = safeFetch) {
  const url = env.PROVIDER_CONFIG_URL;
  if (!url) return { out: [], notes: [] };
  if (remoteCache.value && remoteCache.key === url && Date.now() - remoteCache.at < 300000) return remoteCache.value;
  const out = [], notes = [], label = "remote";
  try {
    const headers = env.PROVIDER_CONFIG_URL_TOKEN ? { authorization: `Bearer ${env.PROVIDER_CONFIG_URL_TOKEN}` } : {};
    const r = await fetcher(url, { headers, timeoutMs: 8000, allowHttp: env.PROVIDER_ALLOW_HTTP === "1" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = (await readLimited(r, 300000)).toString("utf8");
    flatten(JSON.parse(text)).forEach((def, i) => out.push({ file: label, index: i, source: "remote", def }));
  } catch (e) { out.push({ file: label, source: "remote", error: `remote configuration unavailable: ${e instanceof SyntaxError ? "malformed JSON" : e.message}` }); }
  remoteCache = { at: Date.now(), key: url, value: { out, notes } };
  return remoteCache.value;
}

function loadAdapter(name, adapterDir) {
  const file = path.join(adapterDir, name + ".js");
  if (!fs.existsSync(file)) return { error: `adapter module "${name}" was not found in api/_provider-adapters/ (this provider needs custom backend code that does not exist yet)` };
  try {
    const mod = require(file);
    if (typeof mod.resolve !== "function") return { error: `adapter "${name}" does not export resolve(ctx)` };
    const meta = mod.meta && typeof mod.meta === "object" ? mod.meta : {};
    const req = Array.isArray(meta.requiredEnv) ? meta.requiredEnv : [];
    const bad = req.filter((n) => !ENV_NAME_OK.test(n));
    if (bad.length) return { error: `adapter "${name}" asks for environment variables that are not PROVIDER_*` };
    return { mod, meta, requiredEnv: req };
  } catch (e) { return { error: `adapter "${name}" failed to load: ${e.message}` }; }
}

// Returns { providers: [ready provider records], diagnostics: [one entry per definition], notes }.
async function loadRegistry({ configDir = CONFIG_DIR, adapterDir = ADAPTER_DIR, env = process.env, fetcher } = {}) {
  const local = readLocal(configDir), remote = await readRemote(env, fetcher);
  const items = [...local.out, ...remote.out];
  const providers = [], diagnostics = [], seen = new Set();
  for (const it of items) {
    const d = { id: it.def && typeof it.def.id === "string" ? it.def.id : null, name: it.def && it.def.name || null, file: it.file, source: it.source, status: "invalid", errors: [], warnings: [], unsupported: [], missingEnv: [] };
    diagnostics.push(d);
    if (it.error) { d.errors.push({ path: "", message: it.error }); continue; }
    const v = validate(it.def, { source: it.source, allowHttp: env.PROVIDER_ALLOW_HTTP === "1" });
    d.errors = v.errors; d.warnings = v.warnings; d.unsupported = v.unsupported; d.capabilities = v.caps; d.kind = it.def.kind || null;
    if (v.errors.length) continue;
    if (v.unsupported.length) { d.status = "unsupported"; continue; }
    if (d.id && seen.has(d.id)) { d.status = "duplicate"; d.warnings.push(`id "${d.id}" is already registered by an earlier definition; this one is ignored`); continue; }
    seen.add(d.id);
    if (!v.enabled) { d.status = "disabled"; continue; }
    let adapter = null;
    if (it.def.kind === "adapter") {
      adapter = loadAdapter(it.def.adapter, adapterDir);
      if (adapter.error) { d.status = "unavailable"; d.errors.push({ path: "adapter", message: adapter.error }); continue; }
      d.capabilities = { ...d.capabilities, movie: adapter.meta.movie !== false, tv: adapter.meta.tv !== false, needsServerSecrets: adapter.requiredEnv.length > 0 };
    }
    const needEnv = [...v.env, ...(adapter ? adapter.requiredEnv : [])];
    d.missingEnv = needEnv.filter((n) => !env[n]);
    if (d.missingEnv.length) { d.status = "unavailable"; d.errors.push({ path: "environment", message: `${d.missingEnv.length} required server environment variable(s) are not set` }); continue; }
    d.status = "ready";
    providers.push({ id: it.def.id, name: it.def.name.trim(), kind: it.def.kind, def: it.def, caps: d.capabilities, adapter, source: it.source, mock: it.def.mock === true });
  }
  return { providers, diagnostics, notes: [...local.notes, ...remote.notes] };
}

// What the browser (and the public diagnostics endpoint) may see: no URLs, headers, query values, env names or adapter details.
function publicView(reg, { detailed = false } = {}) {
  return {
    providers: reg.providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, movie: !!p.caps.movie, tv: !!p.caps.tv, formats: p.caps.formats || [], mock: p.mock })),
    diagnostics: reg.diagnostics.map((d) => ({
      id: d.id, name: d.name, file: d.file, source: d.source, kind: d.kind || null, status: d.status,
      errors: d.errors.map((e) => (detailed || d.status !== "unavailable" ? e : { path: e.path, message: "a server-side requirement is missing" })),
      warnings: d.warnings, unsupported: d.unsupported, capabilities: d.capabilities ? { movie: !!d.capabilities.movie, tv: !!d.capabilities.tv, formats: d.capabilities.formats || [], needsServerSecrets: !!d.capabilities.needsServerSecrets } : null,
      ...(detailed ? { missingEnv: d.missingEnv } : {}),
    })),
    notes: reg.notes,
  };
}

module.exports = { loadRegistry, publicView, CONFIG_DIR, ADAPTER_DIR };
