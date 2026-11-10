// 近五年人口成長率：由 data/pop_history/ 歷年封存 + web/population*.json 現行資料算出
//   → web/pop_growth.json（鄉鎮 + 村里，總人口與學齡 3-12 兩種指標）
// 只讀不覆蓋既有資料檔；輸出僅 web/pop_growth.json。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HIST = path.join(ROOT, 'data', 'pop_history');
const WEB = path.join(ROOT, 'web');

const PERIODS = ['11012', '11112', '11212', '11312', '11412']; // 各年 12 月
const rj = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sumBand = (a, lo, hi) => { let s = 0; for (let i = lo; i <= hi; i++) s += a[i]; return s; };

// ---- 載入各期（歷年封存 + 現行最新一期） ----
const townSeries = [];   // [{period, towns:{code:{name,total,school}}}]
const villSeries = [];
for (const p of PERIODS) {
  townSeries.push({ period: p, src: rj(path.join(HIST, `population_${p}.json`)) });
  villSeries.push({ period: p, src: rj(path.join(HIST, `population_villages_${p}.json`)) });
}
const curT = rj(path.join(WEB, 'population.json'));
const curV = rj(path.join(WEB, 'population_villages.json'));
townSeries.push({ period: curT.period, src: curT });
villSeries.push({ period: curV.period, src: curV });

const periods = townSeries.map(s => s.period);
if (curV.period !== curT.period)
  throw new Error(`鄉鎮與村里現行期別不一致：${curT.period} vs ${curV.period}`);

// ---- 期別轉小數年，用來年化 ----
const toYear = p => Number(p.slice(0, 3)) + 1911 + (Number(p.slice(3)) - 0.5) / 12;
const span = toYear(periods[periods.length - 1]) - toYear(periods[0]);

// ---- 逐層彙總 ----
function build(series, pick) {
  const out = new Map(); // code -> {name, series:[{total,school}|null]}
  series.forEach((s, i) => {
    for (const [code, v] of Object.entries(pick.entries(s.src))) {
      let r = out.get(code);
      if (!r) { r = { name: pick.name(v, code), series: new Array(series.length).fill(null) }; out.set(code, r); }
      if (pick.name(v, code)) r.name = pick.name(v, code); // 以最新一期名稱為準
      r.series[i] = { total: pick.total(v), school: sumBand(pick.ages(v), 3, 12) };
    }
  });
  return out;
}
const townsM = build(townSeries, {
  entries: d => d.towns, name: v => v.name, total: v => v.total, ages: v => v.ages,
});
const villsM = build(villSeries, {
  entries: d => d.villages, name: v => v.n, total: v => v.t, ages: v => v.a,
});

// ---- 成長率 ----
function rows(m, nameOf) {
  const full = [], partial = [];
  for (const [code, r] of m) {
    const base = r.series[0], last = r.series[r.series.length - 1];
    const rec = { code, name: nameOf(code, r) };
    if (!base || !last) { partial.push({ ...rec, reason: !base ? 'no-base' : 'no-latest' }); continue; }
    const g = (b, l) => (b > 0 ? (l - b) / b : null);
    const cagr = (b, l) => (b > 0 && l > 0 ? Math.pow(l / b, 1 / span) - 1 : null);
    full.push({
      ...rec,
      base: base.total, last: last.total,
      growth: g(base.total, last.total), cagr: cagr(base.total, last.total),
      sBase: base.school, sLast: last.school,
      sGrowth: g(base.school, last.school), sCagr: cagr(base.school, last.school),
      hist: r.series.map(x => (x ? x.total : null)),
      sHist: r.series.map(x => (x ? x.school : null)),
    });
  }
  return { full, partial };
}
const T = rows(townsM, (_c, r) => r.name);
// 村里名要帶縣市鄉鎮，前 8 碼 = TOWNCODE
const townFull = code => (curT.towns[code] && curT.towns[code].name) || code;
const V = rows(villsM, (c, r) => townFull(c.slice(0, 8)) + r.name);
// 村里另記所屬縣市，供前端依縣市縮放榜單（縣市名為 towns name 的前綴，3 字或 2 字）
const CTY_RE = /^(.{2,3}?[市縣])/;
for (const r of V.full) { const m = CTY_RE.exec(r.name); r.cty = m ? m[1] : ''; }

