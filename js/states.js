/* All-states index: /states. Reads /data/live.json (bill counts, same source as the tracker)
 * and /data/states/index.json (written by scripts/build_state_data.py). Either can fail alone. */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  var num = function (v) { return typeof v === 'number' && isFinite(v); };
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
  var getJSON = function (url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function () { return null; });
  };
  var cell = function (v, missing) {
    return num(v) ? '<td class="num r" data-v="' + v + '">' + fmt(v) + '</td>' : '<td class="nd r" data-v="">' + missing + '</td>';
  };

  Promise.all([getJSON('/data/live.json'), getJSON('/data/states/index.json')]).then(function (res) {
    var L = res[0], I = res[1];
    var S = (I && I.states) || {};
    var codes = Object.keys(S).length ? Object.keys(S) : (L ? Object.keys(L.states).filter(function (c) { return c !== 'US'; }) : []);
    if (!codes.length) {
      $('ss-rows').innerHTML = '<tr><td colspan="9">State data could not be loaded. Try again shortly, or use the <a href="tracker.html">live tracker</a>.</td></tr>';
      return;
    }
    var name = function (c) { return (S[c] && S[c].name) || (L && L.states[c] && L.states[c].name) || c; };
    codes.sort(function (a, z) { return name(a).localeCompare(name(z)); });
    $('ss-chips').innerHTML = codes.map(function (c) { return '<a href="/' + c.toLowerCase() + '" title="' + esc(name(c)) + '">' + c + '</a>'; }).join('');
    $('ss-rows').innerHTML = codes.map(function (c) {
      var b = (L && L.states[c]) || {}, s = S[c] || {}, h = s.health || {};
      var people = num(s.congress) && num(s.legislature) ? s.congress + s.legislature : null;
      var none = L ? 'no data' : 'unavailable', hn = s.health ? 'no data' : 'unavailable';
      return '<tr><td class="nw" data-v="' + esc(name(c)) + '"><a href="/' + c.toLowerCase() + '">' + esc(name(c)) + '</a></td>' +
        cell(b.pro, none) + cell(b.anti, none) + cell(b.tracked, none) +
        cell(h.counties_total, hn) + cell(h.ww_covid_counties, hn) +
        (num(h.ww_covid_high_counties) ? '<td class="r nw" data-v="' + h.ww_covid_high_counties + '"><span class="num">' + h.ww_covid_high_counties + '</span> of ' + h.ww_covid_level_counties + '</td>' : '<td class="nd r" data-v="">' + hn + '</td>') +
        cell(h.measles_ytd_county_sum, hn) + cell(people, 'unavailable') + '</tr>';
    }).join('');

    var src = [];
    if (L) src.push('Bill counts: SAFE Action tracker (LegiScan, GovInfo and Open States), as of ' + esc((L.crawl_generated_at || L.generated_at || '').slice(0, 10)) + '.');
    else src.push('Bill counts are unavailable right now.');
    var first = codes.map(function (c) { return S[c] && S[c].health; }).filter(Boolean)[0];
    if (first) {
      var p = first.periods || {};
      src.push('County figures: snapshot of What\'s In My County data version ' + esc(first.data_version) + '. ' +
        'Wastewater sites: counties with at least one treatment plant reporting COVID-19 samples, period ' + esc(p.ww_covid_n_sites || 'not given') + '. ' +
        'Wastewater level: of the counties with a published level, those where the Centers for Disease Control and Prevention wastewater viral activity level at the highest site is High or Very high, period ' + esc(p.ww_covid_wval_level_max || 'not given') + '. ' +
        'Measles: confirmed cases added up from county counts (Johns Hopkins University Measles Tracking Team Data, CC BY 4.0), period ' + esc(p.measles_cases_ytd || 'not given') +
        '; this is a sum of county values, not a state\'s official total. Each is one published measure; none is a combined score.');
    } else {
      src.push('County figures from What\'s In My County are unavailable right now.');
    }
    if (I) src.push('Legislators: SAFE Action legislator database (Open States, state legislature sites and the congress-legislators project).');
    $('ss-src').innerHTML = src.join(' ');

    var table = $('ss-table'), ths = table.querySelectorAll('thead th');
    Array.prototype.forEach.call(ths, function (th, i) {
      th.querySelector('button').addEventListener('click', function () {
        var dir = th.getAttribute('aria-sort') === (i ? 'descending' : 'ascending') ? (i ? 1 : -1) : (i ? -1 : 1);
        Array.prototype.forEach.call(ths, function (t) { t.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        var body = table.tBodies[0], rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (a, z) {
          var x = a.cells[i].getAttribute('data-v'), y = z.cells[i].getAttribute('data-v');
          if (x === '') return y === '' ? 0 : 1;
          if (y === '') return -1;
          return (i ? Number(x) - Number(y) : x.localeCompare(y)) * dir;
        });
        rows.forEach(function (r) { body.appendChild(r); });
      });
    });
  });
})();
