/* State report: /wv, /tx ... (rewritten to state.html).
 *
 * Three independent loads, so one failing never blanks the others:
 *   /data/live.json                 bills (same source and labels as the tracker and /live)
 *   /data/states/<xx>.health.json   public health snapshot from What's In My County
 *   /data/states/<xx>.geo.json      county shapes for the map (optional: the page works without it)
 *   /data/states/<xx>.json          legislators and members of Congress
 * The two per-state files are written by scripts/build_state_data.py.
 *
 * Rules kept on this page: a state-level figure is never shown as a county value or the
 * reverse; every figure carries its source and date; "elevated" is always one published
 * measure against one stated threshold, never a combined score.
 */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  var num = function (v) { return typeof v === 'number' && isFinite(v); };
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
  var http = function (u) { return /^https?:\/\//.test(u || '') ? u : ''; };
  var m = location.pathname.match(/^\/([a-zA-Z]{2})\/?$/) || location.search.match(/[?&]s=([a-zA-Z]{2})/);
  var code = m ? m[1].toUpperCase() : '';
  var getJSON = function (url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  };

  // ------------------------------------------------------------------ bills (existing data and labels)

  // Stage lanes as scripts/build_live.py assigns them (bill.stage), in legislative order.
  var STAGES = [['introduced', 'Introduced'], ['committee', 'In committee'], ['passed1', 'Passed one chamber'],
    ['passed2', 'Passed both chambers'], ['signed', 'Signed into law'], ['dead', 'Failed, vetoed or died']];
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  function billViz(st, pro, anti, watch, asof) {
    var total = pro.length + anti.length + watch.length;
    if (!total) {
      return '<div class="st-unavail">SAFE Action has no pro-science or anti-science bills on file for ' + esc(st.name) + ' this session. ' +
        fmt(st.tracked) + ' bills are monitored here; none is classified as pro-science or anti-science.</div>';
    }
    var seg = function (cls, list, word) {
      if (!list.length) return '';
      return '<div class="' + cls + '" style="flex:' + list.length + ' 1 0" data-tip="' + esc(plural(list.length, word + ' bill', word + ' bills')) + '">' + list.length + '</div>';
    };
    var html = '<div class="st-panel"><div class="st-split" role="img" aria-label="' + esc(pro.length + ' pro-science bills, ' + anti.length + ' anti-science bills' +
      (watch.length ? ', ' + watch.length + ' to watch' : '')) + '">' + seg('pro', pro, 'pro-science') + seg('anti', anti, 'anti-science') + seg('watch', watch, 'one to watch') + '</div>' +
      '<div class="st-splitkey"><span><i class="st-dot" style="background:var(--v-pro)"></i>' + plural(pro.length, 'pro-science bill', 'pro-science bills') + '</span>' +
      (watch.length ? '<span><i class="st-dot" style="background:var(--v-watch)"></i>' + watch.length + ' to watch, not counted as either</span>' : '') +
      '<span><i class="st-dot" style="background:var(--v-anti)"></i>' + plural(anti.length, 'anti-science bill', 'anti-science bills') + '</span></div>';

    var rows = STAGES.map(function (s) {
      var p = pro.filter(function (b) { return b.stage === s[0]; }).length, a = anti.filter(function (b) { return b.stage === s[0]; }).length;
      return { label: s[1], p: p, a: a };
    });
    var max = Math.max.apply(null, rows.map(function (r) { return r.p + r.a; })) || 1;
    html += '<h4 style="font-size:13px;font-weight:800;margin:18px 0 2px;">How far they have moved</h4><div class="st-stages">' + rows.map(function (r) {
      var w = function (n) { return (n / max * 100).toFixed(2) + '%'; };
      var bars = (r.p ? '<i style="width:' + w(r.p) + ';background:var(--v-pro)" data-tip="' + esc(r.label + ': ' + plural(r.p, 'pro-science bill', 'pro-science bills')) + '"></i>' : '') +
        (r.a ? '<i style="width:' + w(r.a) + ';background:var(--v-anti)" data-tip="' + esc(r.label + ': ' + plural(r.a, 'anti-science bill', 'anti-science bills')) + '"></i>' : '');
      var label = r.p + r.a ? '<span>' + (r.p ? r.p + ' pro' : '') + (r.p && r.a ? ' · ' : '') + (r.a ? r.a + ' anti' : '') + '</span>' : '<span class="zero">0</span>';
      return '<div class="st-stage"><div>' + esc(r.label) + '</div><div class="tr">' + bars + label + '</div></div>';
    }).join('') + '</div>' +
      '<p class="st-src">Source: SAFE Action tracker (LegiScan, GovInfo and Open States), as of ' + esc(asof) + '. ' + fmt(st.tracked) + ' bills are monitored in ' + esc(st.name) + ' in total.</p></div>';
    return html;
  }

  getJSON('/data/live.json').then(function (D) {
    var st = D.states[code];
    $('st-states').innerHTML = Object.keys(D.states).filter(function (c) { return c !== 'US'; })
      .map(function (c) { return '<a href="/' + c.toLowerCase() + '">' + c + '</a>'; }).join('');
    if (!st || code === 'US') {
      $('st-name').textContent = 'Pick a state';
      $('st-billviz').innerHTML = '<div class="st-unavail">Choose a state below, or see <a href="/states">all states</a>.</div>';
      $('st-billlist').hidden = true;
      return;
    }
    document.title = st.name + ' state report - SAFE Action';
    // One template serves every state, so the canonical address is set per state here.
    var canon = 'https://scienceandfreedom.com/' + code.toLowerCase();
    var setAttr = function (sel, attr) { var e = document.querySelector(sel); if (e) e.setAttribute(attr, canon); };
    setAttr('link[rel="canonical"]', 'href'); setAttr('meta[property="og:url"]', 'content');
    $('st-name').textContent = st.name;
    $('st-eyebrow').textContent = 'STATE REPORT · ' + code;
    $('sb-label').textContent = st.name.toUpperCase() + ' · ' + st.anti + ' ANTI · ' + st.pro + ' PRO';
    $('st-pro').textContent = st.pro;
    $('st-anti').textContent = st.anti;
    $('st-rec').href = 'records.html?state=' + code;
    $('st-browse').href = 'tracker.html?state=' + code + '#browse-bills';
    $('st-browse').textContent = 'Browse all ' + fmt(st.tracked) + ' bills monitored in ' + st.name;
    $('st-vol').href = 'volunteer.html?state=' + code;
    var asof = (D.crawl_generated_at || D.generated_at).slice(0, 10);
    $('st-asof').textContent = 'Bill data as of ' + asof + '.';
    var bills = D.bills.filter(function (b) { return b.state === code; });
    var ORD = { pro: 0, anti: 1, watch: 2 }; bills.sort(function (a, z) { return ORD[a.type] - ORD[z.type]; });
    var of = function (t) { return bills.filter(function (b) { return b.type === t; }); };
    $('st-billviz').innerHTML = billViz(st, of('pro'), of('anti'), of('watch'), asof);
    tips($('st-billviz'));
    if (!bills.length) { $('st-billlist').hidden = true; $('st-rows').innerHTML = ''; return; }
    $('st-billtoggle').textContent = 'Show all ' + plural(bills.length, 'bill', 'bills') + ' with titles and official records';
    $('st-rows').innerHTML = bills.map(function (b) {
      var src = http(b.source);
      var n = src ? '<a href="' + esc(src) + '" rel="noopener">' + esc(b.number) + '</a>' : esc(b.number);
      return '<tr><td class="num">' + n + '</td><td><span class="tag ' + esc(b.type) + '">' + (b.type === 'watch' ? 'ONE TO WATCH' : esc(b.type).toUpperCase()) + '</span></td><td>' + esc(b.title) +
        '</td><td>' + esc(b.status) + '</td><td class="num" style="font-weight:400">' + esc(b.lastActionDate || '') + '</td></tr>';
    }).join('');
  }).catch(function () {
    $('st-billviz').innerHTML = '<div class="st-unavail">Bill data could not be loaded. Try again shortly, or use the <a href="tracker.html">live tracker</a>.</div>';
    $('st-billlist').hidden = true;
  });

  // Hover and tap tooltips for any mark carrying data-tip inside a host element.
  function tips(host) {
    host.classList.add('st-tiphost');
    var tip = document.createElement('div'); tip.className = 'st-tip'; tip.hidden = true; host.appendChild(tip);
    var show = function (e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t || !host.contains(t)) { tip.hidden = true; return; }
      tip.textContent = t.getAttribute('data-tip'); tip.hidden = false;
      var r = host.getBoundingClientRect(), x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
      if (x + tip.offsetWidth > r.width) x = Math.max(0, e.clientX - r.left - tip.offsetWidth - 10);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    };
    host.addEventListener('pointermove', show); host.addEventListener('pointerdown', show);
    host.addEventListener('pointerleave', function () { tip.hidden = true; });
  }

  if (!code || code === 'US') {
    $('st-health').innerHTML = '<p class="st-line">Choose a state to see its public health data.</p>';
    $('st-people').innerHTML = '<p class="st-line">Choose a state to see its legislators.</p>';
    return;
  }

  // ------------------------------------------------------------------ sortable tables

  // Cells carry data-v (sort value). Empty data-v sorts last in both directions.
  function sortable(table) {
    var ths = table.querySelectorAll('thead th');
    Array.prototype.forEach.call(ths, function (th, i) {
      var b = th.querySelector('button');
      if (!b) return;
      b.addEventListener('click', function () {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        Array.prototype.forEach.call(ths, function (t) { t.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        var key = function (r) { return r.cells[i].getAttribute('data-v'); };
        rows.sort(function (a, z) {
          var x = key(a), y = key(z);
          if (x === '' || x === null) return (y === '' || y === null) ? 0 : 1;
          if (y === '' || y === null) return -1;
          var nx = Number(x), ny = Number(y);
          if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
          return x.localeCompare(y) * dir;
        });
        rows.forEach(function (r) { body.appendChild(r); });
      });
    });
  }
  function filterable(input, table, counter, noun) {
    var rows = Array.prototype.slice.call(table.tBodies[0].rows);
    var run = function () {
      var q = input.value.trim().toLowerCase(), n = 0;
      rows.forEach(function (r) {
        var hit = !q || r.getAttribute('data-q').indexOf(q) >= 0;
        r.hidden = !hit; if (hit) n++;
      });
      counter.textContent = n + ' of ' + rows.length + ' ' + noun;
    };
    input.addEventListener('input', run); run();
  }
  var th = function (label, cls) { return '<th' + (cls ? ' class="' + cls + '"' : '') + '><button type="button">' + esc(label) + '</button></th>'; };

  // ------------------------------------------------------------------ public health (What's In My County)

  var CREDIT = "Data: What's In My County, published by Priori Intelligence";
  // Measures the county map can show, in menu order: [measure key, menu label, elevated rule or ''].
  // Each is one published county measure. The map bins values with the source's own classes.
  var MAPS = [
    ['ww_covid_wval_level_max', 'COVID-19 wastewater level', 'Elevated here means High or Very high.'],
    ['ww_flu_a_wval_level_max', 'Influenza A wastewater level', 'Elevated here means High or Very high.'],
    ['ww_rsv_wval_level_max', 'Respiratory syncytial virus (RSV) wastewater level', 'Elevated here means High or Very high.'],
    ['ww_measles_detected_recent', 'Measles virus in wastewater', 'Detected means found in either of the last 2 samples; not detected does not mean absent.'],
    ['measles_cases_ytd', 'Measles cases this year', 'Elevated here means at least 1 confirmed case.'],
    ['measles_cases_4wk', 'Measles cases in the last 4 weeks', 'Elevated here means at least 1 confirmed case.'],
    ['mmr2_kindergarten_ca_low', 'Kindergarten measles, mumps and rubella (MMR) vaccine coverage, low bound', ''],
    ['aqi_days_over_100', 'Days with air quality index above 100', ''],
    ['water_systems_hb_violation_5y', 'Water systems with a health-based violation, 5 years', ''],
    ['superfund_npl_final', 'Superfund National Priorities List sites', ''],
    ['dc_locations_osm', 'Data center locations in OpenStreetMap', '']
  ];
  // County table columns: [measure key, column heading].
  var COLS = [
    ['ww_covid_n_sites', 'COVID-19 wastewater sites'],
    ['ww_covid_wval_level_max', 'COVID-19 wastewater level'],
    ['ww_covid_trend_4wk', 'COVID-19 trend, 4 weeks'],
    ['ww_flu_a_wval_level_max', 'Influenza A wastewater level'],
    ['ww_rsv_wval_level_max', 'RSV wastewater level'],
    ['ww_measles_detected_recent', 'Measles virus in wastewater'],
    ['measles_cases_ytd', 'Measles cases, this year'],
    ['measles_cases_4wk', 'Measles cases, last 4 weeks'],
    ['mmr2_kindergarten_ca_low', 'Kindergarten MMR coverage, low bound'],
    ['mmr2_kindergarten_ca_high', 'Kindergarten MMR coverage, high bound'],
    ['aqi_days_over_100', 'Days with air quality index above 100'],
    ['water_systems_hb_violation_5y', 'Water systems with a health-based violation, 5 years'],
    ['superfund_npl_final', 'Superfund National Priorities List sites'],
    ['dc_locations_osm', 'Data center locations in OpenStreetMap']
  ];
  // Measures published for one state only: dropped elsewhere instead of reading "no data".
  var ONE_STATE = { mmr2_kindergarten_ca_low: 1, mmr2_kindergarten_ca_high: 1 };
  var TONES = ['', 'var(--v-t1)', 'var(--v-t2)', 'var(--v-t3)', 'var(--v-t4)', 'var(--v-t5)'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function unavailable(msg) { return '<div class="st-unavail">' + msg + '</div>'; }

  // The source's class for a value, or null when the value has no class (drawn as no data).
  function classOf(meta, v) {
    if (!num(v) || !meta.legend) return null;
    var cs = meta.legend.classes || [], i, c;
    for (i = 0; i < cs.length; i++) { c = cs[i]; if (num(c.value) && c.value === v) return c; }
    for (i = 0; i < cs.length; i++) {
      c = cs[i];
      if (num(c.value) && !num(c.min) && !num(c.max)) continue;
      if ((!num(c.min) || v >= c.min) && (!num(c.max) || v < c.max)) return c;
    }
    return null;
  }

  function renderHealth(H, G) {
    var M = H.measures || {}, C = H.counties || [], N = H.counties_total, site = http(H.source && H.source.site);
    var ok = function (k) { return M[k] && M[k].available; };
    var any = function (k) { return ok(k) && M[k].n_counties > 0; };
    var val = function (c, k) { return c.v ? c.v[k] : undefined; };
    var pub = function (id) { var f = (H.feeds || {})[id]; return f ? f.publisher : ''; };
    var short = function (id) {   // short publisher name for tiles
      var p = pub(id);
      return p.replace('Centers for Disease Control and Prevention', 'CDC').replace(/^United States Environmental Protection Agency.*/, 'EPA')
        .replace('Johns Hopkins University Measles Tracking Team', 'Johns Hopkins University').replace(/ \(.*\)$/, '');
    };
    var countyUrl = function (c) { return site ? site + '/county/' + encodeURIComponent(c.fips) : ''; };
    var link = function (c, text) { var u = countyUrl(c); return u ? '<a href="' + esc(u) + '" rel="noopener">' + esc(text || c.name) + '</a>' : esc(text || c.name); };
    var withValue = function (k) { return C.filter(function (c) { return num(val(c, k)); }); };
    var show = function (k, v) {   // a county value as text
      var meta = M[k];
      if (v && typeof v === 'object') return v.t;
      if (!num(v)) return meta.no_data || 'no data';
      if (meta.classes && meta.classes[String(v)]) return meta.classes[String(v)];
      return meta.unit === 'percent' ? v + '%' : fmt(v);
    };
    var html = '';

    html += '<p class="st-line">Public data for ' + esc(H.name) + ' and its ' + fmt(N) + (N === 1 ? ' county' : ' counties') + ', each figure with its source and period; it is not medical advice. ' +
      '<span class="st-src">Terms: CDC is the Centers for Disease Control and Prevention, EPA is the Environmental Protection Agency, RSV is respiratory syncytial virus.</span></p>';

    // ---- headline tiles: one measure each
    var tiles = [];
    var tile = function (scope, n, of, label, k, feed, period) {
      tiles.push('<div class="st-tile"><div class="scope">' + scope + '</div>' +
        (n === null ? '<div class="n nd">no data</div>' : '<div class="n">' + n + '</div>' + (of ? '<div class="of">' + of + '</div>' : '')) +
        '<div class="l">' + label + '</div><div class="s">' + esc(short(feed) || 'What\'s In My County') + (period ? ' · ' + esc(period) : '') + '</div></div>');
    };
    var levelTile = function (k, name) {
      if (!ok(k)) return;
      var have = withValue(k), hi = have.filter(function (c) { return val(c, k) >= 4; }).length;
      tile('COUNTIES', have.length ? hi : null, have.length ? 'of ' + have.length + ' with a level' : '', name + ' wastewater level High or Very high', k, M[k].feed, M[k].period);
    };
    if (ok('ww_covid_n_sites')) {
      tile('COUNTIES', withValue('ww_covid_n_sites').filter(function (c) { return val(c, 'ww_covid_n_sites') >= 1; }).length, 'of ' + N, 'Have a wastewater sampling site reporting', 'ww_covid_n_sites', M.ww_covid_n_sites.feed, M.ww_covid_n_sites.period);
    }
    levelTile('ww_covid_wval_level_max', 'COVID-19');
    levelTile('ww_flu_a_wval_level_max', 'Influenza A');
    if (ok('measles_cases_ytd')) {
      var my = withValue('measles_cases_ytd');
      tile('COUNTIES', my.length ? my.filter(function (c) { return val(c, 'measles_cases_ytd') >= 1; }).length : null, my.length ? 'of ' + my.length + ' with a count' : '',
        'At least 1 confirmed measles case this year', 'measles_cases_ytd', M.measles_cases_ytd.feed, M.measles_cases_ytd.period);
      tile('SUM OF COUNTY COUNTS', my.length ? fmt(my.reduce(function (a, c) { return a + val(c, 'measles_cases_ytd'); }, 0)) : null, '',
        'Confirmed measles cases this year in counties with a count', 'measles_cases_ytd', M.measles_cases_ytd.feed, M.measles_cases_ytd.period);
    }
    var ctx = H.state_context || {}, items = (ctx.available && ctx.items) || [];
    var kg = items.filter(function (i) { return i.metric === 'kg_mmr_coverage_pct'; })[0];
    if (kg) {
      tile('STATEWIDE', kg.status === 'ok' && num(kg.value) ? esc(kg.display) : null, '', 'Kindergarten measles, mumps and rubella (MMR) vaccine coverage',
        '', kg.feed, kg.quality || kg.period);
    }
    html += tiles.length ? '<div class="st-tiles">' + tiles.join('') + '</div>' : unavailable('Headline figures are unavailable in this snapshot.');

    // ---- county map
    var maps = MAPS.filter(function (x) { return any(x[0]); });
    html += '<h3 id="map">County map</h3>';
    if (!G || !G.paths) {
      html += unavailable('The county map is unavailable right now. The county figures are in the table under "Show all counties" below.');
    } else if (!maps.length) {
      html += unavailable('No county measure is available to map in this snapshot.');
    } else {
      html += '<div class="st-panel"><div class="st-mapctl"><label for="st-msel">Color counties by</label><select id="st-msel">' +
        maps.map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join('') + '</select></div>' +
        '<div class="st-mapgrid"><div class="st-map" id="st-map"><svg viewBox="-4 -4 ' + (G.w + 8) + ' ' + (G.h + 8) + '" role="img" aria-label="County map of ' + esc(H.name) + '. The same values are in the county table below.">' +
        '<defs><pattern id="st-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#efeeea"/><rect width="2" height="6" fill="#c9c6bd"/></pattern></defs>' +
        C.map(function (c) { return G.paths[c.fips] ? '<path data-f="' + esc(c.fips) + '" d="' + esc(G.paths[c.fips]) + '"/>' : ''; }).join('') + '</svg></div>' +
        '<div class="st-side"><div class="st-legend" id="st-legend"></div><div class="st-pick" id="st-pick"></div><h4 id="st-rankh"></h4><div class="st-bars" id="st-rank"></div></div></div>' +
        '<p class="st-src" id="st-mapsrc"></p></div>';
    }

    // ---- measles by week (county counts added up)
    var W = H.measles_weekly || {};
    html += '<h3>Measles cases by week</h3>';
    if (W.available && W.weeks && W.weeks.length && W.total > 0) {
      var wk = W.weeks, wmax = Math.max.apply(null, wk.map(function (x) { return x.cases; })) || 1;
      var VW = Math.max(280, Math.min(1040, ($('st-health').clientWidth || 720) - 38)), VH = VW < 500 ? 170 : 200, L = 30, B = 22, T = 12, bw = (VW - L) / wk.length;
      var y = function (n) { return T + (VH - T - B) * (1 - n / wmax); };
      var svg = '<svg viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="Confirmed measles cases by week in ' + esc(H.name) + ', added up from county counts. Highest week: ' + wmax + '.">';
      [0, wmax].forEach(function (n) { svg += '<line x1="' + L + '" x2="' + VW + '" y1="' + y(n) + '" y2="' + y(n) + '" stroke="var(--v-grid)"/><text x="' + (L - 6) + '" y="' + (y(n) + 4) + '" text-anchor="end">' + n + '</text>'; });
      var lastMonth = -1;
      wk.forEach(function (x, i) {
        var h = (VH - T - B) * x.cases / wmax, mo = Number(x.week.slice(5, 7)) - 1;
        if (x.cases) svg += '<rect class="bar" x="' + (L + i * bw + 1).toFixed(1) + '" y="' + (VH - B - h).toFixed(1) + '" width="' + Math.max(bw - 2, 1).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"/>';
        svg += '<rect x="' + (L + i * bw).toFixed(1) + '" y="' + T + '" width="' + bw.toFixed(1) + '" height="' + (VH - T - B) + '" fill="transparent" data-tip="' + esc('Week ending ' + x.week + ': ' + plural(x.cases, 'case', 'cases')) + '"/>';
        if (mo !== lastMonth) { if (VW >= 500 || mo % 2 === 0) svg += '<text x="' + (L + i * bw + 1).toFixed(1) + '" y="' + (VH - 6) + '">' + MONTHS[mo] + '</text>'; lastMonth = mo; }
      });
      html += '<div class="st-panel st-chart" id="st-weekly">' + svg + '</svg><p class="st-src">Confirmed cases by week, added up from the ' + W.counties_reporting + ' of ' + N +
        ' counties with a published count (' + fmt(W.total) + ' this year). This is a sum of county values, not the state\'s official total. Source: ' + esc(pub(W.feed) || 'Johns Hopkins University Measles Tracking Team') +
        ((H.feeds[W.feed] || {}).credit ? ' (' + esc(H.feeds[W.feed].credit) + ')' : '') + ', through ' + esc(W.period) + ', via What\'s In My County.</p></div>';
    } else if (W.available && W.total === 0) {
      html += unavailable('No confirmed measles cases this year in the ' + W.counties_reporting + ' of ' + N + ' counties with a published count, through ' + esc(W.period) + '. Source: ' + esc(pub(W.feed)) + ', via What\'s In My County.');
    } else {
      html += unavailable('Weekly measles counts by county are unavailable for ' + esc(H.name) + (W.reason ? ' (' + esc(W.reason) + ')' : '') + '. This is missing data, not a count of zero.');
    }

    // ---- statewide figures against the other states
    html += '<h3>Statewide figures</h3>';
    if (items.length) {
      var cmp = H.state_compare || {};
      html += '<p class="st-line">Statewide values, never county values; percentages and rates are placed among the states that report them.</p>' +
        '<div class="st-panel"><div class="st-key"><span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="var(--v-mark)" stroke="#fff" stroke-width="1.5"/></svg>' + esc(H.name) + '</span>' +
        '<span><svg width="14" height="14"><rect x="6" y="0" width="2.5" height="14" fill="#182238"/></svg>Middle state (median)</span>' +
        '<span><svg width="14" height="14"><rect x="6.5" y="3" width="1.5" height="8" fill="#b9bdc8"/></svg>Each other state</span></div><div class="st-strips">' +
        items.map(function (i) {
          var has = i.status === 'ok' && num(i.value), c = cmp[i.metric];
          var label = esc(i.label.replace(/ \(state\)$/, ''));
          var svg = '';
          if (has && c) {
            var lo = c.values[0], hi = c.values[c.values.length - 1], span = (hi - lo) || 1;
            var x = function (v) { return (4 + 92 * (v - lo) / span).toFixed(2) + '%'; };
            svg = '<svg role="img" aria-label="' + esc(i.label + ': ' + i.display + '. Middle of ' + c.n + ' states: ' + c.median + '.') + '"><line x1="4%" x2="96%" y1="15" y2="15" stroke="var(--v-grid)" stroke-width="2"/>' +
              c.values.map(function (v) { return '<line x1="' + x(v) + '" x2="' + x(v) + '" y1="10" y2="20" stroke="#b9bdc8" stroke-width="1.5"/>'; }).join('') +
              '<line x1="' + x(c.median) + '" x2="' + x(c.median) + '" y1="5" y2="25" stroke="#182238" stroke-width="2.5" data-tip="' + esc('Middle of ' + c.n + ' states: ' + c.median) + '"/>' +
              '<circle cx="' + x(i.value) + '" cy="15" r="6" fill="var(--v-mark)" stroke="#fff" stroke-width="2" data-tip="' + esc(H.name + ': ' + i.display) + '"/></svg>';
          } else if (has) {
            svg = '<span class="nd">' + (i.unit === 'cases' ? 'a count, so not compared across states of different sizes' : 'too few states report this to compare') + '</span>';
          } else {
            svg = '<span class="nd">' + esc((i.display || '').replace(/^not reported\s*/, '').replace(/^\((.*)\)$/, '$1')) + '</span>';
          }
          return '<div class="st-strip"><div class="lb">' + label + '<small>' + esc(short(i.feed)) + ' · ' + esc(has ? (i.quality || i.period) : i.period) + '</small></div><div class="mid">' + svg + '</div>' +
            '<div class="v">' + (has ? esc(i.display.replace(' per 100,000 people', ' per 100,000')) : 'not reported') + (has && c ? '<small>middle state ' + esc(String(c.median)) + '</small>' : '') + '</div></div>';
        }).join('') + '</div></div>';
    } else {
      html += unavailable('State-level figures are not available in this snapshot.');
    }

    // ---- all counties, behind a control
    var cols = COLS.filter(function (c) { return ok(c[0]) && !(ONE_STATE[c[0]] && !M[c[0]].n_counties); });
    var dropped = COLS.filter(function (c) { return !ok(c[0]); }).map(function (c) { return c[1]; });
    var cellFor = function (c, k) {
      var v = val(c, k), meta = M[k];
      if (v && typeof v === 'object') return '<td class="nd" data-v="">' + esc(v.t) + '</td>';
      if (!num(v)) return '<td class="nd" data-v="">' + esc(meta.no_data || 'no data') + '</td>';
      var cls = meta.classes && meta.classes[String(v)];
      if (cls) {
        var hi = (/_wval_level_max$/.test(k) && v >= 4) || (/_trend_4wk$/.test(k) && v === 1) || (k === 'ww_measles_detected_recent' && v === 1);
        return '<td data-v="' + v + '"><span class="lvl' + (hi ? ' hi' : '') + '">' + esc(cls) + '</span></td>';
      }
      return '<td class="r nw" data-v="' + v + '">' + (meta.unit === 'percent' ? esc(v) + '%' : fmt(v)) + '</td>';
    };
    html += '<details class="st-more" id="counties"><summary>Show all ' + fmt(N) + ' counties in a table</summary>' +
      '<div class="st-filter"><label class="sr-only" for="st-cq">Filter counties</label><input id="st-cq" type="search" placeholder="Filter counties by name" autocomplete="off"><span id="st-cn"></span></div>' +
      '<div class="tablewrap tall"><table class="bills" id="st-ctable"><thead><tr>' + th('County') + th('Population', 'r') +
      cols.map(function (c) { return th(c[1], M[c[0]].kind === 'category' || M[c[0]].kind === 'binary' ? '' : 'r'); }).join('') + '</tr></thead><tbody>' +
      C.map(function (c) {
        return '<tr data-q="' + esc(c.name.toLowerCase()) + '"><td class="nw" data-v="' + esc(c.name) + '">' + link(c) + '</td>' +
          '<td class="r nw" data-v="' + (num(c.population) ? c.population : '') + '">' + (num(c.population) ? fmt(c.population) : 'no data') + '</td>' +
          cols.map(function (k) { return cellFor(c, k[0]); }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      (dropped.length ? unavailable('Columns unavailable in this snapshot: ' + esc(dropped.join('; ')) + '.') : '') + '</details>';

    // ---- sources and rules, behind a control
    html += '<details class="st-more"><summary>Sources, periods and what "elevated" means</summary><div class="card note" style="margin-top:12px;">' +
      '<p>Each rule uses one published measure and one threshold. Nothing on this page is a combined score. "No data" is never drawn or counted as zero.</p>' +
      '<p><strong>Wastewater level High or Very high:</strong> the CDC wastewater viral activity level at the highest site in the county is High or Very high in the newest week. A county with no sampling site has no wastewater data; that does not mean no virus.</p>' +
      '<p><strong>Trend rising:</strong> What\'s In My County classifies the 4 week trend as Rising, which its methods define as the average (geometric mean) virus concentration of the last 2 weeks being at least 50% higher than in the 2 weeks before.</p>' +
      '<p><strong>Measles:</strong> at least 1 confirmed case in the county in the period named, or measles virus detected in either of the last 2 wastewater samples.</p>' +
      '<p><strong>Middle state:</strong> the median of the states and the District of Columbia that report the figure for the same period. It is not a national figure.</p>' +
      '<p>A period is the date the source gives for the value, or the first day of the span it covers. Snapshot of What\'s In My County data version ' + esc(H.source.data_version) + ', built ' + esc((H.source.built || '').slice(0, 10)) + '.</p>' +
      '<p>' + cols.map(function (c) {
        var meta = M[c[0]], f = (H.feeds || {})[meta.feed] || {};
        return '<strong>' + esc(c[1]) + ':</strong> ' + esc(meta.about || meta.label) + ' ' + esc(meta.basis ? meta.basis.charAt(0).toUpperCase() + meta.basis.slice(1) : '') +
          ', period ' + esc(meta.period || 'not given') + '. ' + esc(f.publisher || meta.feed) + (f.credit ? ' (' + esc(f.credit) + ')' : '') + '.';
      }).join(' ') + (G && G.source ? ' ' + esc(G.source) : '') + '</p></div></details>';
    html += '<p class="st-credit">' + esc(CREDIT) + (site ? ' · <a href="' + esc(site) + '" rel="noopener">whatsinmycounty.com</a>' : '') + '</p>';

    $('st-health').innerHTML = html;
    tips($('st-health'));
    sortable($('st-ctable'));
    filterable($('st-cq'), $('st-ctable'), $('st-cn'), 'counties');

    // ---- map behavior
    var sel = $('st-msel');
    if (!sel) return;
    var byFips = {}; C.forEach(function (c) { byFips[c.fips] = c; });
    var paths = Array.prototype.slice.call($('st-map').querySelectorAll('path'));
    var picked = null;
    var pick = function (c) {
      var k = sel.value;
      paths.forEach(function (p) { p.classList.toggle('sel', !!c && p.getAttribute('data-f') === c.fips); });
      $('st-pick').innerHTML = c
        ? '<strong>' + esc(c.name) + '</strong>' + esc(M[k].label) + ': ' + esc(show(k, val(c, k))) + '. ' + link(c, 'Open this county on What\'s In My County')
        : '<strong>Select a county</strong>Tap or point at the map to see a county\'s value and open its page.';
    };
    var paint = function () {
      var k = sel.value, meta = M[k], rule = MAPS.filter(function (x) { return x[0] === k; })[0];
      if (!meta.legend) meta.legend = { type: '', classes: [] };   // an older data file: every county reads as no data
      var counts = {}, nd = 0;
      paths.forEach(function (p) {
        var c = byFips[p.getAttribute('data-f')], v = val(c, k), cl = classOf(meta, v);
        p.setAttribute('fill', cl ? TONES[cl.tone] || TONES[3] : 'url(#st-hatch)');
        p.setAttribute('data-tip', c.name + ': ' + show(k, v));
        if (cl) counts[cl.label] = (counts[cl.label] || 0) + 1; else nd++;
      });
      var classes = meta.legend.classes || [];
      $('st-legend').innerHTML = classes.map(function (c) { return '<span><i style="background:' + (TONES[c.tone] || TONES[3]) + '"></i>' + esc(c.label) + '</span>'; }).join('') +
        (nd ? '<span><i class="nd"></i>' + esc(meta.no_data || 'no data') + '</span>' : '');
      // Ranked bars: counties in each class for a level, top counties for a count.
      var bars = '', head = '';
      if (meta.legend.type === 'categorical') {
        head = 'Counties at each level';
        var rows = classes.slice().reverse().map(function (c) { return [c.label, counts[c.label] || 0, TONES[c.tone], '']; });
        var mx = Math.max.apply(null, rows.map(function (r) { return r[1]; })) || 1;
        bars = rows.map(function (r) {
          return '<div class="st-bar"><span class="nm">' + esc(r[0]) + '</span><span class="tr">' + (r[1] ? '<i class="' + r[3] + '" style="width:' + (r[1] / mx * 100).toFixed(1) + '%;' + (r[2] ? 'background:' + r[2] + ';border:1px solid rgba(24,34,56,.18)' : '') + '"></i>' : '') + '</span><span class="v">' + r[1] + '</span></div>';
        }).join('') + (nd ? '<p class="st-src">' + nd + ' of ' + N + ' counties: ' + esc(meta.no_data || 'no data') + ' (hatched, not counted above).</p>' : '');
      } else {
        var low = k === 'mmr2_kindergarten_ca_low';
        var top = withValue(k).filter(function (c) { return low || val(c, k) > 0; })
          .sort(function (a, z) { return low ? val(a, k) - val(z, k) : val(z, k) - val(a, k); }).slice(0, 8);
        head = top.length ? (low ? 'Lowest counties' : 'Highest counties') : '';
        var mx2 = Math.max.apply(null, top.map(function (c) { return val(c, k); })) || 1;
        bars = top.length ? top.map(function (c) {
          return '<div class="st-bar"><span class="nm">' + link(c, c.name.replace(/ (County|Parish|Borough|Census Area|Municipality)$/, '')) + '</span><span class="tr"><i style="width:' + (val(c, k) / mx2 * 100).toFixed(1) + '%"></i></span><span class="v">' + esc(show(k, val(c, k))) + '</span></div>';
        }).join('') : '<p class="st-src">No county with a value above zero.</p>';
      }
      $('st-rankh').textContent = head;
      $('st-rank').innerHTML = bars;
      var f = (H.feeds || {})[meta.feed] || {};
      $('st-mapsrc').innerHTML = esc(meta.about || meta.label) + ' ' + (rule && rule[2] ? esc(rule[2]) + ' ' : '') + meta.n_counties + ' of ' + N + ' counties have a value; hatched counties have none. Source: ' +
        esc(f.publisher || meta.feed) + (f.credit ? ' (' + esc(f.credit) + ')' : '') + ', period ' + esc(meta.period || 'not given') + ', via What\'s In My County.';
      pick(picked);
    };
    // Open on the first measure in the menu that has a county at an elevated value (level High or
    // Very high, a detection, or at least 1 case); otherwise the first in the menu.
    var hot = function (k) {
      return C.some(function (c) { var v = val(c, k); return num(v) && (/_wval_level_max$/.test(k) ? v >= 4 : (k === 'ww_measles_detected_recent' || /^measles_cases/.test(k)) && v >= 1); });
    };
    var first = maps.filter(function (x) { return hot(x[0]); })[0];
    if (first) sel.value = first[0];
    sel.addEventListener('change', paint);
    $('st-map').addEventListener('click', function (e) {
      var f = e.target.getAttribute && e.target.getAttribute('data-f');
      if (f) { picked = byFips[f]; pick(picked); }
    });
    paint();
  }

  var lo = code.toLowerCase();
  Promise.all([getJSON('/data/states/' + lo + '.health.json'), getJSON('/data/states/' + lo + '.geo.json').catch(function () { return null; })])
    .then(function (r) { renderHealth(r[0], r[1]); })
    .catch(function () {
      $('st-health').innerHTML = unavailable('Public health data for this state is unavailable right now. The bills and legislators on this page are not affected. ' +
        'The data comes from What\'s In My County, published by Priori Intelligence.');
    });

  // ------------------------------------------------------------------ legislators and members of Congress

  function contact(p) {
    var a = [];
    if (p.phone) a.push('<a href="tel:' + esc(p.phone.replace(/[^0-9+]/g, '')) + '">Call ' + esc(p.phone) + '</a>');
    if (p.email && /^[^\s@<>"]+@[^\s@<>"]+$/.test(p.email)) a.push('<a href="mailto:' + esc(p.email) + '">Email</a>');
    if (http(p.contact_form)) a.push('<a href="' + esc(p.contact_form) + '" rel="noopener">Contact form</a>');
    if (http(p.website)) a.push('<a href="' + esc(p.website) + '" rel="noopener">Website</a>');
    return a.length ? '<span class="st-acts">' + a.join('') + '</span>' : '<span class="nd">no contact on file</span>';
  }
  function seat(p) {
    var d = p.district ? (/^\d+$/.test(p.district) ? 'District ' + p.district : p.district) : (p.chamber === 'Senate' && p.office === 'U.S. Senate' ? 'Statewide' : '');
    return esc(p.office) + (d ? ', ' + esc(d) : '');
  }
  function peopleTable(id, list) {
    return '<div class="tablewrap' + (list.length > 25 ? ' tall' : '') + '"><table class="bills" id="' + id + '"><thead><tr>' + th('Name') + th('Office') + th('Party') +
      '<th>Contact</th>' + th('Pro-science acts', 'r') + th('Anti-science acts', 'r') + '</tr></thead><tbody>' +
      list.map(function (p, i) {
        var name = p.slug ? '<a href="/record/' + encodeURIComponent(p.slug) + '">' + esc(p.name) + '</a>' : esc(p.name);
        var acts = function (n) { return p.slug ? '<td class="num r" data-v="' + n + '">' + n + '</td>' : '<td class="nd r" data-v="">not shown</td>'; };
        return '<tr data-q="' + esc((p.name + ' ' + p.office + ' ' + p.district + ' ' + p.party).toLowerCase()) + '"><td class="nw" data-v="' + esc(p.name) + '">' + name + '</td>' +
          '<td data-v="' + (1000 + i) + '">' + seat(p) + '</td><td data-v="' + esc(p.party) + '">' + esc(p.party) + '</td><td>' + contact(p) + '</td>' +
          acts(p.pro_acts) + acts(p.anti_acts) + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  getJSON('/data/states/' + code.toLowerCase() + '.json').then(function (P) {
    var asof = (P.generated_at || '').slice(0, 10);
    var html = '<p class="st-line">Everyone on file for ' + esc(P.name) + ' with ways to reach them; to write to your own legislators with a ready message, use <a href="outreach.html">Take Action</a>.</p>' +
      '<details class="st-more"><summary>What the act counts mean</summary><div class="card note" style="margin-top:12px;"><p>Counts are official acts on bills SAFE Action has classified as pro-science or anti-science: ' +
      'sponsorships, cosponsorships and recorded votes. Classifications apply to bills, not people. A zero means no tracked act matched, not that the legislator was reviewed and found neutral. ' +
      'Where two legislators cannot be told apart in the record data, no count or record link is shown for either. ' +
      'The method is on the <a href="scorecard.html">Science Scorecard</a>.</p></div></details>';
    html += '<h3>Members of Congress (' + P.congress.length + ')</h3>';
    html += P.congress.length ? peopleTable('st-cong', P.congress) : unavailable('No members of Congress are on file for this state.');
    html += '<h3>State legislators (' + P.legislature.length + ')</h3>';
    if (P.legislature.length) {
      html += '<div class="st-filter"><label class="sr-only" for="st-lq">Filter legislators</label><input id="st-lq" type="search" placeholder="Filter by name, chamber, district or party" autocomplete="off"><span id="st-ln"></span></div>' +
        peopleTable('st-leg', P.legislature);
    } else {
      html += unavailable('No state legislators are on file for this state.');
    }
    html += '<p class="st-src">Source: SAFE Action legislator database (Open States, state legislature sites and the congress-legislators project), as of ' + esc(asof) +
      '. Act counts from the Science Scorecard, as of ' + esc((P.scorecard_generated_at || '').slice(0, 10)) + '. To report an error, write to board@scienceandfreedom.com.</p>';
    $('st-people').innerHTML = html;
    if ($('st-cong')) sortable($('st-cong'));
    if ($('st-leg')) { sortable($('st-leg')); filterable($('st-lq'), $('st-leg'), $('st-ln'), 'legislators'); }
  }).catch(function () {
    $('st-people').innerHTML = unavailable('The legislator list for this state is unavailable right now. You can still find your legislators by address on <a href="outreach.html">Take Action</a>.');
  });
})();
