// mpm_stage + mpm_geocoded → web/mpm.json
// 縣市/區以地址字串為準，落區驗證：座標不在該區界內 → 退回鄉鎮中心（src=town）。
// rows: [name, lat, lon, county, town, src]
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains, geoCentroid } = require('d3-geo');
const dataDir = path.join(__dirname, '..', 'data');
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'mpm_stage.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(dataDir, 'mpm_geocoded.json'), 'utf8'));
const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const norm = s => (s || '').replace(/臺/g, '台');
const feats = topojson.feature(topo, topo.objects.towns).features;
const byCounty = new Map();
for (const f of feats) {
  const c = norm(f.properties.COUNTYNAME);
  if (!byCounty.has(c)) byCounty.set(c, []);
  byCounty.get(c).push({ town: norm(f.properties.TOWNNAME), f });
}
function parseLoc(addr) {
  const a = norm(addr);
  const cm = a.match(/^(.{2,3}?[縣市])/);
  if (!cm) return null;
  const county = cm[1];
  const rest = a.slice(county.length);
  const towns = byCounty.get(county);
  if (!towns) return null;
  let best = null;
  for (const t of towns) if (rest.startsWith(t.town) && (!best || t.town.length > best.town.length)) best = t;
  return best ? { county, town: best.town, f: best.f } : { county, town: null, f: null };
}
const rows = [];
const cnt = {};
const missed = [], relocated = [];
for (const s of stage) {
  const g = geo[s.key];
  if (!g || g.src === 'none' || g.lat == null) { missed.push(s.name); continue; }
  const loc = parseLoc(s.addr) || { county: s.county, town: s.town, f: null };
  let lat = +g.lat.toFixed(6), lon = +g.lon.toFixed(6), src = g.src;
  if (loc.f && !geoContains(loc.f, [lon, lat])) {
    const [clon, clat] = geoCentroid(loc.f); // 跨區 → 鄉鎮中心
    lat = +clat.toFixed(6); lon = +clon.toFixed(6); src = 'town';
    relocated.push(`${s.name}（${loc.county}${loc.town}）`);
  }
  cnt[src] = (cnt[src] || 0) + 1;
  rows.push([s.name, lat, lon, loc.county || s.county, loc.town || s.town || '', src]);
}
const out = { updated: new Date().toISOString().slice(0, 10), source: 'MPM 數學 教室清單', rows };
fs.writeFileSync(path.join(__dirname, '..', 'web', 'mpm.json'), JSON.stringify(out));
console.log(`exported ${rows.length}（路名 ${cnt.road || 0}, 鄉鎮中心 ${cnt.town || 0}）→ web/mpm.json`);
if (relocated.length) console.log(`跨區退回中心 ${relocated.length} 校`);
if (missed.length) console.log(`查無座標 ${missed.length} 校: ${missed.slice(0,15).join('、')}${missed.length>15?' …':''}`);
