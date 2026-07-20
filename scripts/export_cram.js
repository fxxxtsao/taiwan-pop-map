// 合併補習班 stage1 + 地理編碼結果 → web/cram.json
// 點位需落在其 TOWNCODE 鄉鎮內，否則退回鄉鎮中心點
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains, geoCentroid } = require('d3-geo');

const dataDir = path.join(__dirname, '..', 'data');
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'cram_stage1.json'), 'utf8'));
const geoPath = path.join(dataDir, 'cram_geocoded.json');
const geo = fs.existsSync(geoPath) ? JSON.parse(fs.readFileSync(geoPath, 'utf8')) : {};

const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const feat = new Map(); // TOWNCODE -> feature
for (const f of topojson.feature(topo, topo.objects.towns).features)
  feat.set(f.properties.TOWNCODE, f);

const rows = [];
const cnt = { house: 0, road: 0, town: 0 };
let nMiss = 0;
for (const s of stage) {
  const g = geo[s.county + s.name];
  const tf = feat.get(s.towncode);
  let lat, lon, src;
  if (g && g.src !== 'none' && tf && geoContains(tf, [g.lon, g.lat])) {
    lat = g.lat; lon = g.lon; src = g.src; // 保留 house / road 精度
  } else if (tf) {
    const [clon, clat] = geoCentroid(tf); // 查無或跨區 → 鄉鎮中心
    lat = clat; lon = clon; src = 'town';
  } else { nMiss++; continue; }
  cnt[src]++;
  rows.push([s.name, +lat.toFixed(6), +lon.toFixed(6), s.cat, s.county, s.town, src]);
}

const out = { updated: new Date().toISOString().slice(0, 10), source: '教育部全國短期補習班資訊管理系統', rows };
fs.writeFileSync(path.join(__dirname, '..', 'web', 'cram.json'), JSON.stringify(out));
console.log(`exported ${rows.length}（門牌 ${cnt.house}, 路名 ${cnt.road}, 鄉鎮中心 ${cnt.town}, 捨棄 ${nMiss}）→ web/cram.json`);
