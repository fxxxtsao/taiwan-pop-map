// data/meiko_raw.csv → data/meiko_stage.json
// 欄位：code,name,county,address（地址無逗號，直接 split）。去重（同名保留一筆）。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const csv = fs.readFileSync(path.join(root, 'data', 'meiko_raw.csv'), 'utf8');
const lines = csv.split(/\r?\n/).filter(l => l.trim());
lines.shift(); // 表頭
const seen = new Set();
const out = [];
let dup = 0;
for (const line of lines) {
  const c = line.split(',');
  const code = c[0], name = c[1], county = c[2], addr = c[3];
  if (!addr) continue;
  if (seen.has(name)) { dup++; continue; }
  seen.add(name);
  out.push({ code, name, addr, county });
}
fs.writeFileSync(path.join(root, 'data', 'meiko_stage.json'), JSON.stringify(out));
console.log(`meiko_stage: ${out.length} 筆（去重 ${dup}）`);
