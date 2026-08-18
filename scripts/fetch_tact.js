// 台灣拓人個別指導（TACT）官網教室 → data/tact_raw.csv
// 兩步：POST /token/ 取 CSRF → POST /locationSyn/ (action=showStoreData) 取表格 HTML
// 每校主列 <tr>：td0=區域, td1=校名, .add>span=地址；<tr class="mb"> 為手機明細列略過。
// 欄位：name,county,district,address,phone（欄內逗號去除）
const fs = require('fs');
const path = require('path');
const base = 'https://www.tact.com.tw';
const H = { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': base + '/location/', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const norm = s => (s || '').replace(/臺/g, '台');
(async () => {
  const t = await fetch(base + '/token/', { method: 'POST', headers: H, body: new URLSearchParams({ type: '_token' }) });
  const cookies = (t.headers.getSetCookie ? t.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const tj = await t.json();
  const r = await fetch(base + '/locationSyn/', { method: 'POST', headers: { ...H, Cookie: cookies }, body: new URLSearchParams({ action: 'showStoreData', locationId: '0', location_search: '', csrf_name: tj.csrf_name, csrf_value: tj.csrf_value }) });
  const html = (await r.json()).dataContent || '';
  const segs = html.split('<tr').slice(1);
  const rows = [], seen = new Set();
  for (const seg of segs) {
    if (seg.startsWith(' class="mb"')) continue;                 // 手機明細列
    const tds = [...seg.matchAll(/<td>([^<]*)<\/td>/g)].map(m => m[1].trim());
    const district = norm(tds[0] || '');
    const name = norm(tds[1] || '');
    const addr = norm((seg.match(/class="add"[^>]*>\s*<span>\s*([^<]+?)\s*<\/span>/) || [])[1] || '').replace(/\s/g, '').replace(/,/g, '');
    const phone = ((seg.match(/tel:([^"]+)"/) || [])[1] || '').replace(/,/g, '');
    if (!name || !addr) continue;
    const key = name + '|' + addr;
    if (seen.has(key)) continue; seen.add(key);
    const county = (addr.match(/^(.{2,3}?[縣市])/) || [])[1] || '';
    rows.push({ name, county, district, address: addr, phone });
  }
  const header = 'name,county,district,address,phone';
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'tact_raw.csv'),
    header + '\n' + rows.map(r => [r.name, r.county, r.district, r.address, r.phone].join(',')).join('\n') + '\n');
  console.log(`完成：${rows.length} 校 → data/tact_raw.csv`);
  const byC = {}; rows.forEach(r => byC[r.county] = (byC[r.county] || 0) + 1);
  console.log('各縣市:', Object.entries(byC).sort((a, b) => b[1] - a[1]).map(([c, n]) => c + n).join('  '));
  console.log('前 8 校:'); rows.slice(0, 8).forEach(r => console.log('  ' + r.name + ' | ' + r.address));
})();