// ---- 門檻：小母數的百分比沒有決策意義，另設基期下限 ----
const MIN_TOWN = 5000, MIN_VILL = 1000;
const MIN_TOWN_S = Math.round(MIN_TOWN / 8), MIN_VILL_S = Math.round(MIN_VILL / 8);
const slim = r => ({ code: r.code, name: r.name, cty: r.cty, base: r.base, last: r.last,
  growth: r.growth, cagr: r.cagr, sBase: r.sBase, sLast: r.sLast, sGrowth: r.sGrowth,
  hist: r.hist, sHist: r.sHist });
const rank = (arr, key, minKey, min, n) =>
  arr.filter(r => r[key] != null && r[minKey] >= min)
     .sort((a, b) => b[key] - a[key]).slice(0, n).map(slim);

const natBase = T.full.reduce((s, r) => s + r.base, 0);
const natLast = T.full.reduce((s, r) => s + r.last, 0);
const natSBase = T.full.reduce((s, r) => s + r.sBase, 0);
const natSLast = T.full.reduce((s, r) => s + r.sLast, 0);

// 村里 7,700 筆不全給前端：全台 Top 20 ＋ 各縣市 Top 10
const counties = [...new Set(V.full.map(r => r.cty).filter(Boolean))];
const villByCounty = {};
for (const c of counties) {
  const sub = V.full.filter(r => r.cty === c);
  villByCounty[c] = { total: rank(sub, 'growth', 'base', MIN_VILL, 10),
                      school: rank(sub, 'sGrowth', 'sBase', MIN_VILL_S, 10) };
}

const out = {
  source: '內政部戶政司 ODRP014',
  periods, basePeriod: periods[0], lastPeriod: periods[periods.length - 1],
  spanYears: Number(span.toFixed(3)),
  minBase: { town: MIN_TOWN, townSchool: MIN_TOWN_S, village: MIN_VILL, villageSchool: MIN_VILL_S },
  national: { base: natBase, last: natLast, growth: (natLast - natBase) / natBase,
              sBase: natSBase, sLast: natSLast, sGrowth: (natSLast - natSBase) / natSBase },
  counts: { towns: T.full.length, townsPartial: T.partial.length,
            villages: V.full.length, villagesPartial: V.partial.length },
  // 368 鄉鎮全給（前端要著色，且榜單依縣市縮放時自行排序）
  townAll: T.full.map(slim),
  villTop: { total: rank(V.full, 'growth', 'base', MIN_VILL, 20),
             school: rank(V.full, 'sGrowth', 'sBase', MIN_VILL_S, 20) },
  villByCounty,
};
fs.writeFileSync(path.join(WEB, 'pop_growth.json'), JSON.stringify(out));

// ---- 終端摘要 ----
const pc = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');
console.log(`期間 ${out.basePeriod} → ${out.lastPeriod}（${out.spanYears} 年），期數 ${periods.length}`);
console.log(`鄉鎮 ${out.counts.towns} 筆可比（缺期 ${out.counts.townsPartial}），村里 ${out.counts.villages} 筆可比（缺期 ${out.counts.villagesPartial}）`);
console.log(`全台總人口 ${natBase.toLocaleString()} → ${natLast.toLocaleString()}（${pc(out.national.growth)}）`);
console.log(`全台學齡 3-12 ${natSBase.toLocaleString()} → ${natSLast.toLocaleString()}（${pc(out.national.sGrowth)}）`);
const show = (t, a, k) => { console.log('\n== ' + t + ' =='); a.slice(0, 10).forEach((r, i) =>
  console.log(`${String(i + 1).padStart(2)}. ${r.name}  ${pc(r[k])}  ${r.base.toLocaleString()}→${r.last.toLocaleString()}  學齡 ${r.sBase}→${r.sLast}（${pc(r.sGrowth)}）`)); };
show(`鄉鎮・總人口成長（基期≥${MIN_TOWN}）`, rank(T.full, 'growth', 'base', MIN_TOWN, 10), 'growth');
show(`鄉鎮・學齡成長（基期學齡≥${MIN_TOWN_S}）`, rank(T.full, 'sGrowth', 'sBase', MIN_TOWN_S, 10), 'sGrowth');
show(`村里・總人口成長（基期≥${MIN_VILL}）`, out.villTop.total, 'growth');
show(`村里・學齡成長（基期學齡≥${MIN_VILL_S}）`, out.villTop.school, 'sGrowth');
