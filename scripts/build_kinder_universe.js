// 以教保網 is_active=1（7,311 園）為幼兒園單一母體，重建座標＋核定招收人數。
// 對得上現有點位者沿用原座標；對不上的 gap 用 ece 地址 Google 門牌級編碼（Places 補正＋落區驗證）。
// 輸出 data/kinder_full.json：rows=[name, lat, lon, type, county, town, capacity, coordSrc]
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains, geoCentroid } = require('d3-geo');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const KEY = (process.env.GOOGLE_MAPS_API_KEY || fs.readFileSync(path.join(root, '.google_key'), 'utf8')).trim();
const cachePath = path.join(dataDir, 'google_cache.json');
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

const norm = s => (s || '').replace(/臺/g, '台');
function na(a) { // 地址正規化（去[郵遞]、縣市/區/里/鄰，止於號）
  let s = norm(a).replace(/^\[[0-9]+\]/, '').replace(/\s/g, '');
  s = s.replace(/^[^市縣]*[縣市]/, '').replace(/^[^區鄉鎮市]*[區鄉鎮市]/, '');
  s = s.replace(/^[^里村]*[里村]/, '').replace(/^[0-9]+鄰/, '');
  s = s.replace(/（[^）]*）|\([^)]*\)/g, '');
  const i = s.indexOf('號'); if (i >= 0) s = s.slice(0, i + 1);
  return s;
}
function nn(n) {
  return norm(n).replace(/(財團法人|學校財團法人|社團法人|股份有限公司|有限公司)/g, '')
    .replace(/[\s（）()、,，.．]/g, '').replace(/私立|市立|縣立|國立|公立/g, '');
}
// 地理編碼用地址清理（保留門牌、段號轉中文）
function toCN(n) { const d = '零一二三四五六七八九'; if (n < 10) return d[n]; if (n < 20) return '十' + (n % 10 ? d[n % 10] : ''); return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : ''); }
function cleanAddr(a) {
  let s = norm(a).replace(/^\[[0-9]+\]/, '').replace(/\s/g, '').replace(/（[^）]*）|\([^)]*\)/g, '');
  const i = s.indexOf('號'); if (i >= 0) s = s.slice(0, i + 1);
  return s.replace(/(\d+)\s*段/g, (m, x) => toCN(+x) + '段');
}
const isHouse = (t, pm) => !pm && (t === 'ROOFTOP' || t === 'RANGE_INTERPOLATED');

// 區界
const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const feats = topojson.feature(topo, topo.objects.towns).features;
const featOf = new Map();
for (const f of feats) featOf.set(norm(f.properties.COUNTYNAME) + norm(f.properties.TOWNNAME), f);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function geocode(q) {
  if (q in cache) return cache[q];
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?region=tw&language=zh-TW&address=' + encodeURIComponent(q) + '&key=' + KEY;
  let j; try { j = await (await fetch(url)).json(); } catch (e) { await sleep(4000); return undefined; }
  if (j.status === 'OK') { const g = j.results[0]; const v = { lat: g.geometry.location.lat, lon: g.geometry.location.lng, loc: g.geometry.location_type, pm: !!g.partial_match }; cache[q] = v; await sleep(50); return v; }
  if (j.status === 'ZERO_RESULTS') { cache[q] = null; await sleep(50); return null; }
  if (j.status === 'OVER_QUERY_LIMIT') { await sleep(30000); return undefined; }
  console.error('停止：', j.status, j.error_message || ''); process.exit(1);
}
async function placeQuery(name) {
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?language=zh-TW&region=tw&query=' + encodeURIComponent(name) + '&key=' + KEY;
  let j; try { j = await (await fetch(url)).json(); } catch (e) { return null; }
  if (j.status !== 'OK' || !j.results.length) return null;
  const r = j.results[0]; await sleep(80);
  return { lat: r.geometry.location.lat, lon: r.geometry.location.lng };
}

(async () => {
  const ece = JSON.parse(fs.readFileSync(path.join(dataDir, 'ece_preschools.json'), 'utf8')).features
    .map(f => f.properties).filter(p => p.is_active === 1);
  // 現有幼兒園座標：照 export_schools 同套邏輯，由 stage1 算出（s.lat 優先，否則 geocoded[k:code]，跨區退中心）
  const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'schools_stage1.json'), 'utf8')).kinders;
  const geoK = JSON.parse(fs.readFileSync(path.join(dataDir, 'geocoded.json'), 'utf8'));
  function stageCoord(s) {
    if (s.lat != null && s.lon != null) return { lat: s.lat, lon: s.lon };
    const g = geoK['k:' + s.code];
    if (g && g.src !== 'none' && g.lat != null) {
      const f = featOf.get(norm(s.county) + norm(s.town));
      if (f && !geoContains(f, [g.lon, g.lat])) { const [clon, clat] = geoCentroid(f); return { lat: clat, lon: clon }; }
      return { lat: g.lat, lon: g.lon };
    }
    return null;
  }
  const byName = new Map(), byAddr = new Map(); // county+town+鍵 -> {lat,lon}
  for (const s of stage) {
    const c = stageCoord(s); if (!c) continue;
    const key = norm(s.county) + norm(s.town);
    byName.set(key + nn(s.name), c);
    byAddr.set(key + na(s.addr), c);
  }

  const rows = []; const cnt = { inherit: 0, house: 0, place: 0, town: 0, miss: 0 };
  let done = 0;
  for (const p of ece) {
    const county = norm(p.city), town = norm(p.town), key = county + town;
    const cap = parseInt((p.count_approved || '0').toString().replace(/,/g, ''), 10) || 0;
    const c = byName.get(key + nn(p.title)) || byAddr.get(key + na(p.address));
    if (c) { rows.push([norm(p.title), +c.lat.toFixed(6), +c.lon.toFixed(6), p.type, county, town, cap, 'inherit']); cnt.inherit++; continue; }
    // gap：地理編碼
    const f = featOf.get(key);
    let lat, lon, src = null;
    let v; do { v = await geocode(county + town + cleanAddr(p.address)); } while (v === undefined);
    if (v && isHouse(v.loc, v.pm) && (!f || geoContains(f, [v.lon, v.lat]))) { lat = v.lat; lon = v.lon; src = 'house'; cnt.house++; }
    if (!src) { // Places 以店名補
      const pl = await placeQuery(norm(p.title));
      if (pl && (!f || geoContains(f, [pl.lon, pl.lat]))) { lat = pl.lat; lon = pl.lon; src = 'place'; cnt.place++; }
    }
    if (!src && f) { const [clon, clat] = geoCentroid(f); lat = clat; lon = clon; src = 'town'; cnt.town++; }
    if (!src) { cnt.miss++; continue; }
    rows.push([norm(p.title), +lat.toFixed(6), +lon.toFixed(6), p.type, county, town, cap, src]);
    if (++done % 50 === 0) { fs.writeFileSync(cachePath, JSON.stringify(cache)); console.log(`gap ${done}  house ${cnt.house} place ${cnt.place} town ${cnt.town}`); }
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = { updated: new Date().toISOString().slice(0, 10), source: '教育部國教署全國教保資訊網（is_active=1）', rows };
  fs.writeFileSync(path.join(dataDir, 'kinder_full.json'), JSON.stringify(out));
  console.log(`kinder_full: ${rows.length} 園`, JSON.stringify(cnt));
})();
