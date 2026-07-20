// 補習班名錄前處理：data/cram/city_*.json → data/cram_stage1.json
// 只取文理/外語類；TOWNCODE 無效時以地址區名回查修正
// 用法: node scripts/build_cram.js [縣市名]   如 node scripts/build_cram.js 桃園市
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const countyFilter = process.argv[2] ? process.argv[2].replace(/臺/g, '台') : null;
const CATS = /文理|外語/;

const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const atlas = new Map(); // TOWNCODE -> {county, town}
const byName = new Map(); // 縣市+鄉鎮名 -> TOWNCODE
const normTW = s => (s || '').replace(/臺/g, '台');
for (const g of topo.objects.towns.geometries) {
  const p = g.properties;
  atlas.set(p.TOWNCODE, { county: normTW(p.COUNTYNAME), town: p.TOWNNAME });
  byName.set(normTW(p.COUNTYNAME) + '|' + normTW(p.TOWNNAME), p.TOWNCODE);
}

const out = [];
let nAll = 0, nCat = 0, nFixed = 0, nBad = 0;
for (const f of fs.readdirSync(path.join(dataDir, 'cram')).filter(f => f.startsWith('city_'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'cram', f), 'utf8'));
  const arr = Array.isArray(d) ? d : (d.data || Object.values(d)[0] || []);
  for (const r of arr) {
    nAll++;
    if (!CATS.test(r['短期補習班類別'] || '')) continue;
    nCat++;
    let tc = String(r['地址-行政區域代碼'] || '');
    let county = normTW((r['地區縣市'] || '').replace(/政府$/, ''));
    if (!atlas.has(tc)) {
      // 舊代碼修正：地址開頭或縣市+地址前綴找區名
      const addr = normTW(r['地址'] || '');
      const m = addr.replace(county, '').match(/^(.{1,4}?(?:區|鄉|鎮|市))/);
      const fixed = m ? byName.get(county + '|' + m[1]) : null;
      if (fixed) { tc = fixed; nFixed++; }
      else { nBad++; continue; }
    }
    const a = atlas.get(tc);
    if (countyFilter && a.county !== countyFilter) continue;
    out.push({
      name: r['短期補習班名稱'],
      cat: /外語/.test(r['短期補習班類別']) ? '外語' : '文理',
      addr: r['地址'],
      towncode: tc, county: a.county, town: a.town,
    });
  }
}
fs.writeFileSync(path.join(dataDir, 'cram_stage1.json'), JSON.stringify(out));
console.log(`全部 ${nAll}，文理/外語 ${nCat}，代碼修正 ${nFixed}，捨棄 ${nBad}`);
console.log(`輸出 ${out.length} 筆${countyFilter ? '（' + countyFilter + '）' : ''} → data/cram_stage1.json`);
