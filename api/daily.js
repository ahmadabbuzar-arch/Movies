// Daily "movie of the day" push notification.
// Vercel Cron calls /api/daily once a day; it picks a random popular movie (Cinemeta, no key needed)
// and sends it to the Firebase Cloud Messaging topic that the APK subscribes to (default "all").
//
// Vercel env vars:
//   CRON_SECRET               required: any long random string (Vercel Cron sends it automatically)
//   FIREBASE_SERVICE_ACCOUNT  required to really send: the service-account JSON (or the same JSON in base64)
//   PUSH_TOPIC                optional: FCM topic, default "all"
//   APP_URL                   optional: only used in the preview text
//
// Preview without sending:  /api/daily?key=<CRON_SECRET>&dry=1
const crypto = require("node:crypto");

const CINEMETA = "https://v3-cinemeta.strem.io";
const b64u = (x) => Buffer.from(x).toString("base64url");
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const OPENERS = [
  "Aaj raat ka plan: {name}",
  "Popcorn ready rakho! {name}",
  "Aaj ki suggestion: {name}",
  "Kya dekhein? {name} try karo",
  "Movie night ke liye perfect: {name}",
  "Aapke liye aaj ka pick: {name}",
  "Boring din? {name} lagao",
];
const NUDGES = [
  "PopcornNet kholo aur abhi dekhna shuru karo.",
  "Ek baar dekhna shuru karo, maza aayega.",
  "Phone utha ke abhi chalao.",
  "Dost ya family ke saath dekhne layak.",
  "Search mein naam likho aur play dabao.",
  "Aaj hi dekh dalo, kal naya pick aayega.",
];

async function randomMovie() {
  const skips = [0, 100, 200, 300, 400];
  const order = skips.sort(() => Math.random() - 0.5);
  for (const skip of order) { // a page can fail, so try a few
    try {
      const r = await fetch(`${CINEMETA}/catalog/movie/top${skip ? `/skip=${skip}` : ""}.json`);
      if (!r.ok) continue;
      const j = await r.json();
      const list = (j.metas || []).filter((m) => m && m.name && m.poster);
      if (list.length) return pick(list);
    } catch { /* try the next page */ }
  }
  throw new Error("Could not get a movie from Cinemeta");
}

function buildMessage(m, topic) {
  const year = parseInt(m.year || m.releaseInfo, 10) || "";
  const genre = Array.isArray(m.genres) && m.genres.length ? m.genres.slice(0, 2).join(" / ") : "";
  const title = `🎬 ${pick(OPENERS).replace("{name}", m.name)}${year ? ` (${year})` : ""}`;
  const body = [genre && `${genre}.`, pick(NUDGES)].filter(Boolean).join(" ");
  return {
    message: {
      topic,
      notification: { title, body, image: m.poster },
      android: { priority: "HIGH", notification: { image: m.poster } },
      data: { type: "daily_pick", imdb: String(m.imdb_id || m.id || ""), name: String(m.name) },
    },
  };
}

function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  for (const txt of [raw, (() => { try { return Buffer.from(raw, "base64").toString("utf8"); } catch { return ""; } })()]) {
    try { const j = JSON.parse(txt); if (j.client_email && j.private_key && j.project_id) return j; } catch { /* try next form */ }
  }
  return null;
}

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }))}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Google auth failed: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

module.exports = async (req, res) => {
  const send = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(obj)); };
  const secret = process.env.CRON_SECRET;
  if (!secret) return send(503, { error: "Set CRON_SECRET in Vercel environment variables first." });
  const q = new URL(req.url, "http://x").searchParams;
  if (req.headers.authorization !== `Bearer ${secret}` && q.get("key") !== secret) return send(401, { error: "Unauthorized" });
  try {
    const topic = process.env.PUSH_TOPIC || "all";
    const msg = buildMessage(await randomMovie(), topic);
    if (q.get("dry")) return send(200, { dry: true, willSendTo: topic, ...msg });
    const sa = loadServiceAccount();
    if (!sa) return send(503, { error: "FIREBASE_SERVICE_ACCOUNT is missing or not valid JSON.", preview: msg });
    const token = await accessToken(sa);
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(msg),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(502, { error: j.error?.message || `FCM ${r.status}`, preview: msg });
    return send(200, { sent: true, topic, id: j.name, title: msg.message.notification.title });
  } catch (e) { return send(502, { error: e.message }); }
};
