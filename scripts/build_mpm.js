// data/mpm_raw.csv → data/mpm_stage.json
// 欄位：name,county,district,address,phone,elem,jhs。key=county+name（唯一，同名分校分屬不同縣市）。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'data', 'mpm_raw.csv'), 'utf8').split(/\r?\n/).filter(l => l.trim());
lines.shift(); // 表頭
const out = [];
const seen = new Set();
let dup = 0;
for (const line of lines) {
  const c = line.split(',');
  const name = c[0], county = c[1], district = c[2], addr = c[3];
  if (!addr) continue;
  const key = county + name;
  if (seen.has(key)) { dup++; continue; }
  seen.add(key);
  out.push({ key, name, addr, county, town: district });
}
fs.writeFileSync(path.join(root, 'data', 'mpm_stage.json'), JSON.stringify(out));
console.log(`mpm_stage: ${out.length} 筆（去重 ${dup}）`);
