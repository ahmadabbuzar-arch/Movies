# PopcornNet (single file, Vercel + GitHub)

Files: `index.html` (the whole site) · `logo.png`, `favicon.ico`, `favicon-*.png`, `apple-touch-icon.png`, `android-chrome-*.png`, `site.webmanifest` (logo and icons) · `api/proxy.js` (Vercel function) · `vercel.json`

## Deploy
1. Put these files in a GitHub repo (keep the `api/` folder).
2. vercel.com → Add New → Project → import the repo → Framework "Other" → Deploy.
3. To add providers, put their files (or a `.zip`) in the `providers/` folder of the repo and push; they load automatically.

## How it works
- Providers in the `providers/` folder run in the browser. Native (`index.js`) and Vega-style providers work.
- Requests try the site directly first; if the site blocks browsers (CORS) or needs headers like Referer, they go through `/api/proxy`.
- HLS (`.m3u8`) plays with hls.js; tries direct, falls back to the proxy.

## Supported provider formats (put them in the `providers/` folder: .js, .json or .zip)
- Native `index.js` / `main.js` / `provider.js`, Nuvio-style `getStreams(tmdbId, type, season, episode)`, Vega-style split files (`posts.js`, `meta.js`, `episodes.js`, `stream.js`…), and single `.js` files.
- Embed-template `.json`: `{"name":"X","movie":"https://host/embed/movie/{tmdb}","tv":"https://host/embed/tv/{tmdb}/{season}/{episode}"}` (or `{"url": "..."}`, or a list). Plays in an iframe; `{imdb}` is not supported.
- Zips inside zips, and one zip holding many providers (mixed formats are fine).
- Not supported: providers that need their own server or an API (Stremio addons, hosted scrapers), Android/Kotlin plugins (.cs3, APK), Python, TypeScript source (needs compiling to JS first), DASH (.mpd) streams.

## Skipping and duplicates
- The same provider found in several zips/folders is loaded once (first one wins).
- `providers/skip.json` lists providers that must not load: `{"skip": ["toonstream", "*anime*"]}` (id or folder name, `*` is a wildcard). Delete a name from it to bring that provider back.
- Open the site with `#debug` at the end of the URL to see what loaded, what was skipped and why.

## Wrong video?
The player's title bar shows which source is playing. In the gear menu, **Wrong video?** offers *Try next source* and *Never use <source>* (remembered in this browser; *Show hidden sources again* undoes it). Movies are also checked automatically: a video whose length is far from the film's runtime, or whose label names another year or an episode (S01E02), is skipped. If the last remaining source also looks wrong, the player stops and shows a warning with **Play anyway** and **Never use <source>**.

## Dead streams
A stream gets about 22s in total (7s for the direct try, 12s for proxy tries); then the next source is tried automatically, and the player title shows which one (e.g. `(3/12)`). Sources that play move up, sources that keep failing move down (remembered in this browser, quality still counts most).

## Limits
- Extractors (hubcloud, gdflix…) are not bundled. Providers needing Node-only modules won't load.
- `cheerio` is emulated with jQuery (common selectors work; exotic ones may not).
- Video through the proxy uses Vercel bandwidth/function time (60s per request on the free plan); heavy streaming may hit limits.
- The proxy only accepts requests from your own site. To use it from another site (e.g. GitHub Pages) set env `ALLOWED_ORIGINS=https://you.github.io` in Vercel and put the proxy URL in the **Proxy URL** box.
- Only upload provider zips you trust (their code runs in your browser), and only stream content you have rights to.
