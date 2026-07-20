// 補習班地址地理編碼（Nominatim 路名級，共用 geocode_cache.json，可中斷續跑）
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const cachePath = path.join(dataDir, 'geocode_cache.json');
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'cram_stage1.json'), 'utf8'));
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

const UA = 'taiwan-pop-map-sideproject/1.0 (contact: tg31413@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanAddr(addr) {
  let a = addr.replace(/^\[\d+\]/, '').replace(/\s/g, '');
  a = a.replace(/（[^）]*）|\([^)]*\)/g, '');
  a = a.replace(/[0-9０-９]{1,3}鄰/, '');
  a = a.replace(/([^市區鄉鎮縣]{1,5})[村里](?=[^路街]|$)/, '');
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
    return undefined;
  }
}

(async () => {
  const outPath = path.join(dataDir, 'cram_geocoded.json');
  const results = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  console.log('to geocode:', stage.length);
  let n = 0, saved = 0;
  for (const s of stage) {
    const key = s.county + s.name; // 名稱含縣市與班名，足以唯一
    n++;
    if (results[key] && results[key].src !== 'none') continue;
    const v = await query(roadOnly(s.addr));
    if (v) results[key] = { lat: v.lat, lon: v.lon, src: 'road' };
    else results[key] = { src: 'none' };
    if (++saved % 25 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(results));
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`progress ${n}/${stage.length}`);
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results));
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const ok = Object.values(results).filter(r => r.src !== 'none').length;
  console.log(`done. geocoded ${ok}/${Object.keys(results).length}`);
})();
