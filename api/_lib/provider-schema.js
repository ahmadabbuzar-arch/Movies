// Provider configuration schema "popcornnet.provider/1": validation + normalisation. Pure functions, no I/O.
// A definition NEVER contains secrets: credentials are referenced as ${env:PROVIDER_NAME} and are resolved only on the server.
const SCHEMA = "popcornnet.provider/1";
const SUPPORTED_SCHEMAS = [SCHEMA];
const KINDS = ["http-json", "embed", "adapter"];
const MEDIA_TYPES = ["m3u8", "mp4", "webm"]; // formats the existing player can play without DRM
const ENV_RE = /\$\{env:([A-Za-z0-9_]+)\}/g;
const ENV_NAME_OK = /^PROVIDER_[A-Z0-9_]+$/; // a config may only read PROVIDER_* variables, never APP_KEY, FIREBASE_*, CRON_SECRET...
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const SECRET_QUERY = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|password|session|sid|cookie)$/i;
const DRM_KEYS = ["drm", "license", "licenseUrl", "license_url", "widevine", "playready", "fairplay", "keyId", "key_id", "pssh"];
const PLACEHOLDERS = ["tmdb", "type", "season", "episode"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KNOWN_TOP = ["schema", "id", "name", "enabled", "kind", "mock", "request", "response", "embed", "adapter", "playback", "requires"];

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const envRefs = (s) => [...String(s).matchAll(ENV_RE)].map((m) => m[1]);
const hasEnv = (s) => envRefs(s).length > 0;
const sample = (u) => String(u).replace(/\{(tmdb|season|episode)\}/g, "1").replace(/\{type\}/g, "movie").replace(ENV_RE, "x");

function checkUrl(url, path, errors, { allowEnv = false, allowHttp = false } = {}) {
  if (typeof url !== "string" || !url) return errors.push({ path, message: "must be a non-empty string" });
  if (!allowEnv && hasEnv(url)) return errors.push({ path, message: "secret references (${env:...}) are not allowed here because this value is sent to the browser" });
  for (const m of url.matchAll(/\{([a-z]+)\}/g)) if (!PLACEHOLDERS.includes(m[1])) errors.push({ path, message: `unknown placeholder {${m[1]}} (allowed: ${PLACEHOLDERS.map((p) => "{" + p + "}").join(" ")})` });
  let u; try { u = new URL(sample(url)); } catch { return errors.push({ path, message: "is not a valid absolute URL" }); }
  if (u.username || u.password) errors.push({ path, message: "must not contain credentials in the URL" });
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) errors.push({ path, message: "must use https://" });
  let probe; try { probe = new URL(String(url).replace(/\{(tmdb|season|episode)\}/g, "1").replace(/\{type\}/g, "movie").replace(ENV_RE, "ENVREF")); } catch { probe = u; }
  for (const k of probe.searchParams.keys()) if (SECRET_QUERY.test(k) && (!allowEnv || probe.searchParams.get(k) !== "ENVREF")) errors.push({ path, message: `query parameter "${k}" looks like a credential; put it in request.query as "\${env:PROVIDER_...}"` });
}

