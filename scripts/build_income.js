// 財政部綜稅所得總額村里統計分析表 → web/income_villages.json + web/income.json
// 輸入: data/income/111_{A..Z}.csv（縣市別, 村里, 納稅單位, 所得總額(千元), 平均數, 中位數, Q1, Q3, 標準差, 變異係數）
// 比對: villages-10t.json 的 COUNTYNAME+TOWNNAME+VILLNAME → VILLCODE
const fs = require('fs');
const path = require('path');

const YEAR = 111;
const dataDir = path.join(__dirname, '..', 'data');
const incomeDir = path.join(dataDir, 'income');

const norm = s => (s || '').replace(/\s/g, '').replace(/臺/g, '台');

// ---- 村里界索引: 縣市+鄉鎮+村里 -> VILLCODE ----
const topo = JSON.parse(fs.readFileSync(path.join(dataDir, 'villages-10t.json'), 'utf8'));
const villIdx = new Map();
const byTown = new Map(); // 縣市+鄉鎮 -> [{name, code}]（罕見字備援比對用）
const dupKeys = new Set();
for (const g of topo.objects.villages.geometries) {
  const p = g.properties;
  if (!p.VILLNAME) continue;
  const tKey = norm(p.COUNTYNAME) + norm(p.TOWNNAME);
  const key = tKey + '|' + norm(p.VILLNAME);
  if (villIdx.has(key)) dupKeys.add(key); // 同鄉鎮同名村里（理論上不存在）
  villIdx.set(key, p.VILLCODE);
  if (!byTown.has(tKey)) byTown.set(tKey, []);
  byTown.get(tKey).push({ name: norm(p.VILLNAME), code: p.VILLCODE });
}

// 罕見字/異體字備援：同鄉鎮內找同長度、僅一字之差且未被占用的村里
function fuzzyMatch(tKey, vname, used) {
  const a = [...vname]; // code point 陣列（罕見字為 surrogate pair，不能用字串索引）
  const cands = (byTown.get(tKey) || []).filter(v => {
    if (used.has(v.code)) return false;
    const b = [...v.name];
    return b.length === a.length && b.filter((c, i) => c !== a[i]).length === 1;
  });
  return cands.length === 1 ? cands[0].code : null;
}

// ---- 解析 CSV（欄位皆有引號包裹）----
function parseCsv(txt) {
  return txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim()).map(line =>
    (line.match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)));
}

const villages = {}; // VILLCODE -> [納稅單位, 平均, 中位, q1, q3]
const townAgg = {};  // TOWNCODE -> { units, total, meds: [[median, units]...] }
let nRows = 0, nSkip = 0, nFuzzy = 0, unmatched = [];
const pending = []; // 第一輪沒對上的，等精確比對完再做模糊比對（避免占用他人代碼）

for (const f of fs.readdirSync(incomeDir).filter(f => f.startsWith(YEAR + '_'))) {
  const rows = parseCsv(fs.readFileSync(path.join(incomeDir, f), 'utf8')).slice(1);
  for (const r of rows) {
    if (r.length < 8) continue;
    const [ct, vill, units, total, avg, med, q1, q3] = r;
    if (/合計|其他|總計/.test(vill)) { nSkip++; continue; }
    nRows++;
    const key = norm(ct) + '|' + norm(vill);
    let code = villIdx.get(key);
    if (!code) { pending.push(r); continue; }
    villages[code] = [+units, +avg, +med, +q1, +q3];
    const tc = code.slice(0, 8);
    if (!townAgg[tc]) townAgg[tc] = { units: 0, total: 0, meds: [] };
    townAgg[tc].units += +units;
    townAgg[tc].total += +total;
    townAgg[tc].meds.push([+med, +units]);
  }
}

// 第二輪：模糊比對
const used = new Set(Object.keys(villages));
for (const r of pending) {
  const [ct, vill, units, total, avg, med, q1, q3] = r;
  const code = fuzzyMatch(norm(ct), norm(vill), used);
  if (!code) { unmatched.push(ct + vill); continue; }
  nFuzzy++;
  used.add(code);
  villages[code] = [+units, +avg, +med, +q1, +q3];
  const tc = code.slice(0, 8);
  if (!townAgg[tc]) townAgg[tc] = { units: 0, total: 0, meds: [] };
  townAgg[tc].units += +units;
  townAgg[tc].total += +total;
  townAgg[tc].meds.push([+med, +units]);
}

// ---- 鄉鎮層：平均=Σ總額/Σ戶數；中位數=村里中位數的戶數加權中位 ----
const towns = {};
for (const [tc, a] of Object.entries(townAgg)) {
  a.meds.sort((x, y) => x[0] - y[0]);
  let acc = 0, wmed = a.meds[a.meds.length - 1][0];
  for (const [m, u] of a.meds) { acc += u; if (acc >= a.units / 2) { wmed = m; break; } }
  towns[tc] = [a.units, Math.round(a.total / a.units), wmed];
}

const src = '財政部財政資訊中心 綜稅所得總額各縣市鄉鎮村里統計分析表';
fs.writeFileSync(path.join(__dirname, '..', 'web', 'income_villages.json'),
  JSON.stringify({ source: src, year: YEAR, unit: '千元', villages }));
fs.writeFileSync(path.join(__dirname, '..', 'web', 'income.json'),
  JSON.stringify({ source: src, year: YEAR, unit: '千元', towns }));

const vSize = fs.statSync(path.join(__dirname, '..', 'web', 'income_villages.json')).size;
console.log(`rows=${nRows} skip(合計/其他)=${nSkip} fuzzy=${nFuzzy}`);
console.log(`matched villages=${Object.keys(villages).length} (${(100 * Object.keys(villages).length / nRows).toFixed(1)}%), towns=${Object.keys(towns).length}`);
console.log(`unmatched=${unmatched.length}`, unmatched.slice(0, 15));
console.log(`dup village keys in atlas: ${dupKeys.size}`);
console.log(`income_villages.json ${(vSize / 1024).toFixed(0)}KB`);
