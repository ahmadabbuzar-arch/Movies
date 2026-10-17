# Reel Room (single file, Vercel + GitHub)

Files: `index.html` (the whole site) · `api/proxy.js` (Vercel function) · `vercel.json`

## Deploy
1. Put these files in a GitHub repo (keep the `api/` folder).
2. vercel.com → Add New → Project → import the repo → Framework "Other" → Deploy.
3. Open the site → **+ Provider** → upload a provider `.zip`.

## How it works
- Providers are stored in your browser (IndexedDB) and run in the browser. Native (`index.js`) and Vega-style providers work.
- Requests try the site directly first; if the site blocks browsers (CORS) or needs headers like Referer, they go through `/api/proxy`.
- HLS (`.m3u8`) plays with hls.js; tries direct, falls back to the proxy.

## Limits
- Extractors (hubcloud, gdflix…) are not bundled. Providers needing Node-only modules won't load.
- `cheerio` is emulated with jQuery (common selectors work; exotic ones may not).
- Video through the proxy uses Vercel bandwidth/function time (60s per request on the free plan); heavy streaming may hit limits.
- The proxy only accepts requests from your own site. To use it from another site (e.g. GitHub Pages) set env `ALLOWED_ORIGINS=https://you.github.io` in Vercel and put the proxy URL in the **Proxy URL** box.
- Only upload provider zips you trust (their code runs in your browser), and only stream content you have rights to.
