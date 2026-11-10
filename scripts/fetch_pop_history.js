// 抓取戶政司 ODRP014 歷年人口快照，產出與 web/ 同格式的封存檔
// 用法: node scripts/fetch_pop_history.js [yyymm ...]
//       預設 11012 11112 11212 11312 11412（近五年各年 12 月）
// 輸出: data/pop_history/population_{yyymm}.json          （鄉鎮，同 web/population.json 格式）
//       data/pop_history/population_villages_{yyymm}.json （村里，同 web/population_villages.json 格式）
// 不會動到 web/ 的現行資料。原始分頁約 38MB/期、可隨時重抓，彙總完即刪。
// 已產出的期間會跳過，中斷可直接重跑。
const fs = require('fs');
const path = require('path');

const PERIODS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['11012', '11112', '11212', '11312', '11412'];
const outDir = path.join(__dirname, '..', 'data', 'pop_history');
const rawDir = path.join(outDir, 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const api = (period, page) =>
  `https://www.ris.gov.tw/rs-opendata/api/v1/datastore/ODRP014/${period}?PAGE=${page}`;

// Node fetch 遇 ECONNRESET 會拋例外，必須自己退避重試（見 skill）
async function getPage(period, page) {
  const file = path.join(rawDir, `${period}_p${page}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 壞檔，重抓 */ }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(api(period, page));
      const txt = await res.text();
      const j = JSON.parse(txt);
      if (!j.responseData) throw new Error(j.responseMessage || '無 responseData');
      fs.writeFileSync(file, txt);
      return j;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${period} p${page} 抓取失敗: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

(async () => {
  for (const period of PERIODS) {
    const outT = path.join(outDir, `population_${period}.json`);
    const outV = path.join(outDir, `population_villages_${period}.json`);
    if (fs.existsSync(outT) && fs.existsSync(outV)) {
      console.log(`${period}: 已存在，跳過`);
      continue;
    }
    const towns = {}, villages = {};
    let rows = 0, yyymm = null;
    for (let p = 1; p <= 4; p++) {
      const d = await getPage(period, p);
      for (const r of d.responseData) {
        yyymm = r.statistic_yyymm;
        const ages = new Array(101).fill(0);
        for (let a = 0; a <= 99; a++) {
          const k = String(a).padStart(3, '0');
          ages[a] = (+r[`people_age_${k}_m`] || 0) + (+r[`people_age_${k}_f`] || 0);
        }
        ages[100] = (+r.people_age_100up_m || 0) + (+r.people_age_100up_f || 0); // 100歲以上
        villages[r.district_code] = { n: r.village, t: +r.people_total, a: ages };

        const code = r.district_code.slice(0, 8); // 前 8 碼 = TOWNCODE
        if (!towns[code]) towns[code] = { name: r.site_id, total: 0, ages: new Array(101).fill(0) };
        towns[code].total += +r.people_total;
        for (let a = 0; a <= 100; a++) towns[code].ages[a] += ages[a];
        rows++;
      }
    }
    const source = '內政部戶政司 ODRP014';
    fs.writeFileSync(outT, JSON.stringify({ source, period: yyymm, towns }));
    fs.writeFileSync(outV, JSON.stringify({ source, period: yyymm, villages }));
    for (let p = 1; p <= 4; p++) {
      const f = path.join(rawDir, `${period}_p${p}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log(`${period}: rows=${rows} towns=${Object.keys(towns).length} villages=${Object.keys(villages).length}`);
  }
  console.log('封存目錄:', outDir);
})();
