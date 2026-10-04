/* State bill report: /wv, /tx ... (rewritten to state.html). Reads /data/live.json. */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var m = location.pathname.match(/^\/([a-zA-Z]{2})\/?$/) || location.search.match(/[?&]s=([a-zA-Z]{2})/);
  var code = m ? m[1].toUpperCase() : '';
  fetch('/data/live.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (D) {
    var st = D.states[code];
    document.getElementById('st-states').innerHTML = Object.keys(D.states).filter(function (c) { return c !== 'US'; })
      .map(function (c) { return '<a href="/' + c.toLowerCase() + '">' + c + '</a>'; }).join('');
    if (!st) { document.getElementById('st-name').textContent = 'Pick a state'; document.getElementById('st-rows').innerHTML = '<tr><td colspan="5">Choose a state below.</td></tr>'; return; }
    document.title = st.name + ' science bills - SAFE Action';
    document.getElementById('st-name').textContent = st.name;
    document.getElementById('st-eyebrow').textContent = 'STATE BILL REPORT · ' + code;
    document.getElementById('sb-label').textContent = st.name.toUpperCase() + ' · ' + st.anti + ' ANTI · ' + st.pro + ' PRO';
    document.getElementById('st-pro').textContent = st.pro;
    document.getElementById('st-anti').textContent = st.anti;
    document.getElementById('st-rec').href = 'records.html?state=' + code;
    document.getElementById('st-vol').href = 'volunteer.html?state=' + code;
    document.getElementById('st-asof').textContent = 'Data as of ' + (D.crawl_generated_at || D.generated_at).slice(0, 10) + '.';
    var bills = D.bills.filter(function (b) { return b.state === code; });
    var ORD = { pro: 0, anti: 1, watch: 2 }; bills.sort(function (a, z) { return ORD[a.type] - ORD[z.type]; });
    document.getElementById('st-rows').innerHTML = bills.length ? bills.map(function (b) {
      var num = b.source ? '<a href="' + esc(b.source) + '" rel="noopener">' + esc(b.number) + '</a>' : esc(b.number);
      return '<tr><td class="num">' + num + '</td><td><span class="tag ' + b.type + '">' + (b.type === 'watch' ? 'ONE TO WATCH' : b.type.toUpperCase()) + '</span></td><td>' + esc(b.title) +
        '</td><td>' + esc(b.status) + '</td><td class="num" style="font-weight:400">' + esc(b.lastActionDate || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="5">No pro- or anti-science bills on file for this session.</td></tr>';
  });
})();
