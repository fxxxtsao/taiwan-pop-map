// 用 Google Places Text Search 以「店名」補正無法門牌級定位的 KUMON 教室
// 對象：kumon_geocoded 中 src!=house，或座標落在地址對應區界外者。
// Places 回傳的實際店址通過落區驗證才採用，寫回 kumon_geocoded.json（src=house）。
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains } = require('d3-geo');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const KEY = (process.env.GOOGLE_MAPS_API_KEY || fs.readFileSync(path.join(root, '.google_key'), 'utf8')).trim();

const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'kumon_stage.json'), 'utf8'));
const geoPath = path.join(dataDir, 'kumon_geocoded.json');
const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));

const norm = s => (s || '').replace(/臺/g, '台');
const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const feats = topojson.feature(topo, topo.objects.towns).features;
const byCounty = new Map();
for (const f of feats) {
  const c = norm(f.properties.COUNTYNAME);
  if (!byCounty.has(c)) byCounty.set(c, []);
  byCounty.get(c).push({ town: norm(f.properties.TOWNNAME), f });
}
function addrFeature(addr) { // 以地址前綴比對真實區名 → 區界 feature
  const a = norm(addr);
  const cm = a.match(/^(.{2,3}?[縣市])/);
  if (!cm) return null;
  const rest = a.slice(cm[1].length);
  const towns = byCounty.get(cm[1]) || [];
  let best = null;
  for (const t of towns) if (rest.startsWith(t.town) && (!best || t.town.length > best.town.length)) best = t;
  return best ? best.f : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function places(name) {
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?language=zh-TW&region=tw&query='
    + encodeURIComponent(name) + '&key=' + KEY;
  const j = await (await fetch(url)).json();
  if (j.status !== 'OK' || !j.results.length) return null;
  const r = j.results[0];
  return { lat: r.geometry.location.lat, lon: r.geometry.location.lng, name: r.name, addr: r.formatted_address };
}

(async () => {
  const targets = stage.filter(s => {
    const g = geo[s.name];
    if (!g || g.src !== 'house' || g.lat == null) return true;
    const f = addrFeature(s.addr);
    return f ? !geoContains(f, [g.lon, g.lat]) : false;
  });
  console.log('待補正:', targets.length);
  let fixed = 0;
  const unresolved = [];
  for (const s of targets) {
    const p = await places(s.name);
    await sleep(150);
    const f = addrFeature(s.addr);
    if (p && (!f || geoContains(f, [p.lon, p.lat]))) {
      geo[s.name] = { lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7), src: 'house' };
      fixed++;
      console.log('  ✓', s.name, '→', p.addr, p.lat.toFixed(6), p.lon.toFixed(6));
    } else {
      unresolved.push(s.name);
      console.log('  ✗', s.name, p ? '（Places 落區不符：' + p.addr + '）' : '（Places 查無）');
    }
  }
  fs.writeFileSync(geoPath, JSON.stringify(geo));
  console.log(`done. 補正 ${fixed}，未解 ${unresolved.length}`, unresolved.join('、'));
})();
