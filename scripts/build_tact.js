// data/tact_raw.csv → data/tact_stage.json
// 欄位：name,county,district,address,phone。key=county+name（唯一）。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'data', 'tact_raw.csv'), 'utf8').split(/\r?\n/).filter(l => l.trim());
lines.shift();
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
fs.writeFileSync(path.join(root, 'data', 'tact_stage.json'), JSON.stringify(out));
console.log(`tact_stage: ${out.length} 筆（去重 ${dup}）`);
