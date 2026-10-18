// Server-side TMDB proxy: the API key lives in the Vercel env var TMDB_API_KEY and never reaches the browser.
module.exports = async (req, res) => {
  const key = process.env.TMDB_API_KEY;
  res.setHeader("cache-control", "s-maxage=3600, stale-while-revalidate=86400");
  if (!key) return res.status(200).json({ configured: false });
  const { path: p = "", check, ...rest } = req.query || {};
  if (check) return res.status(200).json({ configured: true });
  if (!/^(discover\/(movie|tv)|(movie|tv)\/\d+\/external_ids)$/.test(p)) return res.status(400).json({ error: "path not allowed" });
  try {
    const q = new URLSearchParams(rest); q.set("api_key", key);
    const r = await fetch(`https://api.themoviedb.org/3/${p}?${q}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: e.message }); }
};
