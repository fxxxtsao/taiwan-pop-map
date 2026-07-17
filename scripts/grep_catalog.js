// 在 data.gov.tw 資料集清單中篩選符合條件的資料集
const fs = require('fs');
const path = require('path');
const pat = new RegExp(process.argv[2]);
const txt = fs.readFileSync(path.join(__dirname, '..', 'data', 'catalog.csv'), 'utf8');
// 簡易 CSV 解析（欄位皆有引號包裹）
const lines = txt.split(/\r?\n/);
let n = 0;
for (let i = 1; i < lines.length && n < 40; i++) {
  const cols = lines[i].match(/"([^"]*)"/g);
  if (!cols || cols.length < 9) continue;
  const c = cols.map(s => s.slice(1, -1));
  const [id, name, , fmt, url, , desc, fields, agency] = c;
  if (pat.test(name) || pat.test(desc)) {
    console.log(`${id} | ${name} | ${agency} | ${fmt}`);
    console.log(`   ${url.slice(0, 160)}`);
    n++;
  }
}
console.log('matches shown:', n);
