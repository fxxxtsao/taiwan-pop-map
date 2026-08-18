// MPM 官網教室據點 → data/mpm_raw.csv
// 端點：/wp-content/themes/Avada-Child-Theme/myCode/LearningCenter.php
//   act=getClassroomsArea → 有教室的 縣市+區 清單
//   act=getschoolDataAndMark (County,City=區) → 該區教室 HTML 表格
// 欄位：name,county,district,address,phone,elem,jhs（欄內逗號去除）
const fs = require('fs');
const path = require('path');
const URL_EP = 'https://www.mpmmath.com.tw/wp-content/themes/Avada-Child-Theme/myCode/LearningCenter.php';
const H = { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.mpmmath.com.tw/index.php/learningcenter/', 'X-Requested-With': 'XMLHttpRequest' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '').replace(/臺/g, '台');
const clean = s => norm(s).replace(/\s+/g, ' ').trim().replace(/,/g, '');       // 一般欄位
const cleanAddr = s => norm(s).replace(/\s+/g, '').replace(/,/g, '');            // 地址去所有空白

async function post(body) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(URL_EP, { method: 'POST', headers: H, body: new URLSearchParams(body) }); return await r.json(); }
    catch (e) { console.error('retry', body.City || '', e.message); await sleep(3000); }
  }
  return null;
}
function parseRows(html) {
  const out = [];
  const trs = (html || '').split('<tr>').slice(1); // 首段是 thead 之前
  for (const tr of trs) {
    const name = (tr.match(/data-label="分校名稱">([^<]*)</) || [])[1];
    const addr = (tr.match(/data-label="地址">([^<]*)</) || [])[1];
    if (!name || !addr) continue;
    const phone = (tr.match(/data-label="電話">([^<]*)</) || [])[1] || '';
    const elemCell = (tr.match(/data-label="國小"[\s\S]*?<\/td>/) || [''])[0];
    const jhsCell = (tr.match(/data-label="國中"[\s\S]*?<\/td>/) || [''])[0];
    out.push({
      name: clean(name), address: cleanAddr(addr), phone: clean(phone),
      elem: /fa-check/.test(elemCell) ? 1 : 0, jhs: /fa-check/.test(jhsCell) ? 1 : 0,
    });
  }
  return out;
}
(async () => {
  const areaResp = await post({ act: 'getClassroomsArea' });
  const areas = areaResp.info.data.rsData;
  console.log('查詢區數:', areas.length);
  const seen = new Set(), rows = [];
  let n = 0;
  for (const a of areas) {
    n++;
    const j = await post({ County: a.County, City: a.City, act: 'getschoolDataAndMark' });
    const parsed = parseRows(j && j.info && j.info.htmlStr);
    for (const r of parsed) {
      const key = r.name + '|' + r.address;
      if (seen.has(key)) continue;
      seen.add(key);
      // county/district：以地址前綴為準，取查詢組合為輔
      rows.push({ ...r, county: norm(a.County), district: norm(a.City) });
    }
    if (n % 30 === 0) console.log(`  ${n}/${areas.length}  累計 ${rows.length} 校`);
    await sleep(250);
  }
  const header = 'name,county,district,address,phone,elem,jhs';
  const body = rows.map(r => [r.name, r.county, r.district, r.address, r.phone, r.elem, r.jhs].join(','));
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'mpm_raw.csv'), header + '\n' + body.join('\n') + '\n');
  console.log(`\n完成：${rows.length} 校 → data/mpm_raw.csv`);
})();
