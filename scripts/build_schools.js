// 比對官方名錄與 OSM 點位，產出 web/schools.json
// 國小: data/e1_new.csv (114學年)  幼兒園: data/k1_new.csv (113學年)
// OSM: data/osm_schools.json
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains } = require('d3-geo');

const dataDir = path.join(__dirname, '..', 'data');
const read = f => fs.readFileSync(path.join(dataDir, f), 'utf8');

// ---- 鄉鎮 polygon (判斷 OSM 點屬於哪個鄉鎮) ----
const topo = JSON.parse(read('towns-10t.json'));
const towns = topojson.feature(topo, topo.objects.towns).features;
function townOf(lon, lat) {
  for (const f of towns) if (geoContains(f, [lon, lat])) return f.properties;
  return null;
}

// ---- 名稱正規化 ----
const COUNTIES = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/g;
const norm = s => (s || '')
  .replace(/\s/g, '')
  .replace(/臺/g, '台')
  .replace(/國民小學/g, '國小')
  .replace(/國民中學/g, '國中')
  .replace(/高級中學/g, '高中')
  .replace(/幼稚園/g, '幼兒園')
  .replace(COUNTIES, '')
  .replace(/(縣立|市立|私立|國立|公立|非營利)/g, '');

// 去除法人前綴: 「天主教聖心學校財團法人新北市...」取「財團法人」後縣市開頭部分
function stripFoundation(s) {
  const i = s.indexOf('財團法人');
  if (i >= 0) {
    const rest = s.slice(i + 4);
    // rest 可能以縣市開頭
    return rest || s;
  }
  return s;
}

// ---- CSV 解析 (簡單格式，欄位可能帶引號) ----
function parseCsv(txt) {
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += ch;
    }
    cols.push(cur);
    rows.push(cols);
  }
  return rows;
}

// 從地址解析鄉鎮市區，例如 "[234]新北市永和區福和路..." -> 永和區
function townFromAddr(county, addr) {
  const a = addr.replace(/^\[\d+\]/, '').replace(/臺/g, '台');
  const c = county.replace(/臺/g, '台');
  let rest = a.startsWith(c) ? a.slice(c.length) : a;
  const m = rest.match(/^(.{1,4}?(?:區|鄉|鎮|市))/);
  return m ? m[1] : null;
}

// ---- OSM 索引: normName -> [{lat,lon,townKey}] ----
const osm = JSON.parse(read('osm_schools.json')).elements
  .filter(e => e.tags.name)
  .map(e => {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    return { name: e.tags.name, amenity: e.tags.amenity, lat, lon };
  })
  .filter(e => e.lat && e.lon);

console.log('computing OSM town membership...');
for (const e of osm) {
  const p = townOf(e.lon, e.lat);
  e.county = p ? p.COUNTYNAME.replace(/臺/g, '台') : null;
  e.towncode = p ? p.TOWNCODE : null;
}

const osmIdx = new Map(); // county + '|' + normName -> element
for (const e of osm) {
  if (!e.county) continue;
  const key = e.county + '|' + norm(e.name);
  if (!osmIdx.has(key)) osmIdx.set(key, e);
}
// 不含縣市的次級索引（名稱全國唯一才用）
const nameCount = {};
for (const e of osm) { const k = norm(e.name); nameCount[k] = (nameCount[k] || 0) + 1; }
const osmByName = new Map();
for (const e of osm) { const k = norm(e.name); if (nameCount[k] === 1) osmByName.set(k, e); }

// ---- 國小 ----
const elemRows = parseCsv(read('e1_new.csv')).slice(1);
const elems = [];
for (const r of elemRows) {
  if (r.length < 8) continue;
  const [yr, code, name, pub, countyRaw, addr, tel] = r;
  const county = countyRaw.replace(/^\[\d+\]/, '').replace(/臺/g, '台');
  const town = townFromAddr(county, addr);
  elems.push({ code, name, pub, county, town, addr: addr.replace(/^\[\d+\]/, '') });
}

// 比對
let hit = 0;
for (const s of elems) {
  // 名錄名稱多為 "市立XX國小"/"私立XX國小"，OSM 多為 "XX國民小學"/"XX國小"
  const cands = [norm(s.name), norm(s.name).replace(/國小$/, '') + '國小'];
  let m = null;
  for (const c of cands) {
    m = osmIdx.get(s.county + '|' + c) || null;
    if (m) break;
  }
  if (!m) {
    // 全國唯一名稱備援：必須同縣市，避免異縣市同名校共用點位
    const c = osmByName.get(norm(s.name));
    if (c && c.county === s.county) m = c;
  }
  if (m) { s.lat = m.lat; s.lon = m.lon; s.towncode = m.towncode; s.src = 'osm'; hit++; }
}
console.log(`國小: ${elems.length}, OSM matched: ${hit} (${(hit / elems.length * 100).toFixed(1)}%)`);

// 國小座標索引 (給附設幼兒園用): county|normName(去國小) -> school
const elemIdx = new Map();
for (const s of elems) {
  if (s.lat) elemIdx.set(s.county + '|' + norm(s.name), s);
}

// ---- 幼兒園 ----
const kRows = parseCsv(read('k1_new.csv')).slice(1);
const kinders = [];
for (const r of kRows) {
  if (r.length < 8) continue;
  const [yr, code, name, pub, county0, town, addr, tel] = r;
  const county = county0.replace(/臺/g, '台');
  kinders.push({ code, name, pub, county, town: town.replace(/臺/g, '台'), addr: addr.replace(/^\[\d+\]/, '') });
}

let kHostHit = 0, kOsmHit = 0;
for (const k of kinders) {
  const n = stripFoundation(k.name);
  // 1) 附設幼兒園 → 取宿主學校座標 (各級學校)
  const host = n.replace(/臺/g, '台').match(/(.+?(?:國民小學|國小|國民中學|國中|高級中學|高中|中學|實驗學校|大學))附設/);
  if (host) {
    let hn = norm(host[1]);
    const hn2 = hn.startsWith(k.town) ? hn.slice(k.town.length) : hn;
    const cand = elemIdx.get(k.county + '|' + hn) || elemIdx.get(k.county + '|' + hn2)
      || osmIdx.get(k.county + '|' + hn) || osmIdx.get(k.county + '|' + hn2);
    if (cand) { k.lat = cand.lat; k.lon = cand.lon; k.towncode = cand.towncode; k.src = 'host'; kHostHit++; continue; }
  }
  // 2) OSM kindergarten 名稱比對
  const nk = norm(n);
  const nk2 = nk.startsWith(k.town) ? nk.slice(k.town.length) : nk;
  let m = osmIdx.get(k.county + '|' + nk) || osmIdx.get(k.county + '|' + nk2) || null;
  if (!m) {
    const c = osmByName.get(nk);
    if (c && c.county === k.county) m = c; // 備援需同縣市
  }
  if (m) { k.lat = m.lat; k.lon = m.lon; k.towncode = m.towncode; k.src = 'osm'; kOsmHit++; }
}
console.log(`幼兒園: ${kinders.length}, host matched: ${kHostHit}, OSM matched: ${kOsmHit}, total ${(100 * (kHostHit + kOsmHit) / kinders.length).toFixed(1)}%`);

// ---- 輸出 ----
fs.writeFileSync(path.join(dataDir, 'schools_stage1.json'), JSON.stringify({ elems, kinders }));
const un1 = elems.filter(s => !s.lat).length, un2 = kinders.filter(k => !k.lat).length;
console.log(`unmatched: 國小 ${un1}, 幼兒園 ${un2} → 待地理編碼`);
