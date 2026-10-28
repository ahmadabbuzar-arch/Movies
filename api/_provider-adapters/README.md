# Provider adapters (custom backend code)

Use an adapter only when a provider cannot be described by a plain JSON API (`kind: "http-json"`).
A definition with `"kind": "adapter", "adapter": "my-source"` loads `api/_provider-adapters/my-source.js`.
If that file does not exist the provider is reported as `unavailable` ("adapter module not found"); nothing is faked.

```js
// api/_provider-adapters/my-source.js  (runs on the server only)
module.exports = {
  meta: { requiredEnv: ["PROVIDER_MYSOURCE_TOKEN"], movie: true, tv: true }, // only PROVIDER_* names; the adapter receives only these
  // ctx: { tmdbId, type: "movie"|"tv", season, episode, env, fetch(url, {headers, timeoutMs}), readLimited(res, maxBytes) }
  async resolve(ctx) {
    const r = await ctx.fetch("https://api.example.com/streams/" + ctx.tmdbId, { headers: { authorization: "Bearer " + ctx.env.PROVIDER_MYSOURCE_TOKEN } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = JSON.parse((await ctx.readLimited(r, 1000000)).toString("utf8"));
    return data.files.map((f) => ({ url: f.hls, type: "m3u8", quality: f.quality })); // array of {url,type,quality,label,language}
  },
};
```
Rules: return only URLs you are authorised to stream (HLS `.m3u8` or MP4/WebM, https). Returned items go through the same checks as JSON providers
(https, host allow-list, not a web page, valid HLS playlist, no DRM). `ctx.fetch` only reaches public hosts. Do not log tokens or URLs.
A MOCK adapter used only by the tests lives in `tests/fixtures/adapters/`.
