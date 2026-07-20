// 補習班地址地理編碼（Google Geocoding，門牌精度，可中斷續跑）
// 升級 cram_geocoded.json 內 road 級的點；查無門牌時保留原有 Nominatim 結果。
// 金鑰來源：環境變數 GOOGLE_MAPS_API_KEY，或專案根目錄 .google_key 檔（已列入 .gitignore）。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

function readKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY.trim();
  const f = path.join(root, '.google_key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  console.error('找不到金鑰：請設 GOOGLE_MAPS_API_KEY 環境變數，或在專案根目錄放 .google_key 檔');
  process.exit(1);
}
const KEY = readKey();

const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'cram_stage1.json'), 'utf8'));
const outPath = path.join(dataDir, 'cram_geocoded.json');
const results = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
const cachePath = path.join(dataDir, 'google_cache.json');
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 保留門牌號的清理（去除 [序號]、括號、鄰、村里、樓層之後的贅字，止於「號」）
function cleanAddr(addr) {
  let a = addr.replace(/^\[\d+\]/, '').replace(/\s/g, '');
  a = a.replace(/（[^）]*）|\([^)]*\)/g, '');
  a = a.replace(/[0-9０-９]{1,3}鄰/, '');
  a = a.replace(/([^市區鄉鎮縣]{1,5})[村里](?=[^路街]|$)/, '');
  const i = a.indexOf('號');
  if (i >= 0) a = a.slice(0, i + 1);
  return a;
}

// ROOFTOP / RANGE_INTERPOLATED → 門牌精確；其餘 → 路名/概略
const isHouse = t => t === 'ROOFTOP' || t === 'RANGE_INTERPOLATED';

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
    return undefined; // 交由呼叫端 while 迴圈重試
  }
  if (j.status === 'OK') {
    const g = j.results[0];
    const v = { lat: g.geometry.location.lat, lon: g.geometry.location.lng, loc: g.geometry.location_type };
    cache[q] = v;
    await sleep(60);
    return v;
  }
  if (j.status === 'ZERO_RESULTS') { cache[q] = null; await sleep(60); return null; }
  if (j.status === 'OVER_QUERY_LIMIT') { console.error('OVER_QUERY_LIMIT, 等 30s'); await sleep(30000); return undefined; }
  // REQUEST_DENIED / INVALID_REQUEST 等：金鑰或設定問題，停止避免空轉
  console.error('停止：Google 回', j.status, j.error_message || '');
  process.exit(1);
}

(async () => {
  console.log('total:', stage.length);
  let n = 0, saved = 0, house = 0, road = 0, miss = 0;
  for (const s of stage) {
    const key = s.county + s.name;
    n++;
    if (results[key] && results[key].src === 'house') { house++; continue; } // 已門牌精度，跳過
    const q = s.county + cleanAddr(s.addr);
    let v;
    do { v = await query(q); } while (v === undefined); // 遇 quota 重試
    if (v) {
      results[key] = { lat: +v.lat.toFixed(7), lon: +v.lon.toFixed(7), src: isHouse(v.loc) ? 'house' : 'road' };
      if (isHouse(v.loc)) house++; else road++;
    } else if (!results[key] || results[key].src === 'none') {
      results[key] = { src: 'none' }; miss++;        // 查無且原本也沒有
    } else { road++; }                                // 查無但保留原 Nominatim
    if (++saved % 50 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(results));
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`progress ${n}/${stage.length}  house ${house} road ${road} miss ${miss}`);
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results));
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`done. house ${house}, road ${road}, miss ${miss}`);
})();
