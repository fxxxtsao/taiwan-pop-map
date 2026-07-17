// 以 Nominatim 為未匹配學校做地址地理編碼（限速 1.1s/筆，含快取與斷點續跑）
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const cachePath = path.join(dataDir, 'geocode_cache.json');
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'schools_stage1.json'), 'utf8'));
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

const UA = 'taiwan-pop-map-sideproject/1.0 (contact: tg31413@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanAddr(addr) {
  let a = addr.replace(/^\[\d+\]/, '').replace(/\s/g, '');
  a = a.replace(/（[^）]*）|\([^)]*\)/g, '');
  a = a.replace(/[0-9０-９]{1,3}鄰/, '');
  a = a.replace(/([^市區鄉鎮縣]{1,5})[村里](?=[^路街]|$)/, ''); // 移除村里（避免誤刪 XX里路）
  const i = a.indexOf('號');
  if (i >= 0) a = a.slice(0, i + 1);
  return a;
}
function roadOnly(addr) {
  let a = cleanAddr(addr);
  return a.replace(/\d+巷.*$/, '').replace(/[0-9０-９之、-]+號$/, '');
}

async function query(q) {
  if (q in cache) return cache[q];
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=tw&q=' + encodeURIComponent(q);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const v = (j && j[0]) ? { lat: +j[0].lat, lon: +j[0].lon } : null;
    cache[q] = v;
    await sleep(1100);
    return v;
  } catch (e) {
    console.error('ERR', q, e.message);
    await sleep(5000);
    return undefined; // 不寫入快取，可重試
  }
}

(async () => {
  const all = [...stage.elems.filter(s => !s.lat).map(s => [s, 'e']),
               ...stage.kinders.filter(s => !s.lat).map(s => [s, 'k'])];
  console.log('to geocode:', all.length);
  const results = {};
  const outPath = path.join(dataDir, 'geocoded.json');
  if (fs.existsSync(outPath)) Object.assign(results, JSON.parse(fs.readFileSync(outPath, 'utf8')));
  let n = 0, saved = 0;
  for (const [s, t] of all) {
    const key = t + ':' + s.code;
    n++;
    if (results[key] && results[key].src !== 'none') continue;
    // Nominatim 對台灣門牌幾乎無法解析，直接查路名層級（一筆一請求）
    const v = await query(roadOnly(s.addr));
    if (v) results[key] = { lat: v.lat, lon: v.lon, src: 'road' };
    else results[key] = { src: 'none' };
    if (++saved % 25 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(results));
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`progress ${n}/${all.length}`);
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results));
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const ok = Object.values(results).filter(r => r.src !== 'none').length;
  console.log(`done. geocoded ${ok}/${Object.keys(results).length}`);
})();
