# Configured providers (JSON) — how to add one without touching the app

PopcornNet can load provider definitions from JSON files. The **server** validates and runs them; the browser only receives playable stream
objects. Credentials stay in Vercel environment variables and never reach the page.

```
api/_provider-configs/*.json   ← your definitions (one file per provider, or an array / {"providers":[...]})
api/_provider-adapters/*.js    ← optional custom server code (only for APIs JSON cannot describe)
api/_lib/                      ← schema, registry, resolver (no need to edit)
api/provider-configs.js        ← GET /api/provider-configs   (registry + diagnostics, no secrets)
api/provider-resolve.js        ← GET /api/provider-resolve?id=&tmdb=&type=movie|tv[&season=&episode=]
provider-diagnostics.html      ← developer page: which definitions are valid / unsupported
```
Add a file, push, redeploy. No rebuild of the app is needed. Open the site with `#debug` (or `/provider-diagnostics.html`) to see the result.
Everything under `api/_*` is private: Vercel does not publish it as a URL (verify after deploying, see "Deploy check").

## Definition format `popcornnet.provider/1`

Common fields: `schema` (required, exactly `popcornnet.provider/1`), `id` (`a-z 0-9 -`, ≤40), `name`, `kind`, `enabled` (default true),
`mock` (true = shown as "(mock)" in the app), `playback`, `requires`.

### kind `http-json` — an authorised JSON API that returns direct media URLs
```json
{
  "schema": "popcornnet.provider/1",
  "id": "my-library",
  "name": "My Library",
  "kind": "http-json",
  "request": {
    "url": "https://api.my-library.example/v1/{type}/{tmdb}/streams",
    "headers": { "Authorization": "Bearer ${env:PROVIDER_MYLIB_TOKEN}" },
    "query":   { "lang": "en" },
    "timeoutMs": 8000
  },
  "response": {
    "streamsPath": "data.streams",
    "fields": { "url": "file", "type": "format", "quality": "res", "label": "name" },
    "defaultType": "m3u8"
  },
  "playback": { "headers": { "Referer": "https://my-library.example/" }, "allowedHosts": ["cdn.my-library.example", "*.my-cdn.example"], "verify": true }
}
```
* `request.url` (movie + tv) **or** `request.movieUrl` / `request.tvUrl`. Placeholders: `{tmdb} {type} {season} {episode}` (`{type}` = `movie`|`tv`). Only GET.
* `${env:PROVIDER_NAME}` is allowed **only** in `request.url|headers|query`, only for variables starting with `PROVIDER_`, and only in local files.
  Credential-looking headers (`Authorization`, `Cookie`, `X-Api-Key`…) and query keys (`api_key`, `token`…) with a literal value are rejected.
* `response.streamsPath`: dotted path to the list (`""` = the response is the list). Each entry: a URL string or an object; `fields` maps your property names
  (defaults tried: `url|file|src|link|stream`, `type|format`, `quality|resolution|res`, `label|name|server`, `language|lang`).
* Accepted media: `m3u8` (HLS), `mp4`, `webm`, over https. `hls` = `m3u8`. The type comes from the field, else the file extension, else `defaultType`.
* `playback.headers` are sent **to the browser** with the stream (e.g. a Referer the CDN needs): no secrets allowed there.
* `playback.allowedHosts`: media from other hosts is rejected. `playback.verify` (default true): the server fetches the first bytes and rejects web pages,
  non-HLS content behind a `.m3u8` URL, and dead links, so the player is never given a page URL as a video.

### kind `embed` — an authorised embed page played in an iframe
```json
{ "schema": "popcornnet.provider/1", "id": "my-embed", "name": "My Embed", "kind": "embed",
  "embed": { "movie": "https://embed.example/movie/{tmdb}", "tv": "https://embed.example/tv/{tmdb}/{season}/{episode}" } }
```

