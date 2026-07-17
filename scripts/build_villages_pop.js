// 產出村里級人口資料 web/population_villages.json
// 鍵為 11 碼村里代碼，n=村里名 t=總人口 a=單齡陣列(0..100)
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const villages = {};
let yyymm = null;

for (let p = 1; p <= 4; p++) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, `p${p}.json`), 'utf8'));
  for (const r of d.responseData) {
    yyymm = r.statistic_yyymm;
    const ages = new Array(101).fill(0);
    for (let a = 0; a <= 99; a++) {
      const k = String(a).padStart(3, '0');
      ages[a] = (+r[`people_age_${k}_m`] || 0) + (+r[`people_age_${k}_f`] || 0);
    }
    ages[100] = (+r.people_age_100up_m || 0) + (+r.people_age_100up_f || 0);
    villages[r.district_code] = { n: r.village, t: +r.people_total, a: ages };
  }
}

const out = { source: '內政部戶政司 ODRP014', period: yyymm, villages };
const file = path.join(__dirname, '..', 'web', 'population_villages.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`villages=${Object.keys(villages).length} period=${yyymm} size=${(fs.statSync(file).size / 1048576).toFixed(1)}MB`);
