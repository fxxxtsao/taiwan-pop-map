// 找出「座標疊點」的幼兒園（≥2 間共用同一座標，多為當初免費編碼失敗退回鄉鎮中心者），
// 併回教保網真實地址，輸出 data/kinder_regeocode.json，供日後門牌級 Google 重新編碼直接處理。
// 輸出每筆：{name, county, town, address, capacity, curLat, curLon, curSrc, stackKey, stackSize, hasAddr}
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, '..', 'data');
const norm = s => (s || '').replace(/臺/g, '台');
function nn(n) {
  return norm(n).replace(/(財團法人|學校財團法人|社團法人|股份有限公司|有限公司)/g, '')
    .replace(/[\s（）()、,，.．]/g, '').replace(/私立|市立|縣立|國立|公立/g, '');
}
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'schools.json'), 'utf8'));
const kin = sc.kinder; // [name, lat, lon, type, county, town, src, capacity]

// 1. 找疊點群（座標取 5 位小數）
const byXY = {};
for (const r of kin) { const k = r[1].toFixed(5) + ',' + r[2].toFixed(5); (byXY[k] = byXY[k] || []).push(r); }
const stackKeys = new Set(Object.entries(byXY).filter(([, v]) => v.length > 1).map(([k]) => k));

// 2. 教保網真實地址索引：county+town+nn(title) / +norm(title)
const ece = JSON.parse(fs.readFileSync(path.join(dataDir, 'ece_preschools.json'), 'utf8')).features
  .map(f => f.properties).filter(p => p.is_active === 1);
const addrBy = new Map();
for (const p of ece) {
  const base = norm(p.city) + norm(p.town);
  const addr = norm(p.address || '').replace(/^\[[0-9]+\]/, '').replace(/\s/g, '');
  addrBy.set(base + norm(p.title), addr);
  addrBy.set(base + nn(p.title), addr);
}

// 3. 組輸出
const out = [];
let withAddr = 0;
for (const r of kin) {
  const xy = r[1].toFixed(5) + ',' + r[2].toFixed(5);
  if (!stackKeys.has(xy)) continue;
  const base = norm(r[4]) + norm(r[5]);
  const addr = addrBy.get(base + norm(r[0])) || addrBy.get(base + nn(r[0])) || '';
  if (addr) withAddr++;
  out.push({
    name: r[0], county: r[4], town: r[5], address: addr,
    capacity: r[7], curLat: r[1], curLon: r[2], curSrc: r[6],
    stackKey: xy, stackSize: byXY[xy].length, hasAddr: !!addr,
  });
}
out.sort((a, b) => b.stackSize - a.stackSize || a.stackKey.localeCompare(b.stackKey));
const payload = {
  generated: new Date().toISOString().slice(0, 10),
  note: '幼兒園座標疊點清單（需門牌級重編碼）。address 取自教保網 is_active=1。下次可讀此檔逐筆 Google 門牌級編碼→落區驗證→回寫 web/schools.json 對應園名座標。',
  total: out.length, withAddress: withAddr, stacks: stackKeys.size,
  rows: out,
};
fs.writeFileSync(path.join(dataDir, 'kinder_regeocode.json'), JSON.stringify(payload, null, 0));
console.log(`疊點幼兒園 ${out.length} 間、疊點群 ${stackKeys.size} 個、有真實地址 ${withAddr}/${out.length} → data/kinder_regeocode.json`);
console.log('無地址的（需人工補）:', out.filter(o => !o.hasAddr).length);