// source: "local" (file in the project) or "remote" (fetched from PROVIDER_CONFIG_URL). Remote definitions may not reference env secrets.
function validate(raw, { source = "local", allowHttp = false } = {}) {
  const errors = [], warnings = [], unsupported = [];
  if (!isObj(raw)) return { ok: false, errors: [{ path: "", message: "definition must be a JSON object" }], warnings, unsupported };
  if (raw.schema === undefined) errors.push({ path: "schema", message: `missing; expected "${SCHEMA}"` });
  else if (!SUPPORTED_SCHEMAS.includes(raw.schema)) { unsupported.push(`configuration version "${raw.schema}" (supported: ${SUPPORTED_SCHEMAS.join(", ")})`); }
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) errors.push({ path: "id", message: "required: lowercase letters, digits and dashes, max 40 characters" });
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 60) errors.push({ path: "name", message: "required: a non-empty string up to 60 characters" });
  if (!KINDS.includes(raw.kind)) errors.push({ path: "kind", message: `must be one of: ${KINDS.join(", ")}` });
  for (const k of Object.keys(raw)) if (!KNOWN_TOP.includes(k)) warnings.push(`unknown field "${k}" is ignored`);
  const env = new Set();
  const collectEnv = (value, path) => {
    for (const n of envRefs(value)) {
      if (source === "remote") errors.push({ path, message: "secret references (${env:...}) are only allowed in local configuration files, not in remotely loaded ones" });
      else if (!ENV_NAME_OK.test(n)) errors.push({ path, message: `environment variable "${n}" is not allowed; names must start with PROVIDER_` });
      else env.add(n);
    }
  };

  if (raw.requires !== undefined) {
    if (!isObj(raw.requires)) errors.push({ path: "requires", message: "must be an object" });
    else {
      if (raw.requires.login || raw.requires.subscription) unsupported.push("user login / subscription-gated media (PopcornNet does not log in to services or bypass access controls)");
      if (raw.requires.drm) unsupported.push("DRM-protected media (not supported and will not be added)");
    }
  }
  if (raw.playback !== undefined && !isObj(raw.playback)) errors.push({ path: "playback", message: "must be an object" });
  const pb = isObj(raw.playback) ? raw.playback : {};
  for (const k of DRM_KEYS) if (k in pb) unsupported.push(`playback.${k}: DRM/licence handling is not supported`);
  if (pb.headers !== undefined) {
    if (!isObj(pb.headers)) errors.push({ path: "playback.headers", message: "must be an object of header name -> value" });
    else for (const [h, v] of Object.entries(pb.headers)) {
      if (SECRET_HEADER.test(h)) errors.push({ path: `playback.headers.${h}`, message: "credential headers are not allowed here: these headers are sent to the browser" });
      if (typeof v !== "string") errors.push({ path: `playback.headers.${h}`, message: "must be a string" });
      else if (hasEnv(v)) errors.push({ path: `playback.headers.${h}`, message: "secret references are not allowed here: these headers are sent to the browser" });
    }
  }
  if (pb.allowedHosts !== undefined && !(Array.isArray(pb.allowedHosts) && pb.allowedHosts.every((h) => typeof h === "string" && /^[a-z0-9.*-]+$/i.test(h)))) errors.push({ path: "playback.allowedHosts", message: "must be an array of host names (\"*.example.com\" allowed)" });
  if (pb.verify !== undefined && typeof pb.verify !== "boolean") errors.push({ path: "playback.verify", message: "must be true or false" });

  const caps = { movie: false, tv: false, formats: [], needsServerSecrets: false };
  if (raw.kind === "http-json") {
    const rq = raw.request, rs = raw.response;
    if (!isObj(rq)) errors.push({ path: "request", message: "required for kind \"http-json\"" });
    else {
      const method = rq.method === undefined ? "GET" : String(rq.method).toUpperCase();
      if (method !== "GET") unsupported.push(`request.method ${method} (only GET is implemented)`);
      const hasBoth = rq.movieUrl !== undefined || rq.tvUrl !== undefined;
      if (rq.url === undefined && !hasBoth) errors.push({ path: "request.url", message: "give request.url (movie and tv) or request.movieUrl / request.tvUrl" });
      for (const k of ["url", "movieUrl", "tvUrl"]) if (rq[k] !== undefined) { checkUrl(rq[k], `request.${k}`, errors, { allowEnv: true, allowHttp }); collectEnv(rq[k], `request.${k}`); }
      caps.movie = !!(rq.url || rq.movieUrl); caps.tv = !!(rq.url || rq.tvUrl);
      for (const [section, secretRe] of [["headers", SECRET_HEADER], ["query", SECRET_QUERY]]) {
        if (rq[section] === undefined) continue;
        if (!isObj(rq[section])) { errors.push({ path: `request.${section}`, message: "must be an object of string values" }); continue; }
        for (const [k, v] of Object.entries(rq[section])) {
          if (typeof v !== "string") { errors.push({ path: `request.${section}.${k}`, message: "must be a string" }); continue; }
          collectEnv(v, `request.${section}.${k}`);
          if (secretRe.test(k) && !hasEnv(v) && source === "local") errors.push({ path: `request.${section}.${k}`, message: "looks like a hard-coded credential; use \"${env:PROVIDER_NAME}\" and set the value in the server environment" });
          if (secretRe.test(k) && !hasEnv(v) && source === "remote") errors.push({ path: `request.${section}.${k}`, message: "credentials are not allowed in remotely loaded configurations" });
        }
      }
      if (rq.timeoutMs !== undefined && !(Number.isInteger(rq.timeoutMs) && rq.timeoutMs >= 1000 && rq.timeoutMs <= 25000)) errors.push({ path: "request.timeoutMs", message: "must be an integer between 1000 and 25000" });
    }
    if (!isObj(rs)) errors.push({ path: "response", message: "required for kind \"http-json\"" });
    else {
      if (rs.format !== undefined && rs.format !== "json") unsupported.push(`response.format "${rs.format}" (only "json" APIs are supported; HTML pages are not scraped)`);
      if (rs.streamsPath !== undefined && (typeof rs.streamsPath !== "string" || !/^[A-Za-z0-9_.\[\]-]*$/.test(rs.streamsPath))) errors.push({ path: "response.streamsPath", message: "must be a dotted path such as data.streams (\"\" = the response itself)" });
      if (rs.fields !== undefined) {
        if (!isObj(rs.fields)) errors.push({ path: "response.fields", message: "must be an object" });
        else for (const [k, v] of Object.entries(rs.fields)) {
          if (!["url", "type", "quality", "label", "language"].includes(k)) warnings.push(`response.fields.${k} is ignored`);
          else if (typeof v !== "string" || !/^[A-Za-z0-9_.\[\]-]+$/.test(v)) errors.push({ path: `response.fields.${k}`, message: "must be a property name or dotted path" });
        }
      }
      if (rs.defaultType !== undefined && !MEDIA_TYPES.includes(rs.defaultType)) { if (rs.defaultType === "mpd") unsupported.push("response.defaultType mpd (DASH is not supported by the player)"); else errors.push({ path: "response.defaultType", message: `must be one of: ${MEDIA_TYPES.join(", ")}` }); }
    }
    caps.formats = MEDIA_TYPES.slice();
  } else if (raw.kind === "embed") {
    const e = raw.embed;
    if (!isObj(e) || (!e.movie && !e.tv)) errors.push({ path: "embed", message: "give embed.movie and/or embed.tv (https URL templates containing {tmdb})" });
    else for (const k of ["movie", "tv"]) if (e[k] !== undefined) {
      checkUrl(e[k], `embed.${k}`, errors, { allowHttp });
      if (typeof e[k] === "string" && !e[k].includes("{tmdb}")) errors.push({ path: `embed.${k}`, message: "must contain {tmdb}" });
      caps[k] = true;
    }
    caps.formats = ["embed"];
  } else if (raw.kind === "adapter") {
    if (typeof raw.adapter !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.adapter)) errors.push({ path: "adapter", message: "required: the adapter module name (letters, digits, dashes), see api/_provider-adapters/README.md" });
    caps.movie = true; caps.tv = true; // refined once the adapter module is loaded
  }
  caps.needsServerSecrets = env.size > 0;
  const ok = errors.length === 0 && unsupported.length === 0;
  return { ok, errors, warnings, unsupported, env: [...env], caps, enabled: raw.enabled !== false };
}

module.exports = { SCHEMA, SUPPORTED_SCHEMAS, KINDS, MEDIA_TYPES, ENV_RE, validate, envRefs };
