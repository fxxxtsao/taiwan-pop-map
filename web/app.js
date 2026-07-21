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
    { label: '0–5 學齡前', min: 0, max: 5 },
    { label: '6–11 國小', min: 6, max: 11 },
    { label: '12–17 國高中', min: 12, max: 17 },
    { label: '18–39', min: 18, max: 39 },
    { label: '40–64', min: 40, max: 64 },
    { label: '65+ 高齡', min: 65, max: 100 },
  ];
  let band = { min: 0, max: 100 };
  let metric = 'count';  // count | share
  let theme = 'pop';     // pop | income
  let incMetric = 'med'; // med | avg
  let selectedCode = null;
  let pinScope = null;   // {type:'town'|'county', key} 大頭針範圍
  let pinsShown = false;
  const SCHOOL_MINZOOM = 8.2; // 舊版 zoomK≈3
  const VILL_MINZOOM = 9.3;   // 舊版 zoomK≈6
  const HTML_PINS_MAX = 150;  // 少量用 HTML Marker（逐支落下動畫）；超過改 GPU symbol layer（全體落下）
  const MISS = -9e18;         // feature-state 缺值 sentinel
  const TAIWAN_BOUNDS = [[118.0, 21.6], [122.1, 26.5]];
  const normTW = s => (s || '').replace(/臺/g, '台');

  // 學校規模編碼（分位數顏色，沿用各層色相：國小藍、幼兒園琥珀）
  const ELEM_RAMP = ['#d8ecc6', '#aad48a', '#75b84f', '#468f2c', '#2b6318']; // 草綠系，與紫色幼兒園高對比
  const KIN_RAMP = ['#e3d5f0', '#c3a3e0', '#a06fcf', '#7b41b0', '#54277f']; // 紫色系，與暖色底圖區隔
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
    for (const [id, kind, ramp, dom] of [['schools-elem', 'e', ELEM_RAMP, ELEM_DOM], ['schools-kinder', 'k', KIN_RAMP, KIN_DOM]]) {
      addLyr({
        id, type: 'circle', source: 'schools', minzoom: SCHOOL_MINZOOM,
        filter: ['==', ['get', 'k'], kind],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.2, 3.4, 12, 4.8, 15, 6.4],
          'circle-color': sizeColor(ramp, dom),
          'circle-stroke-color': '#fff', 'circle-stroke-width': 0.5,
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
          'circle-color': '#285a8c',
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

    bindHover('towns-fill', 'towns', f => {
      const code = f.properties.TOWNCODE;
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

  // ---- 大頭針（HTML Marker，保留立體造型與落下動畫）----
  const defsHost = document.createElement('div');
  defsHost.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs>
    ${['pinElem|#a9cbe8|#5b8db8|#35587d', 'pinKinder|#f4d49e|#e0a458|#a8742d', 'pinBoth|#c8b8e0|#8f7bb5|#5d4d80']
      .map(s => { const [id, a, b, c] = s.split('|');
        return `<radialGradient id="${id}" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="${a}"/><stop offset="55%" stop-color="${b}"/>
          <stop offset="100%" stop-color="${c}"/></radialGradient>`; }).join('')}
    <linearGradient id="pinNeedle" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%" stop-color="#c9cdd2"/><stop offset="45%" stop-color="#f2f4f6"/>
      <stop offset="100%" stop-color="#8d9298"/></linearGradient>
  </defs></svg>`;
  document.body.appendChild(defsHost);

  // 貼圖版大頭針（symbol layer 用；把同款 SVG 烙成 2x 點陣圖）
  let pinImgReady = false;
  function pinSpriteSVG(light, base, dark, collar) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="40" viewBox="-13 -36 26 40">
      <defs>
        <radialGradient id="h" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="${light}"/><stop offset="55%" stop-color="${base}"/>
          <stop offset="100%" stop-color="${dark}"/></radialGradient>
        <linearGradient id="n" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#c9cdd2"/><stop offset="45%" stop-color="#f2f4f6"/>
          <stop offset="100%" stop-color="#8d9298"/></linearGradient>
      </defs>
      <ellipse cx="1.5" cy="0.6" rx="5" ry="1.8" fill="rgba(61,65,72,0.28)"/>
      <path d="M0,0 L-1.2,-13 L1.2,-13 Z" fill="url(#n)"/>
      <rect x="-3.2" y="-16.6" width="6.4" height="4.2" rx="1.6" fill="${collar}"/>
      <circle cy="-22" r="7.2" fill="url(#h)" stroke="rgba(255,255,255,0.55)" stroke-width="0.6"/>
      <ellipse cx="-2.4" cy="-25" rx="2.3" ry="1.5" fill="rgba(255,255,255,0.75)"/>
    </svg>`;
  }
  function loadPinImages() {
    const variants = {
      'pin-elem': ['#a9cbe8', '#5b8db8', '#35587d', '#416991'],
      'pin-kinder': ['#f4d49e', '#e0a458', '#a8742d', '#b5823c'],
      'pin-both': ['#c8b8e0', '#8f7bb5', '#5d4d80', '#6f5e97'],
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
    const grad = cls === 'both' ? 'pinBoth' : cls === 'elem' ? 'pinElem' : 'pinKinder';
    const el = document.createElement('div');
    el.className = 'pin ' + cls;
    el.innerHTML = `<svg width="26" height="40" viewBox="-13 -36 26 40" style="--d:${delay}ms">
      <ellipse class="pin-shadow" cx="1.5" cy="0.6" rx="5" ry="1.8"/>
      <g class="pin-body">
        <path d="M0,0 L-1.2,-13 L1.2,-13 Z" fill="url(#pinNeedle)"/>
        <rect class="pin-collar" x="-3.2" y="-16.6" width="6.4" height="4.2" rx="1.6"/>
        <circle class="pin-head" cy="-22" r="7.2" fill="url(#${grad})"/>
        <ellipse class="pin-gloss" cx="-2.4" cy="-25" rx="2.3" ry="1.5"/>
      </g></svg>`;
    return el;
  }
  function renderPins(animate = true) {
    clearPins();
    if (pinScope) {
      const test = pinScope.type === 'town'
        ? s => normTW(s[4] + s[5]) === pinScope.key
        : s => normTW(s[4]) === pinScope.key;
      const items = [];
      if (document.getElementById('layerElem').checked)
        for (const s of schools.elem) if (test(s)) items.push({ s, cls: 'elem' });
      if (document.getElementById('layerKinder').checked)
        for (const s of schools.kinder) if (test(s)) items.push({ s, cls: 'kinder' });
      // 同座標合併（國小＋附幼 → 紫針）
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
  }

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
})();
