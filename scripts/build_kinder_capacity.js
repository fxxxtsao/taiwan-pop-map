// 幼兒園核定招收人數 → data/kinder_capacity.json
// 來源：g0v 台灣幼兒園地圖（爬教育部全國教保資訊網）kiang.github.io/ap.ece.moe.edu.tw/preschools.json
// 全國逐園 count_approved（核定名額）。教保網用 reg_no/id、無教育部學校代碼，故與現有點位以「縣市+正規化園名」比對。
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const src = JSON.parse(fs.readFileSync(path.join(dataDir, 'ece_preschools.json'), 'utf8'));
const feats = src.features || src;

const norm = s => (s || '').replace(/臺/g, '台');
// 正規化園名：去法人前綴、公私立、空白標點，利於跨資料源比對
function normName(n) {
  return norm(n)
    .replace(/(財團法人|學校財團法人|社團法人|股份有限公司|有限公司)/g, '')
    .replace(/[\s（）()、,，.．]/g, '')
    .replace(/^[^市縣]*[市縣]/, '') // 去開頭縣市名
    .replace(/私立|市立|縣立|國立|公立/g, '');
}

const out = [];
for (const f of feats) {
  const p = f.properties || f;
  const cap = parseInt((p.count_approved || '').toString().replace(/,/g, ''), 10) || 0;
  out.push({
    id: p.id, name: norm(p.title), county: norm(p.city), town: norm(p.town),
    type: p.type, capacity: cap, active: p.is_active === 1 || p.is_active === '1',
  });
}
fs.writeFileSync(path.join(dataDir, 'kinder_capacity.json'), JSON.stringify(out));

// 分布（僅計 capacity>0 的營運中園）
const act = out.filter(o => o.active && o.capacity > 0).map(o => o.capacity).sort((a, b) => a - b);
const q = pp => act[Math.floor((act.length - 1) * pp)];
console.log(`ece 幼兒園 ${out.length} 園（營運中且有核定數 ${act.length}）`);
console.log(`核定人數分布: min ${act[0]}, 中位 ${q(0.5)}, 平均 ${Math.round(act.reduce((a, b) => a + b, 0) / act.length)}, 90% ${q(0.9)}, max ${act[act.length - 1]}`);

// 與現有幼兒園點位比對（縣市內正規化園名相等或互為子字串）
const stage = JSON.parse(fs.readFileSync(path.join(dataDir, 'schools_stage1.json'), 'utf8'));
const kinders = stage.kinders;
const idx = new Map(); // county -> [{nn, o}]
for (const o of out) { const k = o.county; if (!idx.has(k)) idx.set(k, []); idx.get(k).push({ nn: normName(o.name), o }); }
let matched = 0; const miss = [];
for (const kd of kinders) {
  const cand = idx.get(norm(kd.county)) || [];
  const nn = normName(kd.name);
  const hit = cand.find(c => c.nn === nn) || cand.find(c => c.nn && (c.nn.includes(nn) || nn.includes(c.nn)));
  if (hit) matched++; else miss.push(kd.name);
}
console.log(`點位比對: ${matched}/${kinders.length} 對上（縣市+正規化園名）`);
if (miss.length) console.log('未對上前8:', miss.slice(0, 8).join(' / '));
