// KUMON_classroom.csv → data/kumon_stage.json
// 去重（同名保留一筆）、濾掉無地址的「專案」列。欄位：center_name,address,city,district
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const csv = fs.readFileSync(path.join(root, 'KUMON_classroom.csv'), 'utf8');
const lines = csv.split(/\r?\n/).filter(l => l.trim());
lines.shift(); // 表頭

const seen = new Set();
const out = [];
let skipNull = 0, dup = 0;
for (const line of lines) {
  const c = line.split(',');
  const name = c[1], addr = c[4], city = c[5], district = c[6];
  if (!addr || addr === '[NULL]') { skipNull++; continue; } // 專案列無地址
  if (seen.has(name)) { dup++; continue; }
  seen.add(name);
  out.push({ name, addr, county: city, town: district });
}
fs.writeFileSync(path.join(root, 'data', 'kumon_stage.json'), JSON.stringify(out));
console.log(`kumon_stage: ${out.length} 筆（去重 ${dup}, 無地址略過 ${skipNull}）`);
