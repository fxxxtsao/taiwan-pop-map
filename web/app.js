/* 台灣人口年齡地圖 — MapLibre GL 版（WebGL 渲染）
   D3 僅保留：分位數計算、圖例漸層、詳細面板直方圖 */
(async function () {
  const [townsTopo, countiesTopo, pop, schools, income, incomeV, cram] = await Promise.all([
    fetch('towns-10t.json').then(r => r.json()),
    fetch('counties-10t.json').then(r => r.json()),
    fetch('population.json').then(r => r.json()),
    fetch('schools.json').then(r => r.json()),
    fetch('income.json').then(r => r.json()),
    fetch('income_villages.json').then(r => r.json()),
    fetch('cram.json').then(r => r.ok ? r.json() : null).catch(() => null), // 補習班（可能尚未產出）
  ]);
  const kumon = await fetch('kumon.json').then(r => r.ok ? r.json() : null).catch(() => null); // KUMON 教室
  const meiko = await fetch('meiko.json').then(r => r.ok ? r.json() : null).catch(() => null); // 明光義塾 教室
  const mpm = await fetch('mpm.json').then(r => r.ok ? r.json() : null).catch(() => null); // MPM 數學 教室
  const tact = await fetch('tact.json').then(r => r.ok ? r.json() : null).catch(() => null); // 台灣拓人 教室
  const growth = await fetch('pop_growth.json').then(r => r.ok ? r.json() : null).catch(() => null); // 近五年人口成長（scripts/build_pop_growth.js）

  const townsGeo = topojson.feature(townsTopo, townsTopo.objects.towns);
  const countiesGeo = topojson.feature(countiesTopo, countiesTopo.objects.counties);
  const towns = townsGeo.features;

  // ---- 期間標示 ----
  const p = pop.period;
  document.getElementById('period').textContent =
    `（民國 ${p.slice(0, 3)} 年 ${+p.slice(3)} 月戶籍資料）`;

  // ---- 狀態 ----
  const BANDS = [
    { label: '總人口', min: 0, max: 100 },
    { label: '0–2 嬰幼兒', min: 0, max: 2 },
    { label: '3–5 幼兒園', min: 3, max: 5 },
    { label: '6–11 國小', min: 6, max: 11 },
    { label: '12–17 國高中', min: 12, max: 17 },
  ];
  let band = { min: 0, max: 100 };
  let metric = 'count';  // count | share
  let theme = 'pop';     // pop | income
  let incMetric = 'med'; // med | avg
  let selectedCode = null;
  let pinScope = null;   // {type:'town'|'county', key} 大頭針範圍
  let pinsShown = false;
  let roleMode = 'ops';          // ops | exec  角色模式（營運 / 高階主管）
  let execRole = new Map();      // TOWNCODE -> 1 拓荒潛力 | -1 飽和警戒 | 0
  let execRowByCode = new Map(); // TOWNCODE -> {schoolAge, own, mkt}
  let execResult = null;
  let execScopeCounty = '';      // 高階主管面板目前縮放的縣市（''＝全台）
  const SCHOOL_MINZOOM = 8.2; // 舊版 zoomK≈3
  const VILL_MINZOOM = 9.3;   // 舊版 zoomK≈6
  const HTML_PINS_MAX = 150;  // 少量用 HTML Marker（逐支落下動畫）；超過改 GPU symbol layer（全體落下）
  const MISS = -9e18;         // feature-state 缺值 sentinel
  const TAIWAN_BOUNDS = [[118.0, 21.6], [122.1, 26.5]];
  const normTW = s => (s || '').replace(/臺/g, '台');

  // 學校規模編碼（大頭針與圓點同色相：國小深藍、幼兒園紫；綠色留給補習班）
  const ELEM_RAMP = ['#c5dcef', '#93bcdd', '#5f93c3', '#3a6da1', '#1f4a76']; // 深藍系
  const KIN_RAMP = ['#ffd98a', '#f0b429', '#d99400', '#b07400', '#7a5200']; // 暗金系；靠高飽和＋深描邊與暖色底圖區隔
  const ELEM_BINS = [61, 195, 676, 1228], KIN_BINS = [46, 90, 150, 240];
  const ELEM_TIERS = ['小型', '中小型', '中型', '大型', '超大型'];
  const KIN_TIERS = ['小型', '中小型', '中型', '中大型', '大型'];
  const tierIdx = (v, bins) => { let i = 0; while (i < bins.length && v > bins[i]) i++; return i; };
  const tierBadge = (v, bins, tiers, ramp) =>
    `<span class="t-tier"><i class="t-dot" style="background:${ramp[tierIdx(v, bins)]}"></i>${tiers[tierIdx(v, bins)]}</span>`;
  // 連續對數色階（每個數值對應不同深淺，尾端也拉得開）；無資料灰色
  const ELEM_DOM = [20, 3024], KIN_DOM = [12, 1200];
  const sizeColor = (ramp, dom) => {
    const l0 = Math.log10(dom[0]), l1 = Math.log10(dom[1]), stops = [];
    ramp.forEach((c, i) => stops.push(l0 + (l1 - l0) * i / (ramp.length - 1), c));
    return ['case',
      ['<', ['coalesce', ['get', 'cnt'], -1], 0], '#c9c9c9',
      ['interpolate', ['linear'], ['log10', ['max', ['coalesce', ['get', 'cnt'], 1], 1]], ...stops]];
  };

  // ---- 數值計算 ----
  const sumBand = (ages, lo, hi) => {
    let s = 0;
    for (let i = lo; i <= hi; i++) s += ages[i];
    return s;
  };
  const valueOf = code => {
    if (theme === 'income') {
      const v = income.towns[code];
      return v ? v[incMetric === 'med' ? 2 : 1] : null;
    }
    const t = pop.towns[code];
    if (!t) return null;
    const n = sumBand(t.ages, band.min, band.max);
    if (metric !== 'share') return n;
    const ct = countyTotals[code.slice(0, 5)];
    return ct ? n / ct : 0;
  };
  // 縣市總人口（村里占比的分母）
  const countyTotals = {};
  for (const [code, t] of Object.entries(pop.towns)) {
    const c = code.slice(0, 5);
    countyTotals[c] = (countyTotals[c] || 0) + t.total;
  }

  const fmtCount = d3.format(',');
  const fmtShare = d3.format('.1%');
  const fmtShareFine = d3.format('.3~%'); // 占縣市比例可能很小，需更多位數
  const fmtIncome = v => (v / 10).toFixed(1).replace(/\.0$/, '') + ' 萬';
  const fmt = v => theme === 'income' ? fmtIncome(v)
    : metric === 'share' ? fmtShareFine(v)
    : fmtCount(v);

  function bandLabel() {
    if (theme === 'income') return incMetric === 'med' ? '所得中位數' : '所得平均數';
    if (band.min === 0 && band.max === 100) return '總人口';
    return `${band.min}–${band.max === 100 ? '100+' : band.max} 歲`;
  }

  // ---- 色階 ----
  const COLORS = ['#f5f2ea', '#ead9b9', '#e0b18f', '#cf7f6e', '#a85f68'];
  const interp = d3.interpolateRgbBasis(COLORS);
  function makeDomain(vals) {
    vals = vals.filter(v => v != null).sort(d3.ascending);
    const lo = d3.quantile(vals, 0.02) ?? 0;
    const hi = d3.quantile(vals, 0.98) ?? 1;
    return { lo, hi: Math.max(hi, lo + 1e-9) };
  }
  function colorExpr(dom) {
    const stops = [];
    COLORS.forEach((c, i) => stops.push(dom.lo + (dom.hi - dom.lo) * i / (COLORS.length - 1), c));
    return ['case',
      ['<', ['coalesce', ['feature-state', 'v'], MISS], MISS / 10], '#ececec',
      ['interpolate', ['linear'], ['feature-state', 'v'], ...stops]];
  }
  let domT = { lo: 0, hi: 1 }, domV = null;

  function drawLegend(dom) {
    const cv = document.getElementById('legendBar');
    const ctx = cv.getContext('2d');
    for (let x = 0; x < cv.width; x++) {
      ctx.fillStyle = interp(x / (cv.width - 1));
      ctx.fillRect(x, 0, 1, cv.height);
    }
    document.getElementById('legMin').textContent = fmt(dom.lo);
    document.getElementById('legMax').textContent = fmt(dom.hi);
    document.getElementById('legLab').textContent =
      theme === 'income' ? (incMetric === 'med' ? `中位數（${income.year}年）` : `平均數（${income.year}年）`)
        : metric === 'share' ? '占比' : '人數';
  }

  // ---- 地圖 ----
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        emap: {
          type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}'],
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#edefec' } },
        { id: 'emap', type: 'raster', source: 'emap', paint: { 'raster-saturation': -0.4, 'raster-opacity': 0.92 } },
      ],
    },
    center: [120.9, 23.85], zoom: 6.3, // 於 load 時再以 fitBounds 精準對位（constructor bounds 在部分環境會算錯 zoom）
    minZoom: 5.5, maxZoom: 17.5,
    attributionControl: false,
    preserveDrawingBuffer: true, // 保留繪圖緩衝，讓地圖截圖（toDataURL）能取到畫面
    dragRotate: false, pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  window._map = map; // 除錯把手（DevTools 檢查圖層/狀態用）
  // NLSC 圖磚 pending 時渲染迴圈會停擺，資料事件一律喚醒（triggerRepaint 只是排程一幀，成本可忽略）
  map.on('data', () => map.triggerRepaint());

  const roadOn = () => document.getElementById('layerRoad').checked;
  const fillOpacity = () => roadOn() ? 0.72 : 1;

  // ---- 學校 GeoJSON ----
  function schoolFeature(row, kind) {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row[2], row[1]] },
      properties: { n: row[0], pub: row[3], c: row[4], t: row[5], k: kind, cnt: row[7] ?? null, cl: row[8] ?? null },
    };
  }
  const schoolsGeo = {
    type: 'FeatureCollection',
    features: [...schools.elem.map(r => schoolFeature(r, 'e')),
               ...schools.kinder.map(r => schoolFeature(r, 'k'))],
  };
  document.getElementById('cntElem').textContent = `${schools.elem.length} 所`;
  document.getElementById('cntKinder').textContent = `${schools.kinder.length} 所`;

  // 補習班（測試中：資料可能只涵蓋部分縣市）
  const cramGeo = cram ? {
    type: 'FeatureCollection',
    features: cram.rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r[2], r[1]] },
      properties: { n: r[0], cat: r[3], c: r[4], t: r[5] },
    })),
  } : null;
  if (cram) {
    document.getElementById('cramRow').hidden = false;
    document.getElementById('cntCram').textContent = `${cram.rows.length} 家`;
  }

  // KUMON 教室（獨立圖層，湖水藍）
  const kumonGeo = kumon ? {
    type: 'FeatureCollection',
    features: kumon.rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r[2], r[1]] },
      properties: { n: r[0], c: r[3], t: r[4] },
    })),
  } : null;
  if (kumon) {
    document.getElementById('kumonRow').hidden = false;
    document.getElementById('cntKumon').textContent = `${kumon.rows.length} 家`;
  }

  // 明光義塾 教室（獨立圖層，紫羅蘭）
  const meikoGeo = meiko ? {
    type: 'FeatureCollection',
    features: meiko.rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r[2], r[1]] },
      properties: { n: r[0], c: r[3], t: r[4] },
    })),
  } : null;
  if (meiko) {
    document.getElementById('meikoRow').hidden = false;
    document.getElementById('cntMeiko').textContent = `${meiko.rows.length} 家`;
  }

  // MPM 數學 教室（獨立圖層，青綠）
  const mpmGeo = mpm ? {
    type: 'FeatureCollection',
    features: mpm.rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r[2], r[1]] },
      properties: { n: r[0], c: r[3], t: r[4] },
    })),
  } : null;
  if (mpm) {
    document.getElementById('mpmRow').hidden = false;
    document.getElementById('cntMpm').textContent = `${mpm.rows.length} 家`;
  }

  // 台灣拓人 教室（獨立圖層，紅）
  const tactGeo = tact ? {
    type: 'FeatureCollection',
    features: tact.rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r[2], r[1]] },
      properties: { n: r[0], c: r[3], t: r[4] },
    })),
  } : null;
  if (tact) {
    document.getElementById('tactRow').hidden = false;
    document.getElementById('cntTact').textContent = `${tact.rows.length} 家`;
  }

  // ---- 圖層 ----
  // 不等 'load' 也不等 isStyleLoaded()——兩者都會等底圖圖磚，NLSC 慢或失敗時永不就緒。
  // 掛在 styledata（style 解析完就觸發，不等圖磚）；加圖層冪等化，重試不會撞 already exists。
  let inited = false;
  const addSrc = (id, def) => { if (!map.getSource(id)) map.addSource(id, def); };
  const addLyr = (def, before) => { if (!map.getLayer(def.id)) map.addLayer(def, before); };
  function initLayers() {
    if (inited) return;
    addSrc('towns', { type: 'geojson', data: townsGeo, promoteId: 'TOWNCODE' }); // style 未 ready 在此丟例外
    addSrc('counties', { type: 'geojson', data: countiesGeo });
    addSrc('schools', { type: 'geojson', data: schoolsGeo });
    map.fitBounds(TAIWAN_BOUNDS, { padding: 40, duration: 0 });

    addLyr({
      id: 'towns-fill', type: 'fill', source: 'towns',
      paint: { 'fill-color': '#eee', 'fill-opacity': fillOpacity() },
    });
    addLyr({
      id: 'towns-hover', type: 'fill', source: 'towns',
      paint: { 'fill-color': '#3d4148', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.10, 0] },
    });
    addLyr({
      id: 'towns-line', type: 'line', source: 'towns',
      paint: { 'line-color': 'rgba(255,255,255,0.85)', 'line-width': 0.7 },
    });
    addLyr({
      id: 'county-line', type: 'line', source: 'counties',
      paint: { 'line-color': 'rgba(61,65,72,0.35)', 'line-width': 1 },
    });
    addLyr({
      id: 'towns-sel', type: 'line', source: 'towns',
      paint: { 'line-color': '#3d4148', 'line-width': 1.6 },
      filter: ['==', ['get', 'TOWNCODE'], ''],
    });
    // 空白市場探測：符合條件的鄉鎮金色發光外框（由 feature-state ws 控制）
    addLyr({
      id: 'ws-outline', type: 'line', source: 'towns',
      paint: {
        'line-color': '#e8991f', 'line-width': 2.6, 'line-blur': 0.8,
        'line-opacity': ['case', ['boolean', ['feature-state', 'ws'], false], 0.95, 0],
      },
    });
    // 現勘生活圈緩衝區（空源，落在學校點之下；實際幾何由 updateBuffer 以 setData 更新）
    addSrc('survey-buf', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addLyr({
      id: 'survey-buf-fill', type: 'fill', source: 'survey-buf',
      paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12 },
    });
    addLyr({
      id: 'survey-buf-line', type: 'line', source: 'survey-buf',
      paint: { 'line-color': '#2563eb', 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [2, 1.5] },
    });
    // 幼兒園走暖色，白邊會融進米白底圖，改用深褐描邊
    for (const [id, kind, ramp, dom, stroke, sw] of [
      ['schools-elem', 'e', ELEM_RAMP, ELEM_DOM, '#fff', 0.5],
      ['schools-kinder', 'k', KIN_RAMP, KIN_DOM, 'rgba(61,43,10,0.6)', 0.7]]) {
      addLyr({
        id, type: 'circle', source: 'schools', minzoom: SCHOOL_MINZOOM,
        filter: ['==', ['get', 'k'], kind],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3.4, 12, 4.8, 15, 6.4],
          'circle-color': sizeColor(ramp, dom),
          'circle-stroke-color': stroke, 'circle-stroke-width': sw,
        },
      });
    }

    if (cramGeo) {
      addSrc('cram', { type: 'geojson', data: cramGeo });
      addLyr({
        id: 'cram-dots', type: 'circle', source: 'cram', minzoom: SCHOOL_MINZOOM,
        layout: { visibility: document.getElementById('layerCram').checked ? 'visible' : 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3, 12, 4.5, 15, 6],
          'circle-color': '#5aa23a',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
        },
      });
      bindHover('cram-dots', null, f =>
        `<div class="t-name">${f.properties.n}</div>` +
        `<div class="t-val">補習班（${f.properties.cat}）・${f.properties.c}${f.properties.t}</div>`);
    }

    if (kumonGeo) {
      addSrc('kumon', { type: 'geojson', data: kumonGeo });
      addLyr({
        id: 'kumon-dots', type: 'circle', source: 'kumon', minzoom: SCHOOL_MINZOOM,
        layout: { visibility: document.getElementById('layerKumon').checked ? 'visible' : 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3.5, 12, 5.5, 15, 7],
          'circle-color': '#7DCDF4',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        },
      });
      bindHover('kumon-dots', null, f =>
        `<div class="t-name">${f.properties.n}</div>` +
        `<div class="t-val">KUMON 教室・${f.properties.c}${f.properties.t}</div>`);
    }

    if (meikoGeo) {
      addSrc('meiko', { type: 'geojson', data: meikoGeo });
      addLyr({
        id: 'meiko-dots', type: 'circle', source: 'meiko', minzoom: SCHOOL_MINZOOM,
        layout: { visibility: document.getElementById('layerMeiko').checked ? 'visible' : 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3.5, 12, 5.5, 15, 7],
          'circle-color': '#cb5cf0',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        },
      });
      bindHover('meiko-dots', null, f =>
        `<div class="t-name">${f.properties.n}</div>` +
        `<div class="t-val">明光義塾・${f.properties.c}${f.properties.t}</div>`);
    }

    if (mpmGeo) {
      addSrc('mpm', { type: 'geojson', data: mpmGeo });
      addLyr({
        id: 'mpm-dots', type: 'circle', source: 'mpm', minzoom: SCHOOL_MINZOOM,
        layout: { visibility: document.getElementById('layerMpm').checked ? 'visible' : 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3.5, 12, 5.5, 15, 7],
          'circle-color': '#14b8a6',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        },
      });
      bindHover('mpm-dots', null, f =>
        `<div class="t-name">${/mpm/i.test(f.properties.n) ? f.properties.n : 'MPM ' + f.properties.n}</div>` +
        `<div class="t-val">MPM 數學・${f.properties.c}${f.properties.t}</div>`);
    }

    if (tactGeo) {
      addSrc('tact', { type: 'geojson', data: tactGeo });
      addLyr({
        id: 'tact-dots', type: 'circle', source: 'tact', minzoom: SCHOOL_MINZOOM,
        layout: { visibility: document.getElementById('layerTact').checked ? 'visible' : 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3.5, 12, 5.5, 15, 7],
          'circle-color': '#dc2626',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        },
      });
      bindHover('tact-dots', null, f =>
        `<div class="t-name">${f.properties.n}</div>` +
        `<div class="t-val">台灣拓人・${f.properties.c}${f.properties.t}</div>`);
    }

    // 大量大頭針用 symbol layer（GPU 貼圖），tooltip 內容預存於 tip 屬性
    addSrc('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addLyr({
      id: 'pins-sym', type: 'symbol', source: 'pins',
      layout: {
        'icon-image': ['get', 'img'], 'icon-anchor': 'bottom',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    loadPinImages();
    bindHover('pins-sym', null, f => f.properties.tip);

    // 高階主管：點鄉鎮時顯示該區各品牌據點（空源，selectExecTown 以 setData 填入）
    addSrc('exec-comp', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addLyr({
      id: 'exec-comp-dots', type: 'circle', source: 'exec-comp',
      layout: { visibility: 'none', 'circle-sort-key': ['get', 'pri'] }, // pri 越大越上層，KUMON 在最上
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 6, 15, 8],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': 'rgba(45,50,58,0.55)', 'circle-stroke-width': 1.2,
      },
    });
    bindHover('exec-comp-dots', null, f =>
      `<div class="t-name">${f.properties.n}</div><div class="t-val">${f.properties.brand}</div>`);

    bindHover('towns-fill', 'towns', f => {
      const code = f.properties.TOWNCODE;
      if (roleMode === 'exec') {
        const r = execRowByCode.get(code), role = execRole.get(code);
        const tag = role === 1 ? '<span style="color:#3a8c5f">・拓荒潛力</span>'
          : role === -1 ? '<span style="color:#c0483a">・飽和警戒</span>' : '';
        return `<div class="t-name">${f.properties.COUNTYNAME}${f.properties.TOWNNAME}${tag}</div>` +
          (r ? `<div class="t-val">學齡兒童 ${fmtCount(r.schoolAge)}・自家 ${r.own}・補教 ${r.mkt} 家</div>` : '');
      }
      const t = pop.towns[code];
      const v = valueOf(code);
      const extra = theme === 'income'
        ? (income.towns[code] ? `<div class="t-val">納稅戶數：${fmtCount(income.towns[code][0])}</div>` : '')
        : (t ? `<div class="t-val">總人口：${fmtCount(t.total)}</div>` : '');
      return `<div class="t-name">${f.properties.COUNTYNAME}${f.properties.TOWNNAME}</div>` +
        `<div class="t-val">${bandLabel()}：${v == null ? '—' : fmt(v)}</div>` + extra;
    });
    bindHover('schools-elem', null, schoolTip('國小'));
    bindHover('schools-kinder', null, schoolTip('幼兒園'));

    map.on('click', ev => {
      if (placeMode) return; // 放置勘查點模式下，點擊只放針、不選鄉鎮
      if (roleMode === 'exec') { // 高階主管模式：點鄉鎮看現況
        const fs = map.queryRenderedFeatures(ev.point, { layers: ['towns-fill'] });
        if (fs.length) selectExecTown(fs[0].properties.TOWNCODE);
        return;
      }
      const layers = ['towns-fill'];
      if (map.getLayer('villages-fill')) layers.push('villages-fill');
      const fs = map.queryRenderedFeatures(ev.point, { layers });
      if (!fs.length) return deselect();
      const code = fs[0].properties.TOWNCODE;
      const t = towns.find(f => f.properties.TOWNCODE === code);
      if (t) selectTown(t);
    });

    repaint();
    updateSchoolFilters();
    inited = true; // 全部成功才標記，失敗由 styledata 重試
    map.triggerRepaint();
  }
  const tryInit = () => { if (!inited) { try { initLayers(); } catch (e) { /* style 未 ready，稍後重試 */ } } };
  map.on('styledata', tryInit); // 正常路徑
  const initPoll = setInterval(() => { // 隱藏分頁時 styledata 不觸發，輪詢兜底
    if (inited) return clearInterval(initPoll);
    tryInit();
  }, 100);
  tryInit();

  function schoolTip(label) {
    return f => {
      const p = f.properties;
      const c = p.cnt == null ? '' : +p.cnt;
      let extra = '';
      if (label === '國小' && c !== '') {
        const per = p.cl > 0 ? Math.round(c / p.cl) : null;
        extra = `<div class="t-cnt">學生 ${c.toLocaleString()} 人${p.cl ? ` ・ ${p.cl} 班` : ''}${per ? ` ・ 平均 ${per} 人/班` : ''}` +
          ` ${tierBadge(c, ELEM_BINS, ELEM_TIERS, ELEM_RAMP)}</div>`;
      } else if (label !== '國小' && c !== '' && c > 0) {
        extra = `<div class="t-cnt">核定招收 ${c.toLocaleString()} 人 ${tierBadge(c, KIN_BINS, KIN_TIERS, KIN_RAMP)}</div>`;
      }
      return `<div class="t-name">${p.n}</div>` +
        `<div class="t-val">${label}（${p.pub}）・${p.c}${p.t}</div>` + extra;
    };
  }

  // ---- tooltip / hover ----
  // 單一 mousemove 分派器：取畫面最上層的 feature 決定 tooltip。
  // （不能各圖層各自監聽——後註冊的會蓋掉先註冊的，大頭針/學校點會被村里層蓋掉）
  const tooltip = document.getElementById('tooltip');
  let hovered = null; // {source, id}
  const hoverConfigs = []; // {layerId, stateSource, html}
  function clearHover() {
    if (hovered) map.setFeatureState(hovered, { hover: false });
    hovered = null;
  }
  function bindHover(layerId, stateSource, html) {
    hoverConfigs.push({ layerId, stateSource, html });
  }
  function hideTooltip() {
    clearHover();
    map.getCanvas().style.cursor = '';
    tooltip.hidden = true;
  }
  map.on('mousemove', ev => {
    const layers = hoverConfigs.map(c => c.layerId).filter(id => map.getLayer(id));
    if (!layers.length) return;
    const fs = map.queryRenderedFeatures(ev.point, { layers });
    if (!fs.length) return hideTooltip();
    const f = fs[0]; // queryRenderedFeatures 由上往下排序，[0] 即最上層
    const cfg = hoverConfigs.find(c => c.layerId === f.layer.id);
    if (cfg.stateSource) {
      if (!hovered || hovered.id !== f.id || hovered.source !== cfg.stateSource) {
        clearHover();
        hovered = { source: cfg.stateSource, id: f.id };
        map.setFeatureState(hovered, { hover: true });
      }
    } else clearHover();
    map.getCanvas().style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.style.left = (ev.originalEvent.pageX + 14) + 'px';
    tooltip.style.top = (ev.originalEvent.pageY + 10) + 'px';
    tooltip.innerHTML = cfg.html(f);
  });
  map.on('mouseout', hideTooltip);

  // ---- 著色（feature-state + 表達式）----
  function repaint() {
    domT = makeDomain(towns.map(f => valueOf(f.properties.TOWNCODE)));
    map.setPaintProperty('towns-fill', 'fill-color', colorExpr(domT));
    for (const f of towns) {
      const code = f.properties.TOWNCODE;
      const v = valueOf(code);
      map.setFeatureState({ source: 'towns', id: code }, { v: v == null ? MISS : v });
    }
    if (villFeats) repaintVillages();
    drawLegend(villMode() && domV ? domV : domT);
    if (selectedCode) renderDetail(selectedCode);
  }

  // ---- 村里層（lazy load）----
  let villFeats = null, villLoading = false, popVill = null;
  const villMode = () =>
    map.getZoom() >= VILL_MINZOOM && villFeats && document.getElementById('layerVill').checked;
  const valueOfVill = code => {
    if (theme === 'income') {
      const v = incomeV.villages[code];
      return v ? v[incMetric === 'med' ? 2 : 1] : null;
    }
    const v = popVill && popVill[code];
    if (!v) return null;
    const n = sumBand(v.a, band.min, band.max);
    if (metric !== 'share') return n;
    const ct = countyTotals[code.slice(0, 5)];
    return ct ? n / ct : 0;
  };

  async function ensureVillages() {
    if (villFeats || villLoading) return;
    villLoading = true;
    document.getElementById('villLoading').hidden = false;
    try {
      const [vt, pv] = await Promise.all([
        fetch('villages-10t.json').then(r => r.json()),
        fetch('population_villages.json').then(r => r.json()),
      ]);
      const geo = topojson.feature(vt, vt.objects.villages);
      villFeats = geo.features;
      popVill = pv.villages;
      map.addSource('villages', { type: 'geojson', data: geo, promoteId: 'VILLCODE' });
      map.addLayer({
        id: 'villages-fill', type: 'fill', source: 'villages',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ececec', 'fill-opacity': fillOpacity() },
      }, 'towns-fill');
      map.addLayer({
        id: 'villages-hover', type: 'fill', source: 'villages',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#3d4148', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.10, 0] },
      }, 'towns-fill');
      map.addLayer({
        id: 'villages-line', type: 'line', source: 'villages',
        layout: { visibility: 'none' },
        paint: { 'line-color': 'rgba(255,255,255,0.7)', 'line-width': 0.4 },
      }, 'towns-fill');
      bindHover('villages-fill', 'villages', f => {
        const p2 = f.properties;
        const v = valueOfVill(p2.VILLCODE);
        const raw = popVill[p2.VILLCODE];
        const inc = incomeV.villages[p2.VILLCODE];
        const extra = theme === 'income'
          ? (inc ? `<div class="t-val">納稅戶數：${fmtCount(inc[0])}</div>` : '')
          : (raw ? `<div class="t-val">總人口：${fmtCount(raw.t)}</div>` : '');
        return `<div class="t-name">${p2.COUNTYNAME}${p2.TOWNNAME} ${p2.VILLNAME}</div>` +
          `<div class="t-val">${bandLabel()}：${v == null ? '—' : fmt(v)}</div>` + extra;
      });
      repaintVillages();
      updateLevel();
    } finally {
      villLoading = false;
      document.getElementById('villLoading').hidden = true;
    }
  }

  function repaintVillages() {
    domV = makeDomain(villFeats.map(f => valueOfVill(f.properties.VILLCODE)));
    map.setPaintProperty('villages-fill', 'fill-color', colorExpr(domV));
    for (const f of villFeats) {
      const code = f.properties.VILLCODE;
      const v = valueOfVill(code);
      map.setFeatureState({ source: 'villages', id: code }, { v: v == null ? MISS : v });
    }
  }

  function updateLevel() {
    if (roleMode === 'exec') { // 高階主管模式固定用鄉鎮著色，不切村里
      if (map.getLayer('villages-fill'))
        for (const id of ['villages-fill', 'villages-hover', 'villages-line'])
          map.setLayoutProperty(id, 'visibility', 'none');
      map.setLayoutProperty('towns-fill', 'visibility', 'visible');
      map.setLayoutProperty('towns-hover', 'visibility', 'visible');
      return;
    }
    if (map.getZoom() >= VILL_MINZOOM && document.getElementById('layerVill').checked) ensureVillages();
    const useVill = !!villMode();
    if (map.getLayer('villages-fill')) {
      for (const id of ['villages-fill', 'villages-hover', 'villages-line'])
        map.setLayoutProperty(id, 'visibility', useVill ? 'visible' : 'none');
    }
    map.setLayoutProperty('towns-fill', 'visibility', useVill ? 'none' : 'visible');
    map.setLayoutProperty('towns-hover', 'visibility', useVill ? 'none' : 'visible');
    map.setPaintProperty('towns-line', 'line-width', useVill ? 1.2 : 0.7);
    drawLegend(useVill && domV ? domV : domT);
  }
  document.getElementById('layerVill').addEventListener('change', updateLevel);

  let lastVillState = false;
  map.on('zoom', () => {
    const cross = (map.getZoom() >= VILL_MINZOOM);
    if (cross !== lastVillState) { lastVillState = cross; updateLevel(); }
    else if (cross && !villFeats) ensureVillages();
    document.getElementById('zoomHint').hidden = map.getZoom() >= SCHOOL_MINZOOM || pinsShown;
  });

  // ---- 學校圖層開關與過濾 ----
  function updateSchoolFilters() {
    if (!map.getLayer('schools-elem')) return;
    for (const [id, kind, chk] of [['schools-elem', 'e', 'layerElem'], ['schools-kinder', 'k', 'layerKinder']]) {
      const on = document.getElementById(chk).checked;
      map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      const conds = [['==', ['get', 'k'], kind]];
      if (pinsShown && pinScope) { // 已用大頭針呈現的不畫圓點
        conds.push(pinScope.type === 'town'
          ? ['!=', ['concat', ['get', 'c'], ['get', 't']], pinScope.key]
          : ['!=', ['get', 'c'], pinScope.key]);
      }
      map.setFilter(id, ['all', ...conds]);
    }
    document.getElementById('zoomHint').hidden = map.getZoom() >= SCHOOL_MINZOOM || pinsShown;
  }
  document.getElementById('layerElem').addEventListener('change', () => { renderPins(false); });
  document.getElementById('layerKinder').addEventListener('change', () => { renderPins(false); });
  document.getElementById('layerCram').addEventListener('change', ev => {
    if (map.getLayer('cram-dots'))
      map.setLayoutProperty('cram-dots', 'visibility', ev.target.checked ? 'visible' : 'none');
  });
  document.getElementById('layerKumon').addEventListener('change', ev => {
    if (map.getLayer('kumon-dots'))
      map.setLayoutProperty('kumon-dots', 'visibility', ev.target.checked ? 'visible' : 'none');
  });

  document.getElementById('layerMeiko').addEventListener('change', ev => {
    if (map.getLayer('meiko-dots'))
      map.setLayoutProperty('meiko-dots', 'visibility', ev.target.checked ? 'visible' : 'none');
  });

  document.getElementById('layerMpm').addEventListener('change', ev => {
    if (map.getLayer('mpm-dots'))
      map.setLayoutProperty('mpm-dots', 'visibility', ev.target.checked ? 'visible' : 'none');
  });

  document.getElementById('layerTact').addEventListener('change', ev => {
    if (map.getLayer('tact-dots'))
      map.setLayoutProperty('tact-dots', 'visibility', ev.target.checked ? 'visible' : 'none');
  });

  // ---- 大頭針（HTML Marker，保留立體造型與落下動畫）----
  const PIN_HEAD = { elem: ['#86b5db', '#285a8c', '#14375a'], kinder: ['#ffd98a', '#c98a00', '#6b4200'] };
  const PIN_COLLAR = { elem: '#1d4771', kinder: '#6b4a00' };
  const headStops = ([a, b, c]) =>
    `<stop offset="0%" stop-color="${a}"/><stop offset="55%" stop-color="${b}"/><stop offset="100%" stop-color="${c}"/>`;
  // 對半針（國小＋附幼）頭部放大到 8.2，單色針維持 7.2
  // 左右兩半要共用同一道球面光，所以改用 userSpaceOnUse（bbox 35%/30%/75% 依 r=8.2 換算）
  const HEAD_LIGHT = 'gradientUnits="userSpaceOnUse" cx="-2.46" cy="-25.28" r="12.3"';
  const HEAD_RIGHT = 'M0,-30.2 A8.2,8.2 0 0 1 0,-13.8 Z'; // 頭部右半（cy -22, r 8.2）
  const GLOSS = both => both
    ? 'cx="-2.7" cy="-25.4" rx="2.6" ry="1.7"'
    : 'cx="-2.4" cy="-25" rx="2.3" ry="1.5"';
  const defsHost = document.createElement('div');
  defsHost.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs>
    ${Object.entries(PIN_HEAD).map(([k, c]) => {
      const id = k === 'elem' ? 'pinElem' : 'pinKinder';
      return `<radialGradient id="${id}" cx="35%" cy="30%" r="75%">${headStops(c)}</radialGradient>
        <radialGradient id="${id}U" ${HEAD_LIGHT}>${headStops(c)}</radialGradient>`;
    }).join('')}
    <linearGradient id="pinBothCollar" x1="0" x2="1" y1="0" y2="0">
      <stop offset="50%" stop-color="${PIN_COLLAR.elem}"/>
      <stop offset="50%" stop-color="${PIN_COLLAR.kinder}"/></linearGradient>
    <linearGradient id="pinNeedle" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%" stop-color="#c9cdd2"/><stop offset="45%" stop-color="#f2f4f6"/>
      <stop offset="100%" stop-color="#8d9298"/></linearGradient>
  </defs></svg>`;
  document.body.appendChild(defsHost);

  // 貼圖版大頭針（symbol layer 用；把同款 SVG 烙成 2x 點陣圖）
  let pinImgReady = false;
  function pinSpriteSVG(head, collar, head2) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="40" viewBox="-13 -36 26 40">
      <defs>
        <radialGradient id="h" ${head2 ? HEAD_LIGHT : 'cx="35%" cy="30%" r="75%"'}>${headStops(head)}</radialGradient>
        ${head2 ? `<radialGradient id="h2" ${HEAD_LIGHT}>${headStops(head2)}</radialGradient>
        <linearGradient id="c" x1="0" x2="1" y1="0" y2="0">
          <stop offset="50%" stop-color="${PIN_COLLAR.elem}"/>
          <stop offset="50%" stop-color="${PIN_COLLAR.kinder}"/></linearGradient>` : ''}
        <linearGradient id="n" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#c9cdd2"/><stop offset="45%" stop-color="#f2f4f6"/>
          <stop offset="100%" stop-color="#8d9298"/></linearGradient>
      </defs>
      <ellipse cx="1.5" cy="0.6" rx="5" ry="1.8" fill="rgba(61,65,72,0.28)"/>
      <path d="M0,0 L-1.2,-13 L1.2,-13 Z" fill="url(#n)"/>
      <rect x="-3.2" y="-16.6" width="6.4" height="4.2" rx="1.6" fill="${head2 ? 'url(#c)' : collar}"/>
      <circle cy="-22" r="${head2 ? 8.2 : 7.2}" fill="url(#h)" stroke="rgba(255,255,255,0.55)" stroke-width="0.6"/>
      ${head2 ? `<path d="${HEAD_RIGHT}" fill="url(#h2)"/>
      <line x1="0" y1="-30.2" x2="0" y2="-13.8" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>` : ''}
      <ellipse ${GLOSS(head2)} fill="rgba(255,255,255,0.75)"/>
    </svg>`;
  }
  function loadPinImages() {
    const variants = {
      'pin-elem': [PIN_HEAD.elem, PIN_COLLAR.elem],
      'pin-kinder': [PIN_HEAD.kinder, PIN_COLLAR.kinder],
      'pin-both': [PIN_HEAD.elem, null, PIN_HEAD.kinder],
    };
    let n = 0;
    for (const [name, c] of Object.entries(variants)) {
      const img = new Image(52, 80);
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = 52; cv.height = 80;
        cv.getContext('2d').drawImage(img, 0, 0, 52, 80);
        map.addImage(name, cv.getContext('2d').getImageData(0, 0, 52, 80), { pixelRatio: 2 });
        if (++n === 3) pinImgReady = true;
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pinSpriteSVG(...c));
    }
  }

  let markers = [];
  function clearPins() {
    for (const m of markers) m.remove();
    markers = [];
    if (map.getSource('pins')) map.getSource('pins').setData({ type: 'FeatureCollection', features: [] });
    pinsShown = false;
  }
  function pinElement(cls, delay) {
    // both：左半國小藍、右半幼兒園黃（共用同一道球面光）
    const head = cls === 'both'
      ? `<circle class="pin-head" cy="-22" r="8.2" fill="url(#pinElemU)"/>
         <path d="${HEAD_RIGHT}" fill="url(#pinKinderU)"/>
         <line class="pin-split" x1="0" y1="-30.2" x2="0" y2="-13.8"/>`
      : `<circle class="pin-head" cy="-22" r="7.2" fill="url(#${cls === 'elem' ? 'pinElem' : 'pinKinder'})"/>`;
    const el = document.createElement('div');
    el.className = 'pin ' + cls;
    el.innerHTML = `<svg width="26" height="40" viewBox="-13 -36 26 40" style="--d:${delay}ms">
      <ellipse class="pin-shadow" cx="1.5" cy="0.6" rx="5" ry="1.8"/>
      <g class="pin-body">
        <path d="M0,0 L-1.2,-13 L1.2,-13 Z" fill="url(#pinNeedle)"/>
        <rect class="pin-collar" x="-3.2" y="-16.6" width="6.4" height="4.2" rx="1.6"/>
        ${head}
        <ellipse class="pin-gloss" ${GLOSS(cls === 'both')}/>
      </g></svg>`;
    return el;
  }
  function renderPins(animate = true) {
    clearPins();
    if (roleMode === 'exec') return; // 高階主管模式不畫學校大頭針
    if (pinScope) {
      const test = pinScope.type === 'town'
        ? s => normTW(s[4] + s[5]) === pinScope.key
        : s => normTW(s[4]) === pinScope.key;
      const items = [];
      if (document.getElementById('layerElem').checked)
        for (const s of schools.elem) if (test(s)) items.push({ s, cls: 'elem' });
      if (document.getElementById('layerKinder').checked)
        for (const s of schools.kinder) if (test(s)) items.push({ s, cls: 'kinder' });
      // 同座標合併（國小＋附幼 → 藍黃對半針）
      const byCoord = new Map();
      for (const it of items) {
        const key = it.s[1] + ',' + it.s[2];
        if (!byCoord.has(key)) byCoord.set(key, []);
        byCoord.get(key).push(it);
      }
      const rows = [];
      for (const arr of byCoord.values()) {
        const hasE = arr.some(x => x.cls === 'elem'), hasK = arr.some(x => x.cls === 'kinder');
        rows.push({ items: arr, s: arr[0].s, cls: hasE && hasK ? 'both' : arr[0].cls });
      }
      const typeLabel = it => it.cls === 'elem' ? '國小' : '幼兒園';
      const tipOf = d =>
        d.items.map(it => {
          const cnt = it.s[7];
          const num = cnt == null ? '' : it.cls === 'elem'
            ? ` <span class="t-num">${(+cnt).toLocaleString()} 生</span>`
            : (cnt > 0 ? ` <span class="t-num">核定 ${cnt}</span>` : '');
          return `<div class="t-name">${it.s[0]}<span class="t-tag">${typeLabel(it)}</span>${num}</div>`;
        }).join('') +
        `<div class="t-val">${d.cls === 'both' ? '國小＋附設幼兒園（同址）・' : `（${d.s[3]}）・`}${d.s[4]}${d.s[5]}</div>`;
      if (rows.length && rows.length <= HTML_PINS_MAX) {
        // 少量：HTML Marker，逐支錯落落下
        rows.forEach((d, i) => {
          const delay = animate ? Math.min(i * 2.5, 500) + Math.random() * 120 : 0;
          const el = pinElement(d.cls, delay);
          if (!animate) el.classList.add('no-anim');
          el.addEventListener('mousemove', ev => {
            tooltip.hidden = false;
            tooltip.style.left = (ev.pageX + 14) + 'px';
            tooltip.style.top = (ev.pageY + 10) + 'px';
            tooltip.innerHTML = tipOf(d);
          });
          el.addEventListener('mouseleave', () => { tooltip.hidden = true; });
          markers.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 4] })
            .setLngLat([d.s[2], d.s[1]]).addTo(map));
        });
        pinsShown = true;
      } else if (rows.length && (!map.getSource('pins') || !pinImgReady)) {
        setTimeout(() => renderPins(animate), 300); // 貼圖/圖層尚未就緒，稍後重試
        return;
      } else if (rows.length) {
        // 大量（縣市級）：GPU symbol layer，全體落下過場
        map.getSource('pins').setData({
          type: 'FeatureCollection',
          features: rows.map(d => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [d.s[2], d.s[1]] },
            properties: { img: 'pin-' + d.cls, tip: tipOf(d) },
          })),
        });
        if (animate) {
          map.setPaintProperty('pins-sym', 'icon-translate-transition', { duration: 0 });
          map.setPaintProperty('pins-sym', 'icon-translate', [0, -46]);
          map.setPaintProperty('pins-sym', 'icon-opacity-transition', { duration: 0 });
          map.setPaintProperty('pins-sym', 'icon-opacity', 0);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            map.setPaintProperty('pins-sym', 'icon-translate-transition', { duration: 450 });
            map.setPaintProperty('pins-sym', 'icon-translate', [0, 0]);
            map.setPaintProperty('pins-sym', 'icon-opacity-transition', { duration: 250 });
            map.setPaintProperty('pins-sym', 'icon-opacity', 1);
          }));
        } else {
          map.setPaintProperty('pins-sym', 'icon-translate-transition', { duration: 0 });
          map.setPaintProperty('pins-sym', 'icon-translate', [0, 0]);
          map.setPaintProperty('pins-sym', 'icon-opacity-transition', { duration: 0 });
          map.setPaintProperty('pins-sym', 'icon-opacity', 1);
        }
        pinsShown = true;
      }
    }
    updateSchoolFilters();
  }
  function setPinScope(scope) {
    pinScope = scope;
    renderPins(true);
  }

  // ---- 選取 / 縮放 ----
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

  function selectTown(f) {
    selectedCode = f.properties.TOWNCODE;
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], selectedCode]);
    map.fitBounds(bboxOf([f]), { padding: 70, maxZoom: 13, duration: 650 });
    renderDetail(selectedCode, f);
    document.getElementById('detail').hidden = false;
    setPinScope({ type: 'town', key: normTW(f.properties.COUNTYNAME + f.properties.TOWNNAME) });
  }
  function deselect() {
    selectedCode = null;
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    document.getElementById('detail').hidden = true;
    const c = document.getElementById('countySel').value;
    setPinScope(c ? { type: 'county', key: normTW(c) } : null);
  }

  // ---- 詳細面板 ----
  function renderDetail(code, feature) {
    const t = pop.towns[code];
    if (!t) return;
    const d = feature || towns.find(f => f.properties.TOWNCODE === code);
    document.getElementById('dName').textContent = d.properties.COUNTYNAME + d.properties.TOWNNAME;
    const n = sumBand(t.ages, band.min, band.max);
    if (theme === 'income') {
      const iv = income.towns[code];
      document.getElementById('dTotalLab').textContent = '納稅戶數';
      document.getElementById('dBandLab').textContent = '所得中位數';
      document.getElementById('dShareLab').textContent = '所得平均數';
      document.getElementById('dTotal').textContent = iv ? fmtCount(iv[0]) : '—';
      document.getElementById('dBand').textContent = iv ? fmtIncome(iv[2]) : '—';
      document.getElementById('dShare').textContent = iv ? fmtIncome(iv[1]) : '—';
    } else {
      document.getElementById('dTotalLab').textContent = '總人口';
      document.getElementById('dShareLab').textContent = '占比';
      document.getElementById('dTotal').textContent = fmtCount(t.total);
      document.getElementById('dBand').textContent = fmtCount(n);
      document.getElementById('dBandLab').textContent = bandLabel();
      document.getElementById('dShare').textContent = t.total ? fmtShare(n / t.total) : '—';
    }

    const fullName = t.name;
    const inTown = rows => rows.filter(s => (s[4] + s[5]) === fullName.replace(/臺/g, '台') || (s[4] + s[5]) === fullName).length;
    document.getElementById('dElem').textContent = inTown(schools.elem) + ' 所';
    document.getElementById('dKinder').textContent = inTown(schools.kinder) + ' 所';

    const hist = d3.select('#hist');
    hist.selectAll('*').remove();
    const hw = 280, hh = 78, bw = hw / 101;
    const max = d3.max(t.ages) || 1;
    hist.selectAll('rect').data(t.ages).join('rect')
      .attr('class', (v, i) => 'bar' + (i >= band.min && i <= band.max ? ' in-band' : ''))
      .attr('x', (v, i) => i * bw)
      .attr('width', Math.max(1, bw - 0.6))
      .attr('y', v => hh - (v / max) * hh)
      .attr('height', v => Math.max(0.5, (v / max) * hh));
    hist.append('g').selectAll('text').data([0, 20, 40, 60, 80, 100]).join('text')
      .attr('x', a => a * bw).attr('y', 89)
      .attr('font-size', 9).attr('fill', '#8a8f98')
      .text(a => a);

    renderSchoolTab(code);
    renderCompTab(code);
  }

  // ---- 詳情多頁籤：學校學區 / 補教競品 ----
  // 品牌：label, 資料, 縣市欄, 鄉鎮欄, 顏色（cram 欄位不同）
  const DRAWER_BRANDS = [['KUMON', kumon, 3, 4, '#7DCDF4'], ['明光義塾', meiko, 3, 4, '#cb5cf0'],
    ['MPM 數學', mpm, 3, 4, '#14b8a6'], ['台灣拓人', tact, 3, 4, '#dc2626'], ['補習班', cram, 4, 5, '#5aa23a']];
  function renderSchoolTab(code) {
    const t = pop.towns[code];
    const key = normTW(t ? t.name : '');
    const elems = schools.elem.filter(s => normTW(s[4] + s[5]) === key)
      .map(s => ({ n: s[0], cnt: +s[7] || 0 })).sort((a, b) => b.cnt - a.cnt);
    const kinders = schools.kinder.filter(s => normTW(s[4] + s[5]) === key)
      .map(s => ({ n: s[0], cap: +s[7] || 0 }));
    const elemList = elems.map(e =>
      `<div class="tl-item"><span class="tl-n">${e.n}</span>` +
      `<span class="tl-x">${e.cnt ? e.cnt.toLocaleString() + ' 生' : '—'} ${tierBadge(e.cnt, ELEM_BINS, ELEM_TIERS, ELEM_RAMP)}</span></div>`).join('')
      || '<div class="tl-empty">此區無國小資料</div>';
    const kinderList = kinders.map(k =>
      `<div class="tl-item"><span class="tl-n">${k.n}</span>` +
      `<span class="tl-x">${k.cap ? '核定 ' + k.cap : ''}</span></div>`).join('')
      || '<div class="tl-empty">此區無幼兒園資料</div>';
    document.getElementById('tabSchool').innerHTML =
      `<div class="tl-sec">國小（${elems.length}）· 依學生數排序</div><div class="tl-list">${elemList}</div>` +
      `<div class="tl-sec">幼兒園（${kinders.length}）</div><div class="tl-list">${kinderList}</div>`;
  }
  function renderCompTab(code) {
    const t = pop.towns[code];
    const key = normTW(t ? t.name : '');
    let html = '', any = false;
    for (const [label, data, ci, ti, color] of DRAWER_BRANDS) {
      if (!data || !data.rows) continue;
      const names = data.rows.filter(r => normTW((r[ci] || '') + (r[ti] || '')) === key).map(r => r[0]);
      if (names.length) any = true;
      html += `<div class="cb-head"><span class="dot" style="background:${color}"></span>${label} <span class="cb-n">${names.length}</span></div>` +
        (names.length ? `<div class="cb-names">${names.map(n => `<span>${n}</span>`).join('')}</div>` : '');
    }
    document.getElementById('tabComp').innerHTML = any ? html : '<div class="tl-empty">此區無補教資料</div>';
  }
  // 詳情頁籤切換
  document.querySelectorAll('#detailTabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#detailTabs button').forEach(x => x.classList.toggle('active', x === b));
      const tab = b.dataset.tab;
      document.getElementById('tabPop').hidden = tab !== 'pop';
      document.getElementById('tabSchool').hidden = tab !== 'school';
      document.getElementById('tabComp').hidden = tab !== 'comp';
    });
  });

  // ---- 底圖開關 ----
  document.getElementById('layerRoad').addEventListener('change', () => {
    map.setLayoutProperty('emap', 'visibility', roadOn() ? 'visible' : 'none');
    map.setPaintProperty('towns-fill', 'fill-opacity', fillOpacity());
    if (map.getLayer('villages-fill')) map.setPaintProperty('villages-fill', 'fill-opacity', fillOpacity());
  });

  // ---- 控制列 ----
  const bandsDiv = document.getElementById('bands');
  BANDS.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (i === 0) btn.classList.add('active');
    btn.addEventListener('click', () => {
      band = { min: b.min, max: b.max };
      document.getElementById('ageMin').value = b.min;
      document.getElementById('ageMax').value = b.max;
      bandsDiv.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      repaint();
    });
    bandsDiv.appendChild(btn);
  });

  function customRange() {
    let lo = Math.max(0, Math.min(100, +document.getElementById('ageMin').value || 0));
    let hi = Math.max(0, Math.min(100, +document.getElementById('ageMax').value || 100));
    if (lo > hi) [lo, hi] = [hi, lo];
    band = { min: lo, max: hi };
    bandsDiv.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    repaint();
  }
  document.getElementById('ageMin').addEventListener('change', customRange);
  document.getElementById('ageMax').addEventListener('change', customRange);

  document.getElementById('metric').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      metric = btn.dataset.m;
      document.querySelectorAll('#metric button').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      repaint();
    });
  });
  document.getElementById('theme').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      theme = btn.dataset.t;
      document.querySelectorAll('#theme button').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('ageSection').classList.toggle('disabled', theme === 'income');
      document.getElementById('metric').hidden = theme === 'income';
      document.getElementById('metricIncome').hidden = theme !== 'income';
      repaint();
    });
  });
  document.getElementById('metricIncome').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      incMetric = btn.dataset.m;
      document.querySelectorAll('#metricIncome button').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      repaint();
    });
  });

  // 縣市選單（北→南，離島最後）
  const COUNTY_ORDER = ['基隆市', '台北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
    '台中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣',
    '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'];
  const orderOf = c => { const i = COUNTY_ORDER.indexOf(normTW(c)); return i < 0 ? 99 : i; };
  const counties = [...new Set(towns.map(f => f.properties.COUNTYNAME))]
    .sort((a, b) => orderOf(a) - orderOf(b));
  const sel = document.getElementById('countySel');
  counties.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    if (!sel.value) return resetView();
    selectedCode = null;
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    document.getElementById('detail').hidden = true;
    const fs = towns.filter(f => f.properties.COUNTYNAME === sel.value);
    map.fitBounds(bboxOf(fs), { padding: 70, maxZoom: 11.5, duration: 650 });
    setPinScope({ type: 'county', key: normTW(sel.value) });
  });

  function resetView() {
    sel.value = '';
    deselect();
    map.fitBounds(TAIWAN_BOUNDS, { padding: 40, duration: 650 });
  }
  document.getElementById('resetBtn').addEventListener('click', resetView);

  // ---- 空白市場探測 ----
  // 排除的競品只列自家四品牌（補習班 cram 遍地都是，當「無競爭」沒意義）
  const WS_NAMED = [['KUMON', kumon, 3, 4], ['明光義塾', meiko, 3, 4], ['MPM 數學', mpm, 3, 4], ['台灣拓人', tact, 3, 4]];
  let townCentroids = null;
  function ensureCentroids() {
    if (townCentroids) return;
    townCentroids = new Map();
    for (const f of towns) {
      let c;
      try { c = turf.centroid(f).geometry.coordinates; }
      catch { const b = bboxOf([f]); c = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]; }
      townCentroids.set(f.properties.TOWNCODE, c);
    }
  }
  function wsBrandPoints(key) {
    const list = key === 'any' ? WS_NAMED : WS_NAMED.filter(b => b[0] === key);
    const pts = [];
    for (const [, data] of list) {
      if (!data || !data.rows) continue;
      for (const r of data.rows) if (isFinite(r[1]) && isFinite(r[2])) pts.push([r[2], r[1]]);
    }
    return pts;
  }
  function runWhiteSpace() {
    ensureCentroids();
    const minAge = +document.getElementById('wsAge').value || 0;
    const minIncRaw = (+document.getElementById('wsInc').value || 0) * 10; // 使用者填「萬」，內部值/10=萬
    const brandKey = document.getElementById('wsBrand').value;
    const radiusKm = +document.getElementById('wsRadius').value || 1.5;
    const rDeg = radiusKm / 100; // 粗略外框先濾遠點，再算真實距離
    const pts = wsBrandPoints(brandKey);
    const hits = [];
    for (const f of towns) {
      const code = f.properties.TOWNCODE;
      const t = pop.towns[code];
      let ok = false;
      if (t) {
        const schoolAge = sumBand(t.ages, 3, 12);
        const iv = income.towns[code];
        const incMed = iv ? iv[2] : 0;
        if (schoolAge >= minAge && (minIncRaw <= 0 || incMed >= minIncRaw)) {
          const c = townCentroids.get(code);
          let near = false;
          for (const p of pts) {
            if (Math.abs(p[0] - c[0]) > rDeg || Math.abs(p[1] - c[1]) > rDeg) continue;
            if (turf.distance(c, p, { units: 'kilometers' }) <= radiusKm) { near = true; break; }
          }
          if (!near) { ok = true; hits.push({ code, name: f.properties.COUNTYNAME + f.properties.TOWNNAME, schoolAge }); }
        }
      }
      map.setFeatureState({ source: 'towns', id: code }, { ws: ok });
    }
    hits.sort((a, b) => b.schoolAge - a.schoolAge);
    const top = hits.slice(0, 10);
    document.getElementById('wsResults').innerHTML =
      `<div class="ws-count">符合 ${hits.length} 區 · Top ${top.length}</div>` +
      (top.map(h => `<div class="ws-item" data-code="${h.code}"><span>${h.name}</span>` +
        `<span class="ws-x">學齡 ${fmtCount(h.schoolAge)}</span></div>`).join('') ||
       '<div class="tl-empty">無符合條件的區</div>');
  }
  function clearWhiteSpace() {
    if (map.getSource('towns')) for (const f of towns) map.setFeatureState({ source: 'towns', id: f.properties.TOWNCODE }, { ws: false });
    const box = document.getElementById('wsResults'); if (box) box.innerHTML = '';
  }
  document.getElementById('wsRun').addEventListener('click', runWhiteSpace);
  document.getElementById('wsClear').addEventListener('click', clearWhiteSpace);
  document.getElementById('wsResults').addEventListener('click', e => {
    const it = e.target.closest('.ws-item'); if (!it) return;
    const f = towns.find(t => t.properties.TOWNCODE === it.dataset.code);
    if (f) selectTown(f);
  });

  // ---- 側邊欄收合 ----
  const sidebarToggle = document.getElementById('sidebarToggle');
  function setSidebar(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggle.textContent = collapsed ? '▶' : '◀';
  }
  const toggleSidebar = () => setSidebar(!document.body.classList.contains('sidebar-collapsed'));
  sidebarToggle.addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', e => {
    if (e.key !== '[') return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return; // 輸入中不觸發
    toggleSidebar();
  });

  // ---- 全域搜尋（行政區 / 學校 / 品牌據點）----
  // 品牌各資料集欄位：kumon/meiko/mpm/tact 為 [名, lat, lng, 縣市, 鄉鎮]；cram 為 [名, lat, lng, 類別, 縣市, 鄉鎮]
  const searchIndex = [];
  for (const f of towns) {
    const p2 = f.properties;
    searchIndex.push({ name: p2.COUNTYNAME + p2.TOWNNAME, tag: '行政區', tagCls: 't-town',
      sub: '', kind: 'town', feature: f, key: normTW(p2.COUNTYNAME + p2.TOWNNAME) });
  }
  for (const [rows, tag, tagCls] of [[schools.elem, '國小', 't-elem'], [schools.kinder, '幼兒園', 't-kinder']]) {
    for (const s of rows) {
      if (!isFinite(s[1]) || !isFinite(s[2])) continue;
      searchIndex.push({ name: s[0], tag, tagCls, sub: normTW((s[4] || '') + (s[5] || '')),
        kind: 'point', lng: s[2], lat: s[1], key: normTW(s[0] || '') });
    }
  }
  for (const [label, data, ci, ti] of [
    ['KUMON', kumon, 3, 4], ['明光義塾', meiko, 3, 4], ['MPM 數學', mpm, 3, 4],
    ['台灣拓人', tact, 3, 4], ['補習班', cram, 4, 5]]) {
    if (!data || !data.rows) continue;
    for (const r of data.rows) {
      if (!isFinite(r[1]) || !isFinite(r[2])) continue;
      searchIndex.push({ name: r[0], tag: label, tagCls: 't-brand', sub: normTW((r[ci] || '') + (r[ti] || '')),
        kind: 'point', lng: r[2], lat: r[1], key: normTW(r[0] || '') });
    }
  }

  const searchInput = document.getElementById('globalSearch');
  const searchBox = document.getElementById('searchResults');
  let searchHits = [], searchActive = -1;

  function runSearch(q) {
    q = normTW(q.trim());
    if (q.length < 1) { searchBox.hidden = true; searchHits = []; return; }
    const starts = [], contains = [];
    for (const it of searchIndex) {
      const i = it.key.indexOf(q);
      if (i === 0) starts.push(it);
      else if (i > 0) contains.push(it);
      if (starts.length >= 40) break;
    }
    searchHits = starts.concat(contains).slice(0, 40);
    searchActive = -1;
    renderSearch();
  }
  function renderSearch() {
    if (!searchHits.length) {
      searchBox.innerHTML = '<div class="search-empty">找不到符合的地點</div>';
      searchBox.hidden = false; return;
    }
    searchBox.innerHTML = searchHits.map((it, i) =>
      `<div class="search-item${i === searchActive ? ' active' : ''}" data-i="${i}">` +
      `<span class="s-tag ${it.tagCls}">${it.tag}</span>` +
      `<span class="s-name">${it.name}</span>` +
      (it.sub ? `<span class="s-sub">${it.sub}</span>` : '') + '</div>').join('');
    searchBox.hidden = false;
  }
  function chooseHit(it) {
    if (!it) return;
    searchBox.hidden = true;
    searchInput.value = it.name;
    if (it.kind === 'town') {
      selectTown(it.feature);
    } else {
      map.flyTo({ center: [it.lng, it.lat], zoom: 15, duration: 800 });
      map.once('moveend', () => {
        const pt = map.project([it.lng, it.lat]);
        const rect = map.getCanvas().getBoundingClientRect();
        tooltip.hidden = false;
        tooltip.style.left = (rect.left + pt.x + 12) + 'px';
        tooltip.style.top = (rect.top + pt.y + 10) + 'px';
        tooltip.innerHTML = `<div class="t-name">${it.name}</div>` +
          `<div class="t-val">${it.tag}${it.sub ? '・' + it.sub : ''}</div>`;
        setTimeout(() => { tooltip.hidden = true; }, 2600);
      });
    }
  }
  searchInput.addEventListener('input', () => runSearch(searchInput.value));
  searchInput.addEventListener('focus', () => { if (searchInput.value) runSearch(searchInput.value); });
  searchInput.addEventListener('keydown', e => {
    if (searchBox.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); searchActive = Math.min(searchActive + 1, searchHits.length - 1); renderSearch(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); searchActive = Math.max(searchActive - 1, 0); renderSearch(); }
    else if (e.key === 'Enter') { e.preventDefault(); chooseHit(searchHits[searchActive] || searchHits[0]); }
    else if (e.key === 'Escape') { searchBox.hidden = true; searchInput.blur(); }
  });
  searchBox.addEventListener('mousedown', e => {
    const item = e.target.closest('.search-item');
    if (item) { e.preventDefault(); chooseHit(searchHits[+item.dataset.i]); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.nav-search')) searchBox.hidden = true;
  });

  // ---- 現勘勘查點 + 生活圈緩衝區 ----
  let placeMode = false;
  let surveyMarker = null, surveyLngLat = null, surveyRadius = 1000; // 半徑（公尺），預設 1km
  let bufferPoly = null, surveyData = null;
  const BRANDS = [['KUMON', kumon], ['明光義塾', meiko], ['MPM 數學', mpm], ['台灣拓人', tact], ['補習班', cram]];

  function setPlaceMode(on) {
    placeMode = on;
    document.body.classList.toggle('place-mode', on);
    document.getElementById('fabSurvey').classList.toggle('active', on);
  }
  document.getElementById('fabSurvey').addEventListener('click', () => setPlaceMode(!placeMode));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && placeMode) setPlaceMode(false); });

  // 藍色勘查大頭針（HTML Marker，沿用落下動畫；註：WebGL 截圖不含 HTML Marker）
  function surveyPinElement() {
    const el = document.createElement('div');
    el.className = 'pin survey';
    el.innerHTML = `<svg width="30" height="46" viewBox="-15 -42 30 46">
      <ellipse class="pin-shadow" cx="1.5" cy="0.6" rx="6" ry="2"/>
      <g class="pin-body">
        <path d="M0,0 L-1.4,-15 L1.4,-15 Z" fill="url(#pinNeedle)"/>
        <rect class="pin-collar" x="-3.6" y="-19" width="7.2" height="4.6" rx="1.6"/>
        <circle class="pin-head" cy="-25" r="9" fill="#2563eb"/>
        <ellipse class="pin-gloss" cx="-2.8" cy="-28" rx="2.8" ry="1.8"/>
      </g></svg>`;
    return el;
  }

  function updateBuffer() {
    if (!surveyLngLat || !map.getSource('survey-buf')) return;
    bufferPoly = turf.circle([surveyLngLat.lng, surveyLngLat.lat], surveyRadius / 1000, { steps: 72, units: 'kilometers' });
    map.getSource('survey-buf').setData(bufferPoly);
  }

  function runSurveyAnalysis() {
    if (!bufferPoly || !surveyLngLat) return;
    const center = [surveyLngLat.lng, surveyLngLat.lat];
    const inBuf = (lng, lat) => turf.booleanPointInPolygon([lng, lat], bufferPoly);
    const distM = (lng, lat) => Math.round(turf.distance(center, [lng, lat], { units: 'kilometers' }) * 1000);
    const elemHits = [];
    let elemStudents = 0;
    for (const s of schools.elem) {
      if (!isFinite(s[1]) || !isFinite(s[2]) || !inBuf(s[2], s[1])) continue;
      const cnt = +s[7] || 0;
      elemStudents += cnt;
      elemHits.push({ name: s[0], cnt, dist: distM(s[2], s[1]) });
    }
    elemHits.sort((a, b) => a.dist - b.dist);
    let kinderCount = 0;
    for (const s of schools.kinder)
      if (isFinite(s[1]) && isFinite(s[2]) && inBuf(s[2], s[1])) kinderCount++;
    const brandStats = [];
    for (const [label, data] of BRANDS) {
      if (!data || !data.rows) { brandStats.push({ label, count: 0, nearest: null }); continue; }
      let count = 0, nearest = Infinity;
      for (const r of data.rows) {
        if (!isFinite(r[1]) || !isFinite(r[2])) continue;
        const d = distM(r[2], r[1]);
        if (d < nearest) nearest = d;
        if (inBuf(r[2], r[1])) count++;
      }
      brandStats.push({ label, count, nearest: isFinite(nearest) ? nearest : null });
    }
    surveyData = { elemHits, elemStudents, kinderCount, brandStats };
    renderSurvey();
  }

  function renderSurvey() {
    const d = surveyData; if (!d) return;
    const list = d.elemHits.slice(0, 15).map(h =>
      `<div class="sv-item"><span class="sv-n">${h.name}</span>` +
      `<span class="sv-x">${h.cnt ? h.cnt + '生' : '—'} ・ ${h.dist}m</span></div>`).join('')
      || '<div class="sv-empty">生活圈內無國小</div>';
    const brands = d.brandStats.map(b =>
      `<div class="sv-brand"><span>${b.label}</span>` +
      `<span>${b.nearest == null ? '—' : b.nearest + 'm'} ・ 圈內 ${b.count}</span></div>`).join('');
    document.getElementById('surveyBody').innerHTML =
      `<div class="sv-metrics">` +
        `<div><span class="num">${d.elemHits.length}</span><span class="lab">圈內國小</span></div>` +
        `<div><span class="num">${d.elemStudents.toLocaleString()}</span><span class="lab">學生總數</span></div>` +
        `<div><span class="num">${d.kinderCount}</span><span class="lab">幼兒園</span></div>` +
      `</div>` +
      `<div class="sv-sec">生活圈國小（近→遠）</div>` +
      `<div class="sv-list">${list}</div>` +
      `<div class="sv-sec">競品（最近距離・圈內數量）</div>` +
      `<div class="sv-brands">${brands}</div>`;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dropSurveyPin(lngLat) {
    surveyLngLat = lngLat;
    if (surveyMarker) surveyMarker.remove();
    surveyMarker = new maplibregl.Marker({ element: surveyPinElement(), anchor: 'bottom', draggable: true })
      .setLngLat(lngLat).addTo(map);
    surveyMarker.on('drag', () => { surveyLngLat = surveyMarker.getLngLat(); updateBuffer(); });
    surveyMarker.on('dragend', () => { surveyLngLat = surveyMarker.getLngLat(); updateBuffer(); runSurveyAnalysis(); });
    updateBuffer();
    runSurveyAnalysis();
    const nameEl = document.getElementById('surveyName');
    if (!nameEl.value.trim()) {
      const t = new Date();
      nameEl.value = `勘查點-${pad2(t.getHours())}${pad2(t.getMinutes())}`;
    }
    document.getElementById('detail').hidden = true; // 避免與鄉鎮詳情面板重疊
    document.getElementById('survey').hidden = false;
    document.getElementById('surveyStatus').hidden = true;
  }
  map.on('click', ev => { if (placeMode) { dropSurveyPin(ev.lngLat); setPlaceMode(false); } });
  map.on('contextmenu', ev => { dropSurveyPin(ev.lngLat); });

  document.getElementById('surveyRadius').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      surveyRadius = +btn.dataset.r;
      document.querySelectorAll('#surveyRadius button').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      updateBuffer();
      runSurveyAnalysis();
    });
  });

  document.getElementById('surveyClose').addEventListener('click', () => {
    document.getElementById('survey').hidden = true;
    if (surveyMarker) { surveyMarker.remove(); surveyMarker = null; }
    surveyLngLat = null; bufferPoly = null; surveyData = null;
    if (map.getSource('survey-buf')) map.getSource('survey-buf').setData({ type: 'FeatureCollection', features: [] });
  });

  // ---- 匯出：Excel（單一勘查點）----
  function safeFile(s) { return (s || '勘查點').replace(/[\\/:*?"<>|]/g, '_').trim() || '勘查點'; }
  document.getElementById('surveyExcel').addEventListener('click', () => {
    if (!surveyData || !surveyLngLat) return;
    const name = document.getElementById('surveyName').value.trim() || '勘查點';
    const d = surveyData;
    const rad = surveyRadius >= 1000 ? (surveyRadius / 1000) + ' km' : surveyRadius + ' m';
    const rows = [
      ['勘查點', name],
      ['緯度', surveyLngLat.lat.toFixed(6)], ['經度', surveyLngLat.lng.toFixed(6)],
      ['生活圈半徑', rad], [],
      ['圈內國小數', d.elemHits.length],
      ['圈內國小學生總數', d.elemStudents],
      ['圈內幼兒園數', d.kinderCount], [],
      ['競品品牌', '最近距離(m)', '圈內數量'],
      ...d.brandStats.map(b => [b.label, b.nearest == null ? '—' : b.nearest, b.count]), [],
      ['圈內國小', '學生數', '距離(m)'],
      ...d.elemHits.map(h => [h.name, h.cnt, h.dist]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '勘查摘要');
    XLSX.writeFile(wb, safeFile(name) + '.xlsx');
  });

  // ---- 匯出：地圖截圖（PNG）----
  // NLSC 圖磚為 CORS-clean，canvas 未被污染，toDataURL 可用（已驗證）。
  // 已於建構時設 preserveDrawingBuffer:true。註：HTML Marker（勘查針）不會出現在 WebGL 截圖中，緩衝圈與熱區會。
  function flashStatus(msg) {
    const el = document.getElementById('surveyStatus');
    el.textContent = msg; el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 3500);
  }
  document.getElementById('surveyShot').addEventListener('click', () => {
    map.triggerRepaint();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const url = map.getCanvas().toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = safeFile(document.getElementById('surveyName').value) + '.png';
        document.body.appendChild(a); a.click(); a.remove();
      } catch (e) {
        console.error('screenshot failed', e);
        flashStatus('截圖失敗：' + (e && e.name || '未知錯誤'));
      }
    }));
  });

  // ---- 高階主管儀表板（角色切換：營運 / 高階主管）----
  // 定義（透明可解釋）：學齡＝該鄉鎮 3–12 歲人口。
  // 拓荒潛力＝學齡人口前 25% 且無自家據點且市場未飽和；
  // 飽和警戒＝每千名學齡兒童的補教據點數前 15%（學齡人口 ≥800、市場據點 ≥3，去雜訊）。
  const OWN_BRANDS = [['台灣拓人', tact], ['KUMON', kumon], ['明光義塾', meiko], ['MPM 數學', mpm]]
    .filter(b => b[1] && b[1].rows);
  const MKT_DATA = [kumon, meiko, mpm, tact, cram];
  // 各資料集鄉鎮鍵（cram 縣市/鄉鎮在 r[4]/r[5]，其餘品牌在 r[3]/r[4]）
  const brandTownKey = (data, r) => data === cram
    ? normTW((r[4] || '') + (r[5] || '')) : normTW((r[3] || '') + (r[4] || ''));
  function countByTown(data) {
    const m = new Map();
    if (!data || !data.rows) return m;
    for (const r of data.rows) {
      if (!isFinite(r[1]) || !isFinite(r[2])) continue;
      const k = brandTownKey(data, r);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }
  // 市場（全補教）每鄉鎮總據點數：與自家品牌無關，先算好
  const mktByTown = new Map();
  for (const data of MKT_DATA)
    for (const [k, v] of countByTown(data)) mktByTown.set(k, (mktByTown.get(k) || 0) + v);
  // 各品牌每鄉鎮據點數（點選鄉鎮看現況用）
  const brandCountMaps = [['KUMON', kumon], ['明光義塾', meiko], ['MPM 數學', mpm],
    ['台灣拓人', tact], ['補習班', cram]].map(([label, data]) => [label, countByTown(data)]);
  const schoolAgeOf = code => { const t = pop.towns[code]; return t ? sumBand(t.ages, 3, 12) : 0; };

  // ---- 近五年人口成長（pop_growth.json；缺檔則整段功能靜默關閉） ----
  const growthByCode = new Map();
  if (growth) for (const r of growth.townAll) growthByCode.set(r.code, r);
  const fmtPct = v => v == null ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const periodLabel = p => `${p.slice(0, 3)}/${p.slice(3)}`;
  // 迷你走勢線：6 期一條，純視覺輔助，數字仍以文字列出
  function sparkline(series, w = 64, h = 24) {
    const vals = series.filter(v => v != null);
    if (vals.length < 2) return '';
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = series.map((v, i) => v == null ? null :
      [(i / (series.length - 1)) * (w - 2) + 1, h - 1 - ((v - lo) / span) * (h - 2)])
      .filter(Boolean);
    const up = vals[vals.length - 1] >= vals[0];
    const col = up ? '#2f7a51' : '#b3453a';
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
      `<polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" ` +
      `fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="2.2" fill="${col}"/></svg>`;
  }

  // 點鄉鎮時，把該區各品牌據點畫在地圖上：label, 資料, 顏色, 縣市欄, 鄉鎮欄, 疊放優先（越大越上層）
  // 補習班(cram)數量最多墊最底；KUMON 顏色最淡疊最上，才不會被其他點蓋掉
  const COMP_BRANDS = [
    ['補習班', cram, '#5aa23a', 4, 5, 0],
    ['台灣拓人', tact, '#dc2626', 3, 4, 1],
    ['MPM 數學', mpm, '#14b8a6', 3, 4, 2],
    ['明光義塾', meiko, '#cb5cf0', 3, 4, 3],
    ['KUMON', kumon, '#7DCDF4', 3, 4, 4],
  ];
  function showExecCompetitors(townKey) {
    const feats = [];
    for (const [label, data, color, ci, ti, pri] of COMP_BRANDS) {
      if (!data || !data.rows) continue;
      for (const r of data.rows) {
        if (!isFinite(r[1]) || !isFinite(r[2])) continue;
        if (normTW((r[ci] || '') + (r[ti] || '')) !== townKey) continue;
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r[2], r[1]] },
          properties: { n: r[0], brand: label, color, pri } });
      }
    }
    if (map.getSource('exec-comp')) map.getSource('exec-comp').setData({ type: 'FeatureCollection', features: feats });
    if (map.getLayer('exec-comp-dots')) map.setLayoutProperty('exec-comp-dots', 'visibility', 'visible');
  }
  function clearExecCompetitors() {
    if (map.getSource('exec-comp')) map.getSource('exec-comp').setData({ type: 'FeatureCollection', features: [] });
    if (map.getLayer('exec-comp-dots')) map.setLayoutProperty('exec-comp-dots', 'visibility', 'none');
  }

  function currentOwnData() {
    const v = document.getElementById('execBrand').value;
    const found = OWN_BRANDS.find(b => b[0] === v);
    return found ? found[1] : (OWN_BRANDS[0] && OWN_BRANDS[0][1]);
  }

  function computeExec(ownData, county) {
    execScopeCounty = county || '';
    const ownByTown = countByTown(ownData);
    const rows = towns.map(f => {
      const code = f.properties.TOWNCODE;
      const nm = normTW(f.properties.COUNTYNAME + f.properties.TOWNNAME);
      const schoolAge = schoolAgeOf(code);
      const own = ownByTown.get(nm) || 0;
      const mkt = mktByTown.get(nm) || 0;
      const density = schoolAge > 0 ? mkt / (schoolAge / 1000) : 0; // 每千學齡兒童補教據點數
      return { code, county: f.properties.COUNTYNAME, name: f.properties.COUNTYNAME + f.properties.TOWNNAME, schoolAge, own, mkt, density };
    });
    // 門檻用全台（不隨縣市縮放），拓荒/飽和才有全國比較意義；角色著色也維持全台
    const ages = rows.map(r => r.schoolAge).filter(v => v > 0).sort(d3.ascending);
    const p75 = d3.quantile(ages, 0.75) || 0;
    const densVals = rows.filter(r => r.schoolAge >= 800).map(r => r.density).filter(v => v > 0).sort(d3.ascending);
    const dP85 = d3.quantile(densVals, 0.85);
    execRole = new Map(); execRowByCode = new Map();
    for (const r of rows) {
      execRowByCode.set(r.code, { schoolAge: r.schoolAge, own: r.own, mkt: r.mkt });
      const isPot = r.own === 0 && r.schoolAge >= p75 && (dP85 == null || r.density < dP85);
      const isSat = r.schoolAge >= 800 && r.mkt >= 3 && dP85 != null && r.density >= dP85;
      execRole.set(r.code, isPot ? 1 : isSat ? -1 : 0);
    }
    // 面板數字（KPI／Top 榜）依所選縣市縮放，未選＝全台
    const scoped = county ? rows.filter(r => r.county === county) : rows;
    const potential = scoped.filter(r => execRole.get(r.code) === 1).sort((a, b) => b.schoolAge - a.schoolAge);
    const saturation = scoped.filter(r => execRole.get(r.code) === -1).sort((a, b) => b.density - a.density);
    const ownTotal = scoped.reduce((s, r) => s + r.own, 0);
    const coverTowns = scoped.filter(r => r.own > 0).length;
    execResult = { scope: county || '全台', potential, saturation, ownTotal, coverTowns,
      totalTowns: scoped.length, potCount: potential.length, satCount: saturation.length };
    return execResult;
  }

  const execColorExpr = ['case',
    ['==', ['coalesce', ['feature-state', 'role'], 0], 1], '#3a8c5f',
    ['==', ['coalesce', ['feature-state', 'role'], 0], -1], '#c0483a',
    '#c7d0d8'];
  function applyExecColors() {
    if (!map.getLayer('towns-fill')) return;
    for (const [code, role] of execRole) map.setFeatureState({ source: 'towns', id: code }, { role });
    map.setPaintProperty('towns-fill', 'fill-color', execColorExpr);
    map.setPaintProperty('towns-fill', 'fill-opacity', 0.62);
  }

  function renderExecPanel() {
    const r = execResult; if (!r) return;
    const li = arr => arr.slice(0, 5).map((x, i) =>
      `<li data-code="${x.code}"><span class="rk">${i + 1}</span>` +
      `<span class="place">${x.name}</span>` +
      `<span class="why">學齡 ${fmtCount(x.schoolAge)}・補教 ${x.mkt}</span></li>`).join('')
      || '<li class="ex-empty">—</li>';
    const top = r.potential[0];
    const insight = top
      ? `洞察：<b>${top.name}</b> 學齡兒童 ${fmtCount(top.schoolAge)} 人（全台前段），目前無自家據點、周邊補教 ${top.mkt} 家，建議優先評估。`
      : '此範圍目前沒有明顯的拓荒潛力區。';
    document.getElementById('execBody').innerHTML =
      `<div class="ex-scope">範圍：${r.scope}</div>` +
      `<div class="ex-kpis">` +
        `<div class="ex-kpi"><span class="n">${r.ownTotal}</span><span class="k">教室總數</span></div>` +
        `<div class="ex-kpi"><span class="n">${r.coverTowns}</span><span class="k">覆蓋鄉鎮 / ${r.totalTowns}</span></div>` +
        `<div class="ex-kpi good"><span class="n">${r.potCount}</span><span class="k">拓荒潛力區</span></div>` +
        `<div class="ex-kpi crit"><span class="n">${r.satCount}</span><span class="k">飽和警戒區</span></div>` +
      `</div>` +
      `<div class="ex-sec"><i class="ex-dot g"></i>拓荒潛力 Top 5</div>` +
      `<ol class="ex-list">${li(r.potential)}</ol>` +
      `<div class="ex-sec"><i class="ex-dot c"></i>飽和警戒 Top 5</div>` +
      `<ol class="ex-list">${li(r.saturation)}</ol>` +
      `<div class="ex-insight">${insight}</div>` +
      `<p class="ex-formula">學齡＝3–12 歲人口。拓荒＝學齡人口前 25% 且無自家據點；飽和＝每千名學齡兒童補教據點數前 15%。自家品牌可於右上切換。</p>` +
      growthSectionHTML();
  }

  // ---- 近五年人口成長：面板只放摘要，完整榜單在 growth.html 簡報頁 ----
  function growthSectionHTML() {
    if (!growth) return '';
    const n = growth.national;
    return `<div class="ex-sec ex-sec-top"><i class="ex-dot up"></i>近五年人口成長</div>` +
      `<div class="ex-gsum">全台總人口 <b class="${n.growth >= 0 ? 'up' : 'dn'}">${fmtPct(n.growth)}</b>` +
      `・學齡 3–12 <b class="${n.sGrowth >= 0 ? 'up' : 'dn'}">${fmtPct(n.sGrowth)}</b>` +
      `（${periodLabel(growth.basePeriod)} → ${periodLabel(growth.lastPeriod)}）</div>` +
      `<a class="ex-deck" href="growth.html" target="_blank" rel="noopener">開啟成長簡報 ↗</a>` +
      `<p class="ex-formula">鄉鎮與村里成長排行、假成長區警訊、村里熱點都在簡報頁，點鄉鎮仍可在下方卡片看該區走勢。</p>`;
  }

  // 點選鄉鎮 → 現況卡片
  function selectExecTown(code, keepView) {
    const f = towns.find(t => t.properties.TOWNCODE === code);
    if (!f) return;
    const county = f.properties.COUNTYNAME;
    if (execScopeCounty !== county) { // 概況縮放到該區所屬縣市
      computeExec(currentOwnData(), county);
      renderExecPanel();
    }
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], code]);
    // keepView：由村里榜單進來時已縮到該里，不要再被鄉鎮範圍蓋回去
    if (!keepView) map.fitBounds(bboxOf([f]), { padding: 80, maxZoom: 11.5, duration: 650 });
    renderExecDetail(code, f);
    showExecCompetitors(normTW(f.properties.COUNTYNAME + f.properties.TOWNNAME));
    document.getElementById('execDetail').hidden = false;
    syncExecDrill(county, code);
  }
  function renderExecDetail(code, f) {
    const nm = normTW(f.properties.COUNTYNAME + f.properties.TOWNNAME);
    const r = execRowByCode.get(code) || { schoolAge: schoolAgeOf(code), own: 0, mkt: 0 };
    const role = execRole.get(code);
    const badge = role === 1 ? '<span class="ex-badge g">拓荒潛力</span>'
      : role === -1 ? '<span class="ex-badge c">飽和警戒</span>' : '<span class="ex-badge n">一般</span>';
    const t = pop.towns[code], iv = income.towns[code];
    const density = r.schoolAge > 0 ? r.mkt / (r.schoolAge / 1000) : 0;
    const brands = brandCountMaps.map(([label, m]) => `${label} ${m.get(nm) || 0}`).join('　');
    document.getElementById('execDetailBody').innerHTML =
      `<div class="exd-head"><span class="exd-name">${f.properties.COUNTYNAME}${f.properties.TOWNNAME}</span>${badge}</div>` +
      `<div class="exd-stats">` +
        `<div><span class="n">${t ? fmtCount(t.total) : '—'}</span><span class="k">總人口</span></div>` +
        `<div><span class="n">${fmtCount(r.schoolAge)}</span><span class="k">學齡兒童 3–12</span></div>` +
        `<div><span class="n">${iv ? fmtIncome(iv[2]) : '—'}</span><span class="k">所得中位數</span></div>` +
      `</div>` +
      `<div class="exd-stats">` +
        `<div><span class="n">${r.own}</span><span class="k">自家據點</span></div>` +
        `<div><span class="n">${r.mkt}</span><span class="k">市場補教</span></div>` +
        `<div><span class="n">${density.toFixed(1)}</span><span class="k">每千學齡</span></div>` +
      `</div>` +
      `<div class="exd-sec">各品牌據點數</div>` +
      `<div class="exd-brands">${brands}</div>` +
      execDetailGrowthHTML(code);
  }

  // 現況卡片的「近五年人口變化」：總人口與學齡各一列，附 6 期走勢線
  function execDetailGrowthHTML(code) {
    const r = growthByCode.get(code);
    if (!r) return '';
    const row = (lab, pct, base, last, hist) =>
      `<div class="exd-gw"><span class="lab">${lab}</span>` +
      `<span class="pct ${pct >= 0 ? 'up' : 'dn'}">${fmtPct(pct)}</span>` +
      `<span class="num">${fmtCount(base)}→${fmtCount(last)}</span>` +
      sparkline(hist) + `</div>`;
    const n = growth.national;
    return `<div class="exd-sec">近五年人口變化（${periodLabel(growth.basePeriod)} → ${periodLabel(growth.lastPeriod)}）</div>` +
      row('總人口', r.growth, r.base, r.last, r.hist) +
      row('學齡 3–12', r.sGrowth, r.sBase, r.sLast, r.sHist) +
      `<p class="exd-note">全台同期：總人口 ${fmtPct(n.growth)}、學齡 ${fmtPct(n.sGrowth)}</p>`;
  }

  function hidePointLayers() {
    for (const id of ['schools-elem', 'schools-kinder', 'cram-dots', 'kumon-dots', 'meiko-dots',
      'mpm-dots', 'tact-dots', 'pins-sym', 'survey-buf-fill', 'survey-buf-line', 'exec-comp-dots'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
  function restorePointVisibility() {
    updateSchoolFilters();
    for (const [id, chk] of [['cram-dots', 'layerCram'], ['kumon-dots', 'layerKumon'],
      ['meiko-dots', 'layerMeiko'], ['mpm-dots', 'layerMpm'], ['tact-dots', 'layerTact']])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', document.getElementById(chk).checked ? 'visible' : 'none');
    for (const id of ['survey-buf-fill', 'survey-buf-line', 'pins-sym'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
  }

  function enterExec() {
    document.getElementById('detail').hidden = true;
    document.getElementById('survey').hidden = true;
    if (placeMode) setPlaceMode(false);
    if (surveyMarker) { // 清掉未關閉的勘查點，主管視角只看全台著色
      surveyMarker.remove(); surveyMarker = null; surveyLngLat = null; bufferPoly = null; surveyData = null;
      if (map.getSource('survey-buf')) map.getSource('survey-buf').setData({ type: 'FeatureCollection', features: [] });
    }
    clearPins();
    clearWhiteSpace();
    hidePointLayers();
    computeExec(currentOwnData());
    applyExecColors();
    renderExecPanel();
    document.getElementById('execPanel').hidden = false;
    document.getElementById('execLegend').hidden = false;
    document.getElementById('execDetail').hidden = true;
    document.getElementById('execCounty').value = '';
    document.getElementById('execTown').innerHTML = '<option value="">選鄉鎮市區…</option>';
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    map.fitBounds(TAIWAN_BOUNDS, { padding: 40, duration: 600 });
  }
  function exitExec() {
    document.getElementById('execPanel').hidden = true;
    document.getElementById('execLegend').hidden = true;
    document.getElementById('execDetail').hidden = true;
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    clearExecCompetitors();
    restorePointVisibility();
    map.setPaintProperty('towns-fill', 'fill-opacity', fillOpacity());
    repaint();
  }
  function setRoleMode(mode) {
    if (mode === roleMode) return;
    roleMode = mode;
    document.body.classList.toggle('exec-mode', mode === 'exec');
    document.querySelectorAll('#roleSwitch button').forEach(b => b.classList.toggle('active', b.dataset.role === mode));
    if (mode === 'exec') enterExec(); else exitExec();
  }
  document.querySelectorAll('#roleSwitch button').forEach(b =>
    b.addEventListener('click', () => setRoleMode(b.dataset.role)));

  // 自家品牌下拉（cram 為泛稱補習班，不列為自家）
  const execBrandSel = document.getElementById('execBrand');
  OWN_BRANDS.forEach(([label]) => {
    const o = document.createElement('option'); o.value = label; o.textContent = label;
    execBrandSel.appendChild(o);
  });
  execBrandSel.addEventListener('change', () => {
    document.getElementById('execDetail').hidden = true;
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    clearExecCompetitors();
    computeExec(currentOwnData(), execScopeCounty);
    applyExecColors();
    renderExecPanel();
  });

  // exec 縣市 → 鄉鎮市區 下鑽選單
  const execCountySel = document.getElementById('execCounty');
  const execTownSel = document.getElementById('execTown');
  counties.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; execCountySel.appendChild(o); });
  function populateExecTowns(county) {
    const tSel = document.getElementById('execTown');
    tSel.innerHTML = '<option value="">選鄉鎮市區…</option>';
    if (!county) return [];
    const fs = towns.filter(f => f.properties.COUNTYNAME === county)
      .sort((a, b) => a.properties.TOWNCODE.localeCompare(b.properties.TOWNCODE));
    for (const f of fs) {
      const o = document.createElement('option');
      o.value = f.properties.TOWNCODE; o.textContent = f.properties.TOWNNAME;
      tSel.appendChild(o);
    }
    return fs;
  }
  // 點地圖或 Top 榜下鑽時，把下拉同步到目前的縣市/鄉鎮（不觸發 change）
  function syncExecDrill(county, code) {
    const cSel = document.getElementById('execCounty');
    if (cSel.value !== county) { cSel.value = county; populateExecTowns(county); }
    document.getElementById('execTown').value = code || '';
  }
  execCountySel.addEventListener('change', () => {
    const county = execCountySel.value;
    const fs = populateExecTowns(county);
    document.getElementById('execDetail').hidden = true;
    clearExecCompetitors();
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    computeExec(currentOwnData(), county); // 概況縮放到該縣市（未選＝全台）
    renderExecPanel();
    if (county && fs.length) map.fitBounds(bboxOf(fs), { padding: 60, maxZoom: 11.5, duration: 650 });
    else map.fitBounds(TAIWAN_BOUNDS, { padding: 40, duration: 600 });
  });
  execTownSel.addEventListener('change', () => {
    if (execTownSel.value) selectExecTown(execTownSel.value);
  });
  // 點 Top 榜清單 → 飛到該鄉鎮並開現況卡片
  document.getElementById('execBody').addEventListener('click', e => {
    const li = e.target.closest('li[data-code]');
    if (li) selectExecTown(li.dataset.code);
  });
  document.getElementById('execDetailClose').addEventListener('click', () => {
    document.getElementById('execDetail').hidden = true;
    map.setFilter('towns-sel', ['==', ['get', 'TOWNCODE'], '']);
    clearExecCompetitors();
  });
})();
