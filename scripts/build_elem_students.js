// 國小校別在學學生數 → data/elem_students.json
// 來源：教育部統計處「國民小學校別資料」 stats.moe.gov.tw/files/detail/{學年}/{學年}_basec.csv
// 學生數 = 各年級男女學生數加總；班級數 = 各年級班級數加總。以「學校代碼」為鍵，對得上 schools_stage1.elems。
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const YEAR = 114;
const raw = fs.readFileSync(path.join(dataDir, `${YEAR}_basec.csv`), 'utf8').replace(/^﻿/, '');
const lines = raw.split(/\r?\n/).filter(l => l.trim());
const header = lines.shift().split(',');
// 欄位定位（避免硬編索引隨年份位移）
const iCode = header.indexOf('學校代碼');
const iName = header.indexOf('學校名稱');
const clsIdx = header.map((h, i) => /年級班級數$/.test(h) ? i : -1).filter(i => i >= 0);
const stuIdx = header.map((h, i) => /年級[男女]學生數$/.test(h) ? i : -1).filter(i => i >= 0);

const out = {};
for (const line of lines) {
  const c = line.split(',');
  const code = c[iCode];
  if (!code) continue;
  const students = stuIdx.reduce((s, i) => s + (+c[i] || 0), 0);
  const classes = clsIdx.reduce((s, i) => s + (+c[i] || 0), 0);
  out[code] = { name: c[iName], students, classes };
}
fs.writeFileSync(path.join(dataDir, 'elem_students.json'), JSON.stringify(out));

// 與現有國小點位對照（by code）
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'schools_stage1.json'), 'utf8'));
const elems = stage.elems;
let matched = 0, unmatched = [];
for (const e of elems) (out[e.code] ? matched++ : unmatched.push(e.code + ' ' + e.name));
const vals = Object.values(out).map(o => o.students);
vals.sort((a, b) => a - b);
const q = p => vals[Math.floor((vals.length - 1) * p)];
console.log(`basec ${YEAR}: ${Object.keys(out).length} 校`);
console.log(`點位比對: ${matched}/${elems.length} 對上（by 學校代碼），未對上 ${unmatched.length}`);
console.log(`學生數分布: min ${vals[0]}, 中位 ${q(0.5)}, 平均 ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}, 90% ${q(0.9)}, max ${vals[vals.length - 1]}`);
if (unmatched.length) console.log('未對上前10:', unmatched.slice(0, 10).join(' / '));
