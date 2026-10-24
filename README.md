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

## Auto: first stream fast, more servers keep arriving
Playback starts about 1.5s after the first provider answers. The other providers keep searching in the background (up to 45s) and their servers are added to the gear menu > Server as they arrive; if the current stream fails and nothing else is ready yet, the player waits for them instead of showing an error.

## Fullscreen in an APK / WebView
Real fullscreen is used when the platform has it. Android WebViews often do not, so the player then fills the whole screen itself ("page fullscreen"). If the phone is held upright the picture is turned sideways so tilting the phone shows it the right way up; with auto-rotate on it simply fills the landscape screen. Tap the fullscreen button again (or press Escape) to leave. Embedded iframe players (type "embed") use their own fullscreen button.

## No playable stream
The message now says how many providers were checked, how many had the title and how many failed, and there is a **Search again** button (plus **Details**). A provider that failed twice is paused for 3 minutes only, not for the whole session.

## Dead streams
A stream gets about 22s in total (7s for the direct try, 12s for proxy tries); then the next source is tried automatically, and the player title shows which one (e.g. `(3/12)`). Sources that play move up, sources that keep failing move down (remembered in this browser, quality still counts most).

## Standalone HTML / APK (`popcornnet-apk.html`)
A copy of the site that does not need to be hosted: it sets `window.BACKEND` to the live site and uses its `/api/*` and `/providers/*`.
1. Vercel → Settings → Environment Variables → add `APP_KEY` = any long random string, redeploy.
2. In `popcornnet-apk.html` replace `PUT_YOUR_APP_KEY_HERE` with the same string.
3. Upload that HTML to an HTML-to-APK builder (needs internet).
The key is stored inside the app, so anyone who unpacks the APK can read it: treat it as a deterrent against random sites, not as a secret. Change it in Vercel (and rebuild the APK) if it leaks. Without `APP_KEY`, search/browse still work but streams that need the proxy will not.

## Daily movie notification (APK push, app closed)
`api/daily.js` runs once a day by Vercel Cron (`vercel.json`, 14:30 UTC = 8 pm India time), picks a random popular movie and sends it to the Firebase topic `all`, which APKs built with the Any2APK "Push notifications" option subscribe to. No database needed.
1. Firebase console: create a project, add an Android app with your APK's package name, download `google-services.json`, and upload it in Any2APK's push section when building the APK.
2. Firebase console > Project settings > Service accounts > Generate new private key. Paste the whole JSON into Vercel env `FIREBASE_SERVICE_ACCOUNT`.
3. Vercel env `CRON_SECRET` = any long random string (Vercel Cron uses it automatically). Redeploy.
4. Preview without sending: `https://<site>/api/daily?key=<CRON_SECRET>&dry=1`. Send now: same URL without `&dry=1`.
Vercel's free plan runs a cron once a day, within the scheduled hour. Browsers (not the APK) do not get these notifications.

## Legal pages, reports and removals
The fixed bar at the bottom of the screen has About (disclaimer: nothing is hosted here, all content comes from third-party providers), Privacy Policy, Contact us (sarimforbusiness@gmail.com) and Report a movie. Every title also has a "Report this title" link. Reports open an email to the contact address (with a Copy button for apps that cannot open mail).
To take a title off the site after a report, add it to `blocked.json` at the repo root and push:
`{"ids": ["tt0111161", "14836"], "titles": ["Some Title"]}` (IMDb id, TMDB id, or exact title). Blocked titles disappear from lists, search and "More like this". It does not remove files from the third-party sites that host them.
The texts are in `index.html` (search for `openInfo`); they are not legal advice, so have them reviewed if you need that.

## Limits
- Extractors (hubcloud, gdflix…) are not bundled. Providers needing Node-only modules won't load.
- `cheerio` is emulated with jQuery (common selectors work; exotic ones may not).
- Video through the proxy uses Vercel bandwidth/function time (60s per request on the free plan); heavy streaming may hit limits.
- The proxy only accepts requests from your own site. To use it from another site (e.g. GitHub Pages) set env `ALLOWED_ORIGINS=https://you.github.io` in Vercel and put the proxy URL in the **Proxy URL** box.
- Only upload provider zips you trust (their code runs in your browser), and only stream content you have rights to.
