/* 近五年人口成長簡報 — 互動投影片
   資料：pop_growth.json（scripts/build_pop_growth.js 產出）＋ towns topo ＋ income ＋ 自家品牌點位
   地圖：MapLibre，不鋪底圖圖磚，只畫行政區色塊（暗色簡報配街道圖會糊，且避開底圖授權問題） */
(async function () {
  const boot = document.getElementById('boot');
  const fail = msg => { boot.textContent = msg; throw new Error(msg); };

  const [townsTopo, growth, income] = await Promise.all([
    fetch('towns-10t.json').then(r => r.json()),
    fetch('pop_growth.json').then(r => r.ok ? r.json() : null),
    fetch('income.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]).catch(() => fail('資料載入失敗，請確認是以 HTTP 開啟（不能直接按兩下開檔案）。'));
  if (!growth) fail('找不到 pop_growth.json，請先執行 node scripts/build_pop_growth.js');

  // 自家四品牌（檔案小，用來在卡片顯示該區既有據點數；補習班 cram 1.7MB 故不載）
  const BRANDS = [['KUMON', 'kumon.json'], ['明光義塾', 'meiko.json'],
    ['MPM 數學', 'mpm.json'], ['台灣拓人', 'tact.json']];
  const brandData = await Promise.all(BRANDS.map(([, f]) =>
    fetch(f).then(r => r.ok ? r.json() : null).catch(() => null)));

  const townsGeo = topojson.feature(townsTopo, townsTopo.objects.towns);
  const towns = townsGeo.features;
  const featByCode = new Map(towns.map(f => [f.properties.TOWNCODE, f]));

  // ---- 小工具 ----
  const normTW = s => (s || '').replace(/臺/g, '台');
  const fmtInt = d3.format(',');
  const fmtPct = v => v == null ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const cls = v => v >= 0 ? 'up' : 'dn';
  const periodLabel = p => p.slice(0, 3) + '/' + p.slice(3);
  // 所得單位是千元，與主頁 app.js 的 fmtIncome 用同一條換算，避免兩頁數字對不起來
  const fmtIncome = v => (v / 10).toFixed(1).replace(/\.0$/, '') + ' 萬';
  const PERIOD_TXT = periodLabel(growth.basePeriod) + ' → ' + periodLabel(growth.lastPeriod);

  let metric = 'total'; // total | school
  const gOf = r => metric === 'school' ? r.sGrowth : r.growth;
  const baseOf = r => metric === 'school' ? r.sBase : r.base;
  const lastOf = r => metric === 'school' ? r.sLast : r.last;
  const histOf = r => metric === 'school' ? r.sHist : r.hist;
  const metricName = () => metric === 'school' ? '學齡 3–12' : '總人口';

  function bboxOf(features) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = c => {
      if (typeof c[0] === 'number') {
        if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
        if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
      } else for (const d of c) walk(d);
    };
    for (const f of features) walk(f.geometry.coordinates);
    return [[x0, y0], [x1, y1]];
  }

  function sparkline(series, w = 92, h = 26) {
    const vals = series.filter(v => v != null);
    if (vals.length < 2) return '';
    const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
    const pts = series.map((v, i) => v == null ? null :
      [(i / (series.length - 1)) * (w - 2) + 1, h - 2 - ((v - lo) / sp) * (h - 4)]).filter(Boolean);
    const col = vals[vals.length - 1] >= vals[0] ? '#10b981' : '#ef4444';
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<polyline points="' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '" ' +
      'fill="none" stroke="' + col + '" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) +
      '" r="2.4" fill="' + col + '"/></svg>';
  }

  // 該鄉鎮的自家品牌據點數（品牌檔的縣市/鄉鎮在 r[3]/r[4]）
  function brandCounts(fullName) {
    const key = normTW(fullName);
    return BRANDS.map(([label], i) => {
      const d = brandData[i];
      if (!d || !d.rows) return [label, 0];
      let n = 0;
      for (const r of d.rows) if (normTW((r[3] || '') + (r[4] || '')) === key) n++;
      return [label, n];
    });
  }

  // ---- 地圖 ----
  const TAIWAN = [[119.3, 21.85], [122.05, 25.35]];
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0d10' } }] },
    center: [120.95, 23.7], zoom: 6.4, attributionControl: false,
  });
  const growthColor = ['interpolate', ['linear'], ['coalesce', ['feature-state', 'g'], 0],
    -0.10, '#b91c1c', -0.03, '#7f3b3b', 0, '#3f3f46', 0.03, '#2f7d5f', 0.10, '#10b981'];

  let mapReady = false, villFeats = null, villLoading = false;
  // 這張地圖沒有外部圖磚來源，load 事件只等樣式本身，會很快觸發；仍加保險逾時避免卡住
  await new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    if (map.loaded()) fin(); else map.once('load', fin);
    setTimeout(fin, 4000);
  });
  map.addSource('towns', { type: 'geojson', data: townsGeo, promoteId: 'TOWNCODE' });
  map.addLayer({ id: 'twn-fill', type: 'fill', source: 'towns',
    paint: { 'fill-color': growthColor, 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'twn-line', type: 'line', source: 'towns',
    paint: { 'line-color': '#0b0d10', 'line-width': 0.5 } });
  map.addLayer({ id: 'twn-hi', type: 'line', source: 'towns',
    filter: ['in', ['get', 'TOWNCODE'], ['literal', []]],
    paint: { 'line-color': '#f59e0b', 'line-width': 1.8 } });
  mapReady = true;
  // 圖磚 pending 時渲染迴圈會停擺，資料事件喚醒它
  map.on('data', () => map.triggerRepaint());
  window._map = map; // 除錯把手，與主頁一致

  function paintTowns() {
    for (const r of growth.townAll) {
      const v = gOf(r);
      map.setFeatureState({ source: 'towns', id: r.code }, { g: v == null ? 0 : v });
    }
  }
  function highlight(codes) {
    map.setFilter('twn-hi', ['in', ['get', 'TOWNCODE'], ['literal', codes || []]]);
  }

  let markers = [];
  function clearMarkers() { markers.forEach(m => m.remove()); markers = []; }
  function setMarkers(rows, onPick) {
    clearMarkers();
    // 前幾名常擠在同一帶（桃園、新北），倒著加讓名次高的疊在上層、不被蓋住
    rows.map((r, i) => [r, i]).reverse().forEach(([r, i]) => {
      const f = featByCode.get(r.code);
      if (!f) return;
      const el = document.createElement('div');
      el.className = 'pin'; el.textContent = i + 1; el.dataset.code = r.code;
      el.style.zIndex = String(100 - i);
      el.addEventListener('click', ev => { ev.stopPropagation(); onPick(r.code); });
      markers.push(new maplibregl.Marker({ element: el }).setLngLat(d3.geoCentroid(f)).addTo(map));
    });
  }
  function markSel(code) {
    markers.forEach(m => m.getElement().classList.toggle('sel', m.getElement().dataset.code === code));
  }

  async function ensureVillages() {
    if (villFeats || villLoading) return;
    villLoading = true;
    try {
      const vt = await fetch('villages-10t.json').then(r => r.json());
      const geo = topojson.feature(vt, vt.objects.villages);
      villFeats = geo.features;
      map.addSource('vill', { type: 'geojson', data: geo, promoteId: 'VILLCODE' });
      map.addLayer({ id: 'vill-line', type: 'line', source: 'vill',
        paint: { 'line-color': 'rgba(255,255,255,0.18)', 'line-width': 0.4 } }, 'twn-hi');
      map.addLayer({ id: 'vill-sel', type: 'fill', source: 'vill',
        filter: ['==', ['get', 'VILLCODE'], ''],
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.55 } }, 'twn-hi');
      map.addLayer({ id: 'vill-sel-line', type: 'line', source: 'vill',
        filter: ['==', ['get', 'VILLCODE'], ''],
        paint: { 'line-color': '#fff', 'line-width': 2 } });
    } finally { villLoading = false; }
  }

  // ---- 共用卡片 ----
  function townCard(code) {
    const r = growth.townAll.find(x => x.code === code);
    if (!r) return '<div class="empty">查無資料</div>';
    const iv = income && income.towns[code];
    const bc = brandCounts(r.name);
    const trend = (lab, pct, b, l, hist) =>
      '<div class="trend"><span class="lab">' + lab + '</span>' +
      '<span class="pc ' + cls(pct) + '">' + fmtPct(pct) + '</span>' +
      '<span class="nu">' + fmtInt(b) + '→' + fmtInt(l) + '</span>' + sparkline(hist) + '</div>';
    return '<h4>' + normTW(r.name) + '</h4>' +
      '<div class="tiny">期間 ' + PERIOD_TXT + '（6 期）</div>' +
      '<div class="mini">' +
        '<div><div class="v">' + fmtInt(r.last) + '</div><div class="k">現住人口</div></div>' +
        '<div><div class="v">' + fmtInt(r.sLast) + '</div><div class="k">學齡 3–12</div></div>' +
        '<div><div class="v">' + (iv ? fmtIncome(iv[2]) : '—') + '</div><div class="k">所得中位數</div></div>' +
      '</div>' +
      trend('總人口', r.growth, r.base, r.last, r.hist) +
      trend('學齡', r.sGrowth, r.sBase, r.sLast, r.sHist) +
      '<div class="tiny" style="margin-top:.6rem">區內自家據點：' +
        bc.map(([l, n]) => l + ' ' + n).join('　') + '</div>';
  }
  function villCard(v) {
    const trend = (lab, pct, b, l, hist) =>
      '<div class="trend"><span class="lab">' + lab + '</span>' +
      '<span class="pc ' + cls(pct) + '">' + fmtPct(pct) + '</span>' +
      '<span class="nu">' + fmtInt(b) + '→' + fmtInt(l) + '</span>' + sparkline(hist) + '</div>';
    return '<h4>' + normTW(v.name) + '</h4>' +
      '<div class="tiny">期間 ' + PERIOD_TXT + '（6 期）</div>' +
      '<div class="mini">' +
        '<div><div class="v">' + fmtInt(v.last) + '</div><div class="k">現住人口</div></div>' +
        '<div><div class="v">' + fmtInt(v.sLast) + '</div><div class="k">學齡 3–12</div></div>' +
        '<div><div class="v">' + fmtPct(v.sGrowth) + '</div><div class="k">學齡成長</div></div>' +
      '</div>' +
      trend('總人口', v.growth, v.base, v.last, v.hist) +
      trend('學齡', v.sGrowth, v.sBase, v.sLast, v.sHist);
  }

  function rankHTML(rows, valueOf, extraOf) {
    if (!rows.length) return '<li class="empty">無符合門檻的資料</li>';
    return rows.map((r, i) => {
      const v = valueOf(r);
      return '<li data-code="' + r.code + '"><span class="n">' + (i + 1) + '</span>' +
        '<span class="nm">' + normTW(r.name) + '</span>' +
        '<span class="pc ' + cls(v) + '">' + fmtPct(v) + '</span>' +
        '<span class="ex">' + extraOf(r) + '</span></li>';
    }).join('');
  }
  function selectRow(listEl, code) {
    [...listEl.children].forEach(li => li.classList.toggle('on', li.dataset.code === code));
  }

  // ---- 榜單資料 ----
  const townTop = () => {
    const key = metric === 'school' ? 'sGrowth' : 'growth';
    const bk = metric === 'school' ? 'sBase' : 'base';
    const min = metric === 'school' ? growth.minBase.townSchool : growth.minBase.town;
    return growth.townAll.filter(r => r[key] != null && r[bk] >= min)
      .sort((a, b) => b[key] - a[key]).slice(0, 10);
  };
  const villTop = () => (metric === 'school' ? growth.villTop.school : growth.villTop.total).slice(0, 10);
  // 假成長：總人口漲、學齡跌，依落差排序
  const trapRows = growth.townAll
    .filter(r => r.growth > 0 && r.sGrowth < 0 && r.base >= growth.minBase.town)
    .sort((a, b) => (b.growth - b.sGrowth) - (a.growth - a.sGrowth)).slice(0, 10);

  // ---- 各頁渲染 ----
  const n = growth.national;
  const grow = growth.townAll.filter(r => r.growth > 0).length;
  const shrink = growth.townAll.length - grow;
  const sGrow = growth.townAll.filter(r => r.sGrowth > 0).length;

  document.getElementById('coverPeriod').textContent =
    '民國 ' + PERIOD_TXT + '　共 6 期　' + growth.spanYears + ' 年';
  document.getElementById('coverKpis').innerHTML =
    kpi(fmtPct(n.growth), '全台總人口', fmtInt(n.base) + ' → ' + fmtInt(n.last), cls(n.growth)) +
    kpi(fmtPct(n.sGrowth), '全台學齡 3–12', fmtInt(n.sBase) + ' → ' + fmtInt(n.sLast), cls(n.sGrowth)) +
    kpi(grow + ' / ' + growth.townAll.length, '總人口成長的鄉鎮', '其餘 ' + shrink + ' 區在縮', 'am') +
    kpi(sGrow + ' / ' + growth.townAll.length, '學齡成長的鄉鎮', '少子化是全面的', 'am');

  function kpi(v, k, s, c) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (c || '') + '">' + v +
      '</div><div class="s">' + s + '</div></div>';
  }

  document.getElementById('methodCols').innerHTML =
    '<div class="col"><h3>資料從哪來</h3><p>內政部戶政司 <span class="em">ODRP014</span>「村里戶數、單一年齡人口」，' +
      '每月發布、全國全量，不是抽樣。所得中位數來自財政部綜稅統計（111 年度）。</p>' +
      '<ul><li>鄉鎮市區 <span class="em">' + growth.counts.towns + '</span> 個全數可比</li>' +
      '<li>村里 <span class="em">' + fmtInt(growth.counts.villages) + '</span> 個可比</li>' +
      '<li>另有 ' + growth.counts.villagesPartial + ' 個村里因期間內整併或新設、兩期對不上而排除</li></ul></div>' +
    '<div class="col"><h3>期間為什麼是 ' + growth.spanYears + ' 年</h3>' +
      '<p>封存的歷年快照是各年 12 月（110/12 到 114/12），而目前最新一期是 <span class="em">115/09</span>。</p>' +
      '<p>終點取最新一期而不是 114/12，是為了不浪費最近九個月的變化；代價是區間不是整五年，' +
      '所以頁面一律標 <span class="em">' + PERIOD_TXT + '</span>，不寫「五年」了事。</p></div>' +
    '<div class="col"><h3>兩個門檻，和一個指標選擇</h3>' +
      '<p>母數太小的百分比沒有決策意義——50 人的里增加 100 人就是 +200%。所以設下限：' +
      '鄉鎮基期 <span class="em">' + fmtInt(growth.minBase.town) + '</span> 人、村里 <span class="em">' +
      fmtInt(growth.minBase.village) + '</span> 人（學齡版本各除以 8）。</p>' +
      '<p>另外同時看<span class="em">總人口</span>與<span class="em">學齡 3–12 歲</span>兩個指標：' +
      '對補教來說，人變多但小孩變少的區是陷阱，只看總人口會踩到。</p></div>';

  document.getElementById('s3sub').textContent =
    '期間 ' + PERIOD_TXT + '，全台總人口 ' + fmtPct(n.growth) + '、學齡人口 ' + fmtPct(n.sGrowth);

  function renderS3() {
    const rows = townTop();
    const worst = [...growth.townAll].filter(r => gOf(r) != null && baseOf(r) >= (metric === 'school' ? growth.minBase.townSchool : growth.minBase.town))
      .sort((a, b) => gOf(a) - gOf(b)).slice(0, 3);
    const natPct = metric === 'school' ? n.sGrowth : n.growth;
    document.getElementById('s3panel').innerHTML =
      '<div class="kpis">' +
        kpi(fmtPct(natPct), '全台' + metricName(), fmtInt(metric === 'school' ? n.sBase : n.base) + ' → ' +
          fmtInt(metric === 'school' ? n.sLast : n.last), cls(natPct)) +
        kpi(fmtPct(gOf(rows[0])), '最高：' + normTW(rows[0].name),
          fmtInt(baseOf(rows[0])) + ' → ' + fmtInt(lastOf(rows[0])), 'up') +
      '</div>' +
      '<div class="note">全台' + metricName() + '是 <b>' + fmtPct(natPct) + '</b>，' +
        '但 ' + growth.townAll.length + ' 個鄉鎮裡有 <b>' +
        (metric === 'school' ? sGrow : grow) + '</b> 個仍在成長。' +
        '衰退不是均勻發生的——它集中在特定區域，而成長集中在另一批。' +
        '看地圖的綠色塊在哪裡，比看全國數字有用。</div>' +
      '<div class="card"><h4>衰退最快的三個區</h4>' +
        worst.map(r => '<div class="trend"><span class="lab" style="width:7rem">' + normTW(r.name) + '</span>' +
          '<span class="pc dn">' + fmtPct(gOf(r)) + '</span>' +
          '<span class="nu">' + fmtInt(baseOf(r)) + '→' + fmtInt(lastOf(r)) + '</span></div>').join('') +
      '</div>';
  }

  function renderS4() {
    const rows = townTop();
    const list = document.getElementById('s4list');
    list.innerHTML = rankHTML(rows, gOf, r => fmtInt(baseOf(r)) + '→' + fmtInt(lastOf(r)));
    highlight(rows.map(r => r.code));
    setMarkers(rows, pickS4);
    pickS4(rows[0].code, true);
  }
  function pickS4(code, keepView) {
    document.getElementById('s4card').innerHTML = townCard(code);
    selectRow(document.getElementById('s4list'), code);
    markSel(code);
    if (!keepView) {
      const f = featByCode.get(code);
      if (f) map.fitBounds(bboxOf([f]), { padding: 90, maxZoom: 11, duration: 600 });
    }
  }

  function renderS5() {
    const list = document.getElementById('s5list');
    list.innerHTML = rankHTML(trapRows, r => r.sGrowth,
      r => '總人口 ' + fmtPct(r.growth));
    document.getElementById('s5note').innerHTML = trapRows.length
      ? '這 ' + trapRows.length + ' 個區總人口都在成長，學齡人口卻在減少。' +
        '落差最大的是 <b>' + normTW(trapRows[0].name) + '</b>：總人口 ' + fmtPct(trapRows[0].growth) +
        '、學齡 ' + fmtPct(trapRows[0].sGrowth) + '。' +
        '搬進來的多半不是帶小學生的家庭，拿總人口當展店依據會誤判。'
      : '此條件下沒有符合的鄉鎮。';
    highlight(trapRows.map(r => r.code));
    if (trapRows.length) pickS5(trapRows[0].code, true);
  }
  function pickS5(code, keepView) {
    document.getElementById('s5card').innerHTML = townCard(code);
    selectRow(document.getElementById('s5list'), code);
    if (!keepView) {
      const f = featByCode.get(code);
      if (f) map.fitBounds(bboxOf([f]), { padding: 90, maxZoom: 11, duration: 600 });
    }
  }

  function renderS6() {
    const rows = villTop();
    const list = document.getElementById('s6list');
    list.innerHTML = rows.map((v, i) =>
      '<li data-code="' + v.code + '"><span class="n">' + (i + 1) + '</span>' +
      '<span class="nm">' + normTW(v.name) + '</span>' +
      '<span class="pc ' + cls(gOf(v)) + '">' + fmtPct(gOf(v)) + '</span>' +
      '<span class="ex">' + fmtInt(baseOf(v)) + '→' + fmtInt(lastOf(v)) + '</span></li>').join('');
    highlight(rows.map(v => v.code.slice(0, 8)));
    clearMarkers();
    if (rows.length) pickS6(rows[0].code, true);
  }
  async function pickS6(vcode, keepView) {
    const rows = villTop();
    const v = rows.find(x => x.code === vcode);
    if (!v) return;
    document.getElementById('s6card').innerHTML = villCard(v);
    selectRow(document.getElementById('s6list'), vcode);
    await ensureVillages();
    if (map.getLayer('vill-sel')) {
      map.setFilter('vill-sel', ['==', ['get', 'VILLCODE'], vcode]);
      map.setFilter('vill-sel-line', ['==', ['get', 'VILLCODE'], vcode]);
    }
    const f = villFeats && villFeats.find(x => x.properties.VILLCODE === vcode);
    if (f && !keepView) map.fitBounds(bboxOf([f]), { padding: 140, maxZoom: 14.5, duration: 650 });
    else if (f && keepView) map.fitBounds(bboxOf([f]), { padding: 140, maxZoom: 13, duration: 400 });
  }

  document.getElementById('actions').innerHTML = [
    ['01', '用學齡榜、不要用總人口榜挑點',
      '總人口前十名裡有好幾個學齡是負的（淡水 −2.1%、竹北 −5.7%、八里 −4.5%）。' +
      '要開教室，先看學齡 3–12 的榜單，再回頭確認總人口有沒有撐住。'],
    ['02', '鄉鎮選完，一定要再下鑽到村里',
      '鄉鎮是平均值，會把重劃區的爆發稀釋掉。台中北屯區整體學齡 +5.6%，' +
      '但區內舊社里是 +232%。真正的展店點是里，不是區。'],
    ['03', '把成長榜和現有據點疊著看',
      '卡片下方列出該區四個自家品牌的據點數。成長快又沒有自家據點的區，' +
      '就是優先名單；回展店地圖的高階主管模式可以直接看拓荒／飽和判定。'],
    ['04', '異常值要查證再用',
      '彰化竹塘鄉學齡 +33.2% 但總人口是跌的，六期逐年都平滑上升、不是資料錯誤，' +
      '但這個組合很反常。這類標的進場前先做實地確認。'],
  ].map(([no, h, p]) =>
    '<div class="step"><span class="no">' + no + '</span><h3>' + h + '</h3><p>' + p + '</p></div>').join('');

  // ---- 投影片控制 ----
  const slides = [...document.querySelectorAll('.slide')];
  const mapWrap = document.getElementById('mapWrap');
  const dots = document.getElementById('dots');
  slides.forEach((_, i) => {
    const d = document.createElement('i');
    d.addEventListener('click', () => goto(i));
    dots.appendChild(d);
  });
  let idx = 0;

  function goto(i) {
    idx = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => s.classList.toggle('active', k === idx));
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === idx));
    document.getElementById('prev').disabled = idx === 0;
    document.getElementById('next').disabled = idx === slides.length - 1;
    history.replaceState(null, '', '#p' + (idx + 1)); // 可直接用 growth.html#p4 開到指定頁
    const slot = slides[idx].querySelector('[data-mapslot]');
    if (slot) {
      slot.appendChild(mapWrap);
      mapWrap.style.display = '';
      map.resize();
    } else {
      mapWrap.style.display = 'none';
    }
    render();
  }

  // 每頁進場時重算該頁內容（指標切換後回到同頁也走這裡）
  function render() {
    if (!mapReady) return;
    paintTowns();
    if (map.getLayer('vill-line'))
      map.setLayoutProperty('vill-line', 'visibility', idx === 5 ? 'visible' : 'none');
    if (map.getLayer('vill-sel') && idx !== 5) {
      map.setFilter('vill-sel', ['==', ['get', 'VILLCODE'], '']);
      map.setFilter('vill-sel-line', ['==', ['get', 'VILLCODE'], '']);
    }
    if (idx === 2) { renderS3(); clearMarkers(); highlight([]); map.fitBounds(TAIWAN, { padding: 24, duration: 500 }); }
    else if (idx === 3) { map.fitBounds(TAIWAN, { padding: 24, duration: 500 }); renderS4(); }
    else if (idx === 4) { renderS5(); clearMarkers(); map.fitBounds(TAIWAN, { padding: 24, duration: 500 }); }
    else if (idx === 5) renderS6();
    else { clearMarkers(); highlight([]); }
  }

  document.getElementById('prev').addEventListener('click', () => goto(idx - 1));
  document.getElementById('next').addEventListener('click', () => goto(idx + 1));
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); goto(idx + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goto(idx - 1); }
  });

  // 指標切換（三頁共用同一個 metric）
  document.getElementById('deck').addEventListener('click', e => {
    const btn = e.target.closest('.seg button');
    if (!btn) return;
    metric = btn.dataset.v;
    document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.v === metric));
    render();
  });

  // 清單點擊
  document.getElementById('s4list').addEventListener('click', e => {
    const li = e.target.closest('li[data-code]'); if (li) pickS4(li.dataset.code);
  });
  document.getElementById('s5list').addEventListener('click', e => {
    const li = e.target.closest('li[data-code]'); if (li) pickS5(li.dataset.code);
  });
  document.getElementById('s6list').addEventListener('click', e => {
    const li = e.target.closest('li[data-code]'); if (li) pickS6(li.dataset.code);
  });
  // 地圖點鄉鎮 → 在第 4、5 頁開該區卡片
  map.on('click', 'twn-fill', e => {
    const code = e.features[0] && e.features[0].properties.TOWNCODE;
    if (!code) return;
    if (idx === 3) pickS4(code); else if (idx === 4) pickS5(code);
  });
  map.on('mouseenter', 'twn-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'twn-fill', () => { map.getCanvas().style.cursor = ''; });

  boot.remove();
  const fromHash = parseInt((location.hash || '').replace('#p', ''), 10);
  goto(Number.isFinite(fromHash) ? fromHash - 1 : 0);
})();
