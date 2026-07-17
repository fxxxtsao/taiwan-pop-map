// 合併 stage1 + geocoded 結果，輸出 web/schools.json
// 地理編碼結果會做「點位落在所屬鄉鎮/縣市」驗證，不符者退回鄉鎮中心點
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const { geoContains, geoCentroid } = require('d3-geo');

const dataDir = path.join(__dirname, '..', 'data');
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'schools_stage1.json'), 'utf8'));
const geoPath = path.join(dataDir, 'geocoded.json');
const geo = fs.existsSync(geoPath) ? JSON.parse(fs.readFileSync(geoPath, 'utf8')) : {};

// 鄉鎮 polygon 索引
const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const townFeats = topojson.feature(topo, topo.objects.towns).features;
const normTW = s => (s || '').replace(/臺/g, '台');
const townIdx = new Map();   // 縣市|鄉鎮 -> feature
const countyIdx = new Map(); // 縣市 -> [features]
for (const f of townFeats) {
  const c = normTW(f.properties.COUNTYNAME);
  townIdx.set(c + '|' + f.properties.TOWNNAME, f);
  if (!countyIdx.has(c)) countyIdx.set(c, []);
  countyIdx.get(c).push(f);
}

function inCounty(s, lat, lon) {
  const fs2 = countyIdx.get(normTW(s.county)) || [];
  for (const f of fs2) if (geoContains(f, [lon, lat])) return true;
  return false;
}
function townCentroid(s) {
  const tf = townIdx.get(normTW(s.county) + '|' + normTW(s.town || ''));
  if (!tf) return null;
  const [clon, clat] = geoCentroid(tf);
  return { lat: clat, lon: clon, src: 'town' };
}

// 驗證地理編碼點位；錯置時回傳鄉鎮中心點，無法修正回傳 null
let nFixed = 0, nRejected = 0, nOsmRejected = 0;
function validate(s, lat, lon) {
  const tf = townIdx.get(normTW(s.county) + '|' + normTW(s.town || ''));
  if (tf) {
    if (geoContains(tf, [lon, lat])) return { lat, lon, src: 'road' };
    const [clon, clat] = geoCentroid(tf);
    nFixed++;
    return { lat: clat, lon: clon, src: 'town' }; // 跨區錯置 → 鄉鎮中心
  }
  // 沒有鄉鎮資訊時至少確認縣市
  const fs2 = countyIdx.get(normTW(s.county)) || [];
  for (const f of fs2) if (geoContains(f, [lon, lat])) return { lat, lon, src: 'road' };
  nRejected++;
  return null;
}

// 顯示用簡名：去除「XX學校財團法人XX市」等法人前綴
function shortName(name) {
  let n = name.replace(/^.{0,20}?財團法人/, '').replace(/^(臺北市|新北市|桃園市|臺中市|臺南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|澎湖縣|金門縣|連江縣)(?=.)/, '');
  return n || name;
}

function rows(list, type) {
  const out = [];
  let n = 0;
  for (const s of list) {
    let { lat, lon, src } = s;
    // OSM/宿主比對結果也做縣市落區驗證，錯置者改走地理編碼或鄉鎮中心
    if (lat && !inCounty(s, lat, lon)) {
      nOsmRejected++;
      lat = lon = src = undefined;
    }
    if (!lat) {
      const g = geo[type + ':' + s.code];
      if (g && g.src !== 'none') {
        const v = validate(s, g.lat, g.lon);
        if (v) { lat = v.lat; lon = v.lon; src = v.src; }
      } else if (src === undefined && s.lat) {
        // 被縣市驗證剔除且無地理編碼 → 鄉鎮中心
        const c = townCentroid(s);
        if (c) { lat = c.lat; lon = c.lon; src = c.src; }
      }
    }
    if (!lat) { n++; continue; }
    out.push([shortName(s.name), +lat.toFixed(5), +lon.toFixed(5), s.pub, s.county, s.town || '', src]);
  }
  console.log(`${type}: ${out.length} exported, ${n} still missing`);
  return out;
}

const out = {
  updated: new Date().toISOString().slice(0, 10),
  elemYear: 114, kinderYear: 113,
  elem: rows(stage.elems, 'e'),
  kinder: rows(stage.kinders, 'k'),
};
fs.writeFileSync(path.join(__dirname, '..', 'web', 'schools.json'), JSON.stringify(out));
console.log(`validation: 地理編碼跨區改鄉鎮中心 ${nFixed} 筆, OSM比對跨縣市剔除 ${nOsmRejected} 筆, 無法驗證捨棄 ${nRejected} 筆`);
console.log('written web/schools.json');
