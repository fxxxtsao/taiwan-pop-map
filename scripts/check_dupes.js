// 檢查同名學校的規模與座標共用問題
const fs = require('fs');
const path = require('path');
const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'schools.json'), 'utf8'));
const stage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'schools_stage1.json'), 'utf8'));

const norm = x => (x || '').replace(/臺/g, '台').replace(/國民小學/g, '國小').replace(/\s/g, '');

function report(label, list, nameFn, countyFn, townFn) {
  const byCounty = {}, byTown = {};
  for (const r of list) {
    const n = norm(nameFn(r));
    const kc = countyFn(r) + '|' + n;
    const kt = countyFn(r) + townFn(r) + '|' + n;
    (byCounty[kc] = byCounty[kc] || []).push(r);
    (byTown[kt] = byTown[kt] || []).push(r);
  }
  const dupC = Object.values(byCounty).filter(a => a.length > 1);
  const dupT = Object.values(byTown).filter(a => a.length > 1);
  console.log(`${label}: 同縣市同名 ${dupC.length} 組(${dupC.reduce((a, b) => a + b.length, 0)} 校), 同鄉鎮同名 ${dupT.length} 組`);
  return { dupC, dupT };
}

// 名錄層面 (stage1)
const e = report('國小(名錄)', stage.elems, r => r.name, r => r.county, r => r.town || '');
const k = report('幼兒園(名錄)', stage.kinders, r => r.name, r => r.county, r => r.town || '');
console.log('--- 國小同縣市同名範例:');
for (const g of e.dupC.slice(0, 6)) console.log('  ', g.map(r => r.county + (r.town || '') + ' ' + r.name).join(' / '));

// 匯出層面: 同名且座標完全相同 (代表共用了同一個比對點)
function sharedCoord(rows, label) {
  const by = {};
  for (const r of rows) {
    const key = r[4] + '|' + norm(r[0]) + '|' + r[1] + ',' + r[2];
    (by[key] = by[key] || []).push(r);
  }
  const dup = Object.values(by).filter(a => a.length > 1);
  console.log(`${label}: 同縣市同名且同座標 ${dup.length} 組(${dup.reduce((a, b) => a + b.length, 0)} 筆)`);
  for (const g of dup.slice(0, 8)) console.log('  ', g[0][4], g[0][0], '@', g[0][1] + ',' + g[0][2], 'x' + g.length, '(' + g.map(x => x[5]).join('/') + ')', 'src=' + g.map(x => x[6]).join('/'));
  return dup;
}
sharedCoord(s.elem, '國小(匯出)');
sharedCoord(s.kinder, '幼兒園(匯出)');
