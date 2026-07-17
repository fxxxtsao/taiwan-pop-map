// 將戶政司 ODRP014 (村里單一年齡人口) 聚合為鄉鎮市區層級
// 輸入: data/p1.json ~ p4.json  輸出: web/population.json
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const towns = {}; // towncode(8碼) -> { name, county, total, ages: [0..100] }
let yyymm = null;
let rows = 0;

for (let p = 1; p <= 4; p++) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, `p${p}.json`), 'utf8'));
  for (const r of d.responseData) {
    yyymm = r.statistic_yyymm;
    const code = r.district_code.slice(0, 8);
    if (!towns[code]) {
      towns[code] = { name: r.site_id, total: 0, ages: new Array(101).fill(0) };
    }
    const t = towns[code];
    t.total += +r.people_total;
    for (let a = 0; a <= 99; a++) {
      const k = String(a).padStart(3, '0');
      t.ages[a] += (+r[`people_age_${k}_m`] || 0) + (+r[`people_age_${k}_f`] || 0);
    }
    t.ages[100] += (+r.people_age_100up_m || 0) + (+r.people_age_100up_f || 0); // 100歲以上

    rows++;
  }
}

const out = { source: '內政部戶政司 ODRP014', period: yyymm, towns };
fs.writeFileSync(path.join(__dirname, '..', 'web', 'population.json'), JSON.stringify(out));
console.log(`rows=${rows} towns=${Object.keys(towns).length} period=${yyymm}`);

// 與 taiwan-atlas TOWNCODE 比對
const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'towns-10t.json'), 'utf8'));
const atlasCodes = new Set(topo.objects.towns.geometries.map(g => g.properties.TOWNCODE));
const popCodes = new Set(Object.keys(towns));
const missInPop = [...atlasCodes].filter(c => !popCodes.has(c));
const missInAtlas = [...popCodes].filter(c => !atlasCodes.has(c));
console.log('atlas towns without pop:', missInPop.length, missInPop.slice(0, 10));
console.log('pop towns without atlas:', missInAtlas.length, missInAtlas.map(c => c + ' ' + towns[c].name).slice(0, 10));