### kind `adapter` — custom server code
```json
{ "schema": "popcornnet.provider/1", "id": "my-source", "name": "My Source", "kind": "adapter", "adapter": "my-source" }
```
Needs `api/_provider-adapters/my-source.js`; the interface is in `api/_provider-adapters/README.md`. If the file does not exist the provider is
reported `unavailable` — it is never faked. The adapter only receives the env variables it lists in `meta.requiredEnv`.

## Status values (diagnostics)
`ready` · `invalid` (errors name the field) · `unsupported` (valid but uses something PopcornNet does not do: other schema version, non-GET, HTML/scraping,
DASH, DRM, login/subscription) · `unavailable` (valid, but a server env variable or adapter module is missing) · `duplicate` (id already registered, first wins) · `disabled`.

## Error codes shown when playback finds nothing
| code | meaning |
|---|---|
| `PROVIDER_NOT_FOUND` | no such configuration (file missing, not loaded, or invalid) |
| `PROVIDER_UNAVAILABLE` | configured, but env variable / adapter module is missing on the server |
| `BACKEND_FAILURE` | provider API timed out, unreachable, or answered an HTTP error |
| `UNSUPPORTED_FORMAT` | response is not JSON / has no stream list / only DASH, DRM, web pages, non-https, unknown types |
| `MEDIA_UNAVAILABLE` | streams were listed but the media host refused or returned nothing |
| `NO_MEDIA` | the provider simply has no stream for this title (treated as an empty result, not an error) |
They appear in the player's "Details" log and in the "providers failed" count, e.g. `[BACKEND_FAILURE] provider backend answered HTTP 500`.

## Remote configuration (optional)
Set `PROVIDER_CONFIG_URL` (https, public host) to an array / `{"providers":[...]}`; optional `PROVIDER_CONFIG_URL_TOKEN` is sent as a Bearer token.
Cached 5 minutes. Remote definitions are validated the same way but may **not** use `${env:...}` or credentials (a compromised remote file could otherwise
point a request at its own server and read your secrets). Use local files for anything that needs a secret.

## Environment variables (names only — never commit values)
| name | required | purpose |
|---|---|---|
| `PROVIDER_<NAME>` | only if a definition references it | secret used by `${env:PROVIDER_<NAME>}`, server-side only |
| `APP_KEY` | existing, optional | lets the standalone HTML/APK call these routes (same rule as `/api/proxy`) |
| `ALLOWED_ORIGINS` | existing, optional | extra origins allowed to call the API |
| `PROVIDER_CONFIG_URL`, `PROVIDER_CONFIG_URL_TOKEN` | optional | remote definitions |
| `PROVIDER_DIAG_KEY` | optional | `?key=` value that unlocks detailed diagnostics (names of missing env variables) |
| `PROVIDER_ALLOW_HTTP`, `PROXY_ALLOW_PRIVATE`, `PROVIDER_CONFIG_DIR`, `PROVIDER_ADAPTER_DIR` | **tests only** | never set in production |

## Security model
* Server-side fetches reach public hosts only (private/loopback IPs blocked, redirects re-checked, 4 hops max); headers are dropped on cross-origin redirects.
* Responses and logs contain codes and short messages only — no URLs, header values, tokens or upstream bodies.
* No DRM, login, cookie or subscription handling exists, and none can be configured: such definitions are reported `unsupported`.
* Use only sources you are authorised to stream (your own media, public-domain or licensed content).

## Tests
`npm test` (unit + HTTP, needs `ffmpeg`) and `npm run test:e2e` (real browser; needs Playwright with Chrome/Chromium). All providers in the tests are **mocks**
served from localhost with generated test-pattern video; they prove the adapter, not any real provider.

## Deploy check
After deploying, `curl -I https://<your-site>/api/_provider-configs/<file>.json` and `…/api/_lib/provider-schema.js` should **not** return 200.
(Verified locally with the dev server only, not on Vercel itself.)
