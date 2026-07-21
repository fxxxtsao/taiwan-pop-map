// KUMON 地址地理編碼（Google，門牌精度，共用 google_cache.json）
// 金鑰：環境變數 GOOGLE_MAPS_API_KEY，或專案根 .google_key。輸出 data/kumon_geocoded.json（以 name 為鍵）。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

function readKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY.trim();
  const f = path.join(root, '.google_key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  console.error('找不到金鑰：請設 GOOGLE_MAPS_API_KEY 或在專案根放 .google_key');
  process.exit(1);
}
const KEY = readKey();

const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'kumon_stage.json'), 'utf8'));
const outPath = path.join(dataDir, 'kumon_geocoded.json');
const results = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
const cachePath = path.join(dataDir, 'google_cache.json');
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 阿拉伯數字段號轉中文（Google 才不會誤解析成 partial_match）
function toCN(n) {
  const d = '零一二三四五六七八九';
  if (n < 10) return d[n];
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
  return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
}
function normSeg(a) { return a.replace(/(\d+)\s*段/g, (m, n) => toCN(+n) + '段'); }

// 清理：去 [序號]、括號、鄰、村里、樓層之後贅字，止於「號」（保留門牌號）
function cleanAddr(addr) {
  let a = addr.replace(/^\[\d+\]/, '').replace(/\s/g, '');
  a = a.replace(/（[^）]*）|\([^)]*\)/g, '');
  a = a.replace(/[0-9０-９]{1,3}鄰/, '');
  a = a.replace(/([^市區鄉鎮縣]{1,5})[村里](?=[^路街]|$)/, '');
  const i = a.indexOf('號');
  if (i >= 0) a = a.slice(0, i + 1);
  return normSeg(a);
}

const isHouse = (t, pm) => !pm && (t === 'ROOFTOP' || t === 'RANGE_INTERPOLATED');

async function query(q) {
  if (q in cache) return cache[q];
  const url = 'https://maps.googleapis.com/maps/api/geocode/json'
    + '?region=tw&language=zh-TW&address=' + encodeURIComponent(q) + '&key=' + KEY;
  let j;
  try {
    const r = await fetch(url);
    j = await r.json();
  } catch (e) {
    console.error('網路錯誤，等 5s 重試:', e.cause ? e.cause.code : e.message);
    await sleep(5000);
    return undefined;
  }
  if (j.status === 'OK') {
    const g = j.results[0];
    const v = { lat: g.geometry.location.lat, lon: g.geometry.location.lng, loc: g.geometry.location_type, pm: !!g.partial_match };
    cache[q] = v;
    await sleep(60);
    return v;
  }
  if (j.status === 'ZERO_RESULTS') { cache[q] = null; await sleep(60); return null; }
  if (j.status === 'OVER_QUERY_LIMIT') { console.error('OVER_QUERY_LIMIT, 等 30s'); await sleep(30000); return undefined; }
  console.error('停止：Google 回', j.status, j.error_message || '');
  process.exit(1);
}

(async () => {
  console.log('total:', stage.length);
  let n = 0, house = 0, road = 0, miss = 0;
  for (const s of stage) {
    n++;
    if (results[s.name] && results[s.name].src === 'house') { house++; continue; }
    const q = cleanAddr(s.addr); // 地址已含縣市前綴
    let v;
    do { v = await query(q); } while (v === undefined);
    if (v) {
      const h = isHouse(v.loc, v.pm);
      results[s.name] = { lat: +v.lat.toFixed(7), lon: +v.lon.toFixed(7), src: h ? 'house' : 'road' };
      if (h) house++; else road++;
    } else {
      results[s.name] = { src: 'none' }; miss++;
    }
    if (n % 25 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(results));
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`progress ${n}/${stage.length}  house ${house} road ${road} miss ${miss}`);
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results));
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`done. house ${house}, road ${road}, miss ${miss}`);
})();
