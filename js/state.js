/* State report: /wv, /tx ... (rewritten to state.html).
 *
 * Three independent loads, so one failing never blanks the others:
 *   /data/live.json                 bills (same source and labels as the tracker and /live)
 *   /data/states/<xx>.health.json   public health snapshot from What's In My County
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

  var STATUS_ORDER = ['Signed into Law', 'Passed Both Chambers', 'Passed One Chamber', 'Passed House', 'Passed Senate',
    'In Committee', 'Introduced', 'Vetoed', 'Failed', 'Died in Committee'];
  function statusCounts(bills) {
    var c = {};
    bills.forEach(function (b) { var s = b.status || 'Status not listed'; c[s] = (c[s] || 0) + 1; });
    return Object.keys(c).sort(function (a, z) {
      var i = STATUS_ORDER.indexOf(a), j = STATUS_ORDER.indexOf(z);
      return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || (a < z ? -1 : 1);
    }).map(function (s) { return c[s] + ' ' + esc(s).toLowerCase(); }).join(', ');
  }

  getJSON('/data/live.json').then(function (D) {
    var st = D.states[code];
    $('st-states').innerHTML = Object.keys(D.states).filter(function (c) { return c !== 'US'; })
      .map(function (c) { return '<a href="/' + c.toLowerCase() + '">' + c + '</a>'; }).join('');
    if (!st || code === 'US') {
      $('st-name').textContent = 'Pick a state';
      $('st-rows').innerHTML = '<tr><td colspan="5">Choose a state below, or see <a href="/states">all states</a>.</td></tr>';
      return;
    }
    document.title = st.name + ' state report - SAFE Action';
    $('st-name').textContent = st.name;
    $('st-eyebrow').textContent = 'STATE REPORT · ' + code;
    $('sb-label').textContent = st.name.toUpperCase() + ' · ' + st.anti + ' ANTI · ' + st.pro + ' PRO';
    $('st-pro').textContent = st.pro;
    $('st-anti').textContent = st.anti;
    $('st-rec').href = 'records.html?state=' + code;
    $('st-vol').href = 'volunteer.html?state=' + code;
    var asof = (D.crawl_generated_at || D.generated_at).slice(0, 10);
    $('st-asof').textContent = 'Data as of ' + asof + '.';
    var bills = D.bills.filter(function (b) { return b.state === code; });
    var ORD = { pro: 0, anti: 1, watch: 2 }; bills.sort(function (a, z) { return ORD[a.type] - ORD[z.type]; });
    var of = function (t) { return bills.filter(function (b) { return b.type === t; }); };
    var pro = of('pro'), anti = of('anti'), watch = of('watch');
    var parts = [];
    if (pro.length) parts.push('<strong>' + pro.length + ' pro-science</strong> (' + statusCounts(pro) + ')');
    if (anti.length) parts.push('<strong>' + anti.length + ' anti-science</strong> (' + statusCounts(anti) + ')');
    if (watch.length) parts.push('<strong>' + watch.length + ' one to watch</strong>, not counted as pro or anti (' + statusCounts(watch) + ')');
    $('st-billsum').innerHTML = (parts.length
      ? 'By status: ' + parts.join('; ') + '. '
      : 'SAFE Action has no pro-science or anti-science bills on file for ' + esc(st.name) + ' this session. ') +
      fmt(st.tracked) + ' bills are monitored in this state in total; the rest are not classified as pro-science or anti-science. ' +
      'Source: LegiScan, GovInfo and Open States, as of ' + asof + '.';
    $('st-rows').innerHTML = bills.length ? bills.map(function (b) {
      var src = http(b.source);
      var n = src ? '<a href="' + esc(src) + '" rel="noopener">' + esc(b.number) + '</a>' : esc(b.number);
      return '<tr><td class="num">' + n + '</td><td><span class="tag ' + esc(b.type) + '">' + (b.type === 'watch' ? 'ONE TO WATCH' : esc(b.type).toUpperCase()) + '</span></td><td>' + esc(b.title) +
        '</td><td>' + esc(b.status) + '</td><td class="num" style="font-weight:400">' + esc(b.lastActionDate || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="5">No pro- or anti-science bills on file for this session.</td></tr>';
  }).catch(function () {
    $('st-rows').innerHTML = '<tr><td colspan="5">Bill data could not be loaded. Try again shortly, or use the <a href="tracker.html">live tracker</a>.</td></tr>';
  });

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
  var PATHOGENS = [
    { id: 'covid', name: 'COVID-19' },
    { id: 'flu_a', name: 'Influenza A' },
    { id: 'rsv', name: 'Respiratory syncytial virus (RSV)' }
  ];
  // County table columns: [measure key, column heading]. Each column is one published measure.
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
  // Measures published for one state only: the column is dropped elsewhere instead of reading "no data".
  var ONE_STATE = { mmr2_kindergarten_ca_low: 1, mmr2_kindergarten_ca_high: 1 };

  function unavailable(msg) {
    return '<div class="st-unavail">' + msg + '</div>';
  }

  function renderHealth(H) {
    var M = H.measures || {}, C = H.counties || [], N = H.counties_total, site = http(H.source && H.source.site);
    var ok = function (k) { return M[k] && M[k].available; };
    var val = function (c, k) { return c.v ? c.v[k] : undefined; };
    var feedName = function (id) { var f = (H.feeds || {})[id]; return f ? f.publisher : ''; };
    var src = function (k) {  // "Period: DATE. Source: PUBLISHER." The date is the measure's own period start.
      var p = feedName(M[k].feed);
      return 'Period: ' + esc(M[k].period || 'not given') + (p ? '. Source: ' + esc(p) : '') + ', via What\'s In My County.';
    };
    var countyUrl = function (c) { return site ? site + '/county/' + encodeURIComponent(c.fips) : ''; };
    var link = function (c) { var u = countyUrl(c); return u ? '<a href="' + esc(u) + '" rel="noopener">' + esc(c.name) + '</a>' : esc(c.name); };
    var names = function (list) {
      if (!list.length) return '';
      var shown = list.slice(0, 12).map(link).join(', ');
      return shown + (list.length > 12 ? ', and ' + (list.length - 12) + ' more (sort the county table to see all)' : '');
    };
    var withValue = function (k) { return C.filter(function (c) { return num(val(c, k)); }); };
    var html = '';

    html += '<p class="st-credit">' + esc(CREDIT) + '</p>';
    html += '<p class="st-line">This section reports public data. It is not medical advice. It is a snapshot of ' +
      (site ? '<a href="' + esc(site) + '" rel="noopener">What\'s In My County</a>' : 'What\'s In My County') +
      ' data version ' + esc(H.source.data_version) + ' (built ' + esc((H.source.built || '').slice(0, 10)) +
      '). Each figure below carries its own source and period; a period is the date the source gives for the value, or the first day of the span it covers. ' + esc(H.name) + ' has ' + fmt(N) +
      (N === 1 ? ' county or county equivalent' : ' counties or county equivalents') + '.</p>';
    html += '<p class="st-src">Terms: CDC is the Centers for Disease Control and Prevention. EPA is the Environmental Protection Agency. ' +
      'MMR is the measles, mumps and rubella vaccine. RSV is respiratory syncytial virus. JHU is Johns Hopkins University.</p>';

    // ---- state-level figures
    html += '<h3>State-level figures</h3>';
    var ctx = H.state_context || {};
    if (ctx.available && ctx.items.length) {
      html += '<p class="st-line">These are statewide values for ' + esc(H.name) + '. They are not county values and do not describe any one county.</p>';
      html += '<div class="tablewrap"><table class="bills"><thead><tr><th>Statewide measure</th><th class="r">Value</th><th>Period</th><th>Source</th></tr></thead><tbody>' +
        ctx.items.map(function (i) {
          var has = i.status === 'ok' && i.value !== null && i.value !== undefined;
          var f = (H.feeds || {})[i.feed] || {};
          return '<tr><td>' + esc(i.label) + '</td>' +
            (has ? '<td class="num r">' + esc(i.display) + '</td>' : '<td class="nd r">' + esc(i.display || 'not reported') + '</td>') +
            '<td class="nw">' + esc(i.period) + (i.quality && has ? '<br><span class="st-src">' + esc(i.quality) + '</span>' : '') + '</td>' +
            '<td>' + esc(f.publisher || i.feed) + (f.credit ? '<br><span class="st-src">' + esc(f.credit) + '</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      html += unavailable('State-level figures are not available in this snapshot.');
    }

    // ---- county summary
    html += '<h3>County summary</h3>';
    html += '<p class="st-line">Each line counts ' + esc(H.name) + '\'s counties on one measure. County values only. ' +
      '"No data" is not the same as zero: a county with no sampling site or no published count is left out of the comparison, and each line says how many counties it compares.</p>';

    var wwRows = PATHOGENS.map(function (p) {
      var kS = 'ww_' + p.id + '_n_sites', kL = 'ww_' + p.id + '_wval_level_max', kT = 'ww_' + p.id + '_trend_4wk';
      var cell = function (k, test, noun) {
        if (!ok(k)) return '<td class="nd">unavailable in this snapshot</td>';
        var have = withValue(k), hit = have.filter(function (c) { return test(val(c, k)); });
        return '<td><strong>' + hit.length + '</strong> of ' + have.length + ' ' + noun + '<br><span class="st-src">period ' + esc(M[k].period) + '</span></td>';
      };
      var sites = ok(kS)
        ? '<td><strong>' + withValue(kS).filter(function (c) { return val(c, kS) >= 1; }).length + '</strong> of ' + N + ' counties<br><span class="st-src">period ' + esc(M[kS].period) + '</span></td>'
        : '<td class="nd">unavailable in this snapshot</td>';
      return '<tr><td>' + esc(p.name) + '</td>' + sites +
        cell(kL, function (v) { return v >= 4; }, 'counties with a published level') +
        cell(kT, function (v) { return v === 1; }, 'counties with a trend') + '</tr>';
    }).join('');
    html += '<div class="tablewrap"><table class="bills"><thead><tr><th>Wastewater, by virus</th><th>Counties with a sampling site reporting</th><th>Level High or Very high</th><th>Trend rising over 4 weeks</th></tr></thead><tbody>' + wwRows + '</tbody></table></div>';
    PATHOGENS.forEach(function (p) {
      var kL = 'ww_' + p.id + '_wval_level_max';
      if (!ok(kL)) return;
      var hi = C.filter(function (c) { return num(val(c, kL)) && val(c, kL) >= 4; });
      if (hi.length) html += '<p class="st-line"><strong>' + esc(p.name) + ' wastewater level High or Very high:</strong> ' + names(hi) + '.</p>';
    });
    html += '<p class="st-src">Source for wastewater rows: Centers for Disease Control and Prevention wastewater surveillance, counted from sampling sites in each county, via What\'s In My County. A county with no sampling site has no wastewater data; that does not mean no virus.</p>';

    var facts = [];
    var fact = function (n, of, label, sub, list) {
      facts.push('<div class="st-fact"><div class="n">' + n + (of ? ' <small>' + of + '</small>' : '') + '</div><div class="l">' + label + '</div>' +
        (list ? '<div class="names">' + list + '</div>' : '') + '<div class="s">' + sub + '</div></div>');
    };
    var gone = [];
    if (ok('ww_measles_detected_recent')) {
      var mw = withValue('ww_measles_detected_recent'), md = mw.filter(function (c) { return val(c, 'ww_measles_detected_recent') === 1; });
      fact(md.length, 'of ' + mw.length + ' counties with measles sampling', 'Counties where measles virus was detected in wastewater (either of the last 2 samples)',
        src('ww_measles_detected_recent') + ' Not detected does not mean absent.', names(md));
    } else gone.push('measles virus in wastewater');
    if (ok('measles_cases_ytd')) {
      var my = withValue('measles_cases_ytd'), myHit = my.filter(function (c) { return val(c, 'measles_cases_ytd') >= 1; });
      var sum = my.reduce(function (a, c) { return a + val(c, 'measles_cases_ytd'); }, 0);
      fact(myHit.length, 'of ' + my.length + ' counties with a published count', 'Counties with at least 1 confirmed measles case this year', src('measles_cases_ytd'),
        names(myHit.slice().sort(function (a, z) { return val(z, 'measles_cases_ytd') - val(a, 'measles_cases_ytd'); })));
      fact(fmt(sum), '', 'Confirmed measles cases this year, added up from county counts',
        src('measles_cases_ytd') + ' This is a sum of county values, not the state\'s official total; cases a state has not assigned to a county are not in it.');
    } else gone.push('measles cases this year');
    if (ok('measles_cases_4wk')) {
      var m4 = withValue('measles_cases_4wk'), m4Hit = m4.filter(function (c) { return val(c, 'measles_cases_4wk') >= 1; });
      fact(m4Hit.length, 'of ' + m4.length + ' counties with a published count', 'Counties with at least 1 confirmed measles case in the last 4 weeks', src('measles_cases_4wk'), names(m4Hit));
    } else gone.push('measles cases in the last 4 weeks');
    [['superfund_npl_final', 'Superfund sites on the National Priorities List, added up from county counts'],
     ['water_systems_hb_violation_5y', 'Water systems with a health-based violation in 5 years, added up from county counts'],
     ['dc_locations_osm', 'Data center locations recorded in OpenStreetMap, added up from county counts']].forEach(function (x) {
      var k = x[0];
      if (!ok(k)) { gone.push(M[k] && M[k].label ? M[k].label : k); return; }
      var have = withValue(k), tot = have.reduce(function (a, c) { return a + val(c, k); }, 0);
      var nz = have.filter(function (c) { return val(c, k) >= 1; }).length;
      fact(fmt(tot), 'in ' + nz + ' of ' + N + ' counties', x[1], src(k) +
        (k === 'dc_locations_osm' ? ' There is no official registry of data centers; open data is incomplete.' : ''));
    });
    html += '<div class="st-facts">' + facts.join('') + '</div>';
    if (gone.length) html += unavailable('Unavailable in this snapshot: ' + esc(gone.join('; ')) + '.');

    html += '<div class="card note" style="margin-top:18px;"><span class="k">WHAT "ELEVATED" MEANS ON THIS PAGE</span>' +
      '<p>Each rule uses one published measure and one threshold. Nothing here is a combined score.</p>' +
      '<p><strong>Wastewater level High or Very high:</strong> the CDC wastewater viral activity level at the highest site in the county is High or Very high in the newest week.</p>' +
      '<p><strong>Trend rising:</strong> What\'s In My County classifies the 4 week trend as Rising, which its methods define as the average (geometric mean) virus concentration of the last 2 weeks being at least 50% higher than in the 2 weeks before.</p>' +
      '<p><strong>Measles:</strong> at least 1 confirmed case in the county in the period named, or measles virus detected in either of the last 2 wastewater samples.</p></div>';

    // ---- county table
    html += '<h3 id="counties">Counties</h3>';
    var cols = COLS.filter(function (c) { return ok(c[0]) && !(ONE_STATE[c[0]] && !M[c[0]].n_counties); });
    var dropped = COLS.filter(function (c) { return !ok(c[0]); }).map(function (c) { return c[1]; });
    html += '<p class="st-line">Select a column heading to sort. Each county name opens its page on What\'s In My County, which has every measure, its method and its history.</p>';
    html += '<div class="st-filter"><label class="sr-only" for="st-cq">Filter counties</label><input id="st-cq" type="search" placeholder="Filter counties by name" autocomplete="off"><span id="st-cn"></span></div>';
    var cellFor = function (c, k) {
      var v = val(c, k), meta = M[k];
      if (v && typeof v === 'object') return '<td class="nd" data-v="">' + esc(v.t) + '</td>';
      if (!num(v)) return '<td class="nd" data-v="">' + esc(meta.no_data || 'no data') + '</td>';
      var cls = meta.classes && meta.classes[String(v)];
      if (cls) {
        var hi = (/_wval_level_max$/.test(k) && v >= 4) || (/_trend_4wk$/.test(k) && v === 1) || (k === 'ww_measles_detected_recent' && v === 1);
        return '<td data-v="' + v + '"><span class="lvl' + (hi ? ' hi' : '') + '">' + esc(cls) + '</span></td>';
      }
      var pct = meta.unit === 'percent';
      return '<td class="r nw" data-v="' + v + '">' + (pct ? esc(v) + '%' : fmt(v)) + '</td>';
    };
    html += '<div class="tablewrap tall"><table class="bills" id="st-ctable"><thead><tr>' + th('County') + th('Population', 'r') +
      cols.map(function (c) { return th(c[1], M[c[0]].kind === 'category' || M[c[0]].kind === 'binary' ? '' : 'r'); }).join('') + '</tr></thead><tbody>' +
      C.map(function (c) {
        return '<tr data-q="' + esc(c.name.toLowerCase()) + '"><td class="nw" data-v="' + esc(c.name) + '">' + link(c) + '</td>' +
          '<td class="r nw" data-v="' + (num(c.population) ? c.population : '') + '">' + (num(c.population) ? fmt(c.population) : 'no data') + '</td>' +
          cols.map(function (k) { return cellFor(c, k[0]); }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (dropped.length) html += unavailable('Columns unavailable in this snapshot: ' + esc(dropped.join('; ')) + '.');
    html += '<p class="st-src"><strong>County table sources.</strong> ' + cols.map(function (c) {
      var meta = M[c[0]], f = (H.feeds || {})[meta.feed] || {};
      return '<strong>' + esc(c[1]) + ':</strong> ' + esc(meta.about || meta.label) + ' ' + esc(meta.basis ? meta.basis.charAt(0).toUpperCase() + meta.basis.slice(1) : '') +
        ', period ' + esc(meta.period || 'not given') + '. ' + esc(f.publisher || meta.feed) + (f.credit ? ' (' + esc(f.credit) + ')' : '') + '.';
    }).join(' ') + ' Population: county population as listed by What\'s In My County.</p>';
    html += '<p class="st-credit">' + esc(CREDIT) + '</p>';

    $('st-health').innerHTML = html;
    sortable($('st-ctable'));
    filterable($('st-cq'), $('st-ctable'), $('st-cn'), 'counties');
  }

  getJSON('/data/states/' + code.toLowerCase() + '.health.json').then(renderHealth).catch(function () {
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
        var acts = function (n) { return p.slug ? '<td class="num r" data-v="' + n + '">' + n + '</td>' : '<td class="nd r" data-v="">no record page</td>'; };
        return '<tr data-q="' + esc((p.name + ' ' + p.office + ' ' + p.district + ' ' + p.party).toLowerCase()) + '"><td class="nw" data-v="' + esc(p.name) + '">' + name + '</td>' +
          '<td data-v="' + (1000 + i) + '">' + seat(p) + '</td><td data-v="' + esc(p.party) + '">' + esc(p.party) + '</td><td>' + contact(p) + '</td>' +
          acts(p.pro_acts) + acts(p.anti_acts) + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  getJSON('/data/states/' + code.toLowerCase() + '.json').then(function (P) {
    var asof = (P.generated_at || '').slice(0, 10);
    var html = '<p class="st-line">To write to the legislators for your own address with a ready message, use <a href="outreach.html">Take Action</a>. ' +
      'The tables below list everyone on file for ' + esc(P.name) + ', with the contact details on file for each. A name links to that person\'s record page.</p>' +
      '<div class="card note" style="margin-top:12px;"><span class="k">ABOUT THE ACT COUNTS</span><p>Counts are official acts on bills SAFE Action has classified as pro-science or anti-science: ' +
      'sponsorships, cosponsorships and recorded votes. Classifications apply to bills, not people. A zero means no tracked act matched, not that the legislator was reviewed and found neutral. ' +
      'The method is on the <a href="scorecard.html">Science Scorecard</a>.</p></div>';
    html += '<h3>Members of Congress (' + P.congress.length + ')</h3>';
    html += P.congress.length ? peopleTable('st-cong', P.congress) : unavailable('No members of Congress are on file for this state.');
    html += '<h3>State legislators (' + P.legislature.length + ')</h3>';
    if (P.legislature.length) {
      html += '<div class="st-filter"><label class="sr-only" for="st-lq">Filter legislators</label><input id="st-lq" type="search" placeholder="Filter by name, chamber, district or party" autocomplete="off"><span id="st-ln"></span></div>' +
        peopleTable('st-leg', P.legislature);
    } else {
      html += unavailable('No state legislators are on file for this state.');
    }
    html += '<p class="st-src">Source: SAFE Action legislator database (LegiScan, Open States and the congress-legislators project), as of ' + esc(asof) +
      '. Act counts from the Science Scorecard, as of ' + esc((P.scorecard_generated_at || '').slice(0, 10)) + '. To report an error, write to board@scienceandfreedom.com.</p>';
    $('st-people').innerHTML = html;
    if ($('st-cong')) sortable($('st-cong'));
    if ($('st-leg')) { sortable($('st-leg')); filterable($('st-lq'), $('st-leg'), $('st-ln'), 'legislators'); }
  }).catch(function () {
    $('st-people').innerHTML = unavailable('The legislator list for this state is unavailable right now. You can still find your legislators by address on <a href="outreach.html">Take Action</a>.');
  });
})();
