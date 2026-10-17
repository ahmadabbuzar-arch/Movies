// Lists the files inside /providers so the site can load every provider automatically.
const fs = require("fs"), path = require("path");
function walk(dir, base = "") {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!/^(node_modules|\.git|\.github|test|tests|__tests__|docs|examples|scripts|coverage)$/i.test(e.name)) out = out.concat(walk(path.join(dir, e.name), rel)); }
    else if (/\.(c|m)?js$|\.json$/i.test(e.name) && !/(^|\/)(package-lock|tsconfig|index)\.json$|\.d\.ts$|\.map$/i.test(rel)) out.push(rel);
  }
  return out;
}
module.exports = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=600");
  try { res.end(JSON.stringify({ files: walk(path.join(process.cwd(), "providers")) })); }
  catch (e) { res.end(JSON.stringify({ files: [], error: e.message })); }
};
