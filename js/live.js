/* SAFE Live: streamer mode presenter. Reads /data/live.json (scripts/build_live.py). */
(function () {
  'use strict';

  var TILE = { AK:[0,0],ME:[10,0],WI:[5,1],VT:[9,1],NH:[10,1],WA:[0,2],ID:[1,2],MT:[2,2],ND:[3,2],MN:[4,2],IL:[5,2],MI:[6,2],NY:[8,2],MA:[9,2],
    OR:[0,3],NV:[1,3],WY:[2,3],SD:[3,3],IA:[4,3],IN:[5,3],OH:[6,3],PA:[7,3],NJ:[8,3],CT:[9,3],RI:[10,3],CA:[0,4],UT:[1,4],CO:[2,4],NE:[3,4],
    MO:[4,4],KY:[5,4],WV:[6,4],VA:[7,4],MD:[8,4],DE:[9,4],AZ:[1,5],NM:[2,5],KS:[3,5],AR:[4,5],TN:[5,5],NC:[6,5],SC:[7,5],DC:[8,5],
    OK:[3,6],LA:[4,6],MS:[5,6],AL:[6,6],GA:[7,6],HI:[0,7],TX:[3,7],FL:[8,7],US:[10,7] };
  var STAGES = [['introduced','Introduced'],['committee','In committee'],['passed1','Passed one chamber'],['passed2','Passed both'],['signed','Signed into law']];
  var LANES = STAGES.concat([['dead','Dead']]);
  var STAGE_RANK = { introduced:0, committee:1, passed1:2, passed2:3, signed:4, dead:-1 };

  var D = null;               // live.json
  var byState = {};           // code -> {pro:[], anti:[]}
  var S = { scene:'map', state:'WV', billIdx:-1, beat:0, vs:['TX','MN'], spot:null, stamp:false, prevScene:'docket' };
  var buf = '', bufTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var stName = function (c) { return (D.states[c] || {}).name || c; };
  var nice = function (n) { return String(n).replace(/^([A-Z]+)\s*(\d+)$/, '$1 $2'); };

  /* ---------- layout: scale the 1920x1080 stage to the window ---------- */
  function scaleStage() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    $('stage').style.transform = 'scale(' + s + ')';
  }
  window.addEventListener('resize', scaleStage);

  /* Shrink a single-line element's font until it fits its box. */
  function fit(el, max) {
    if (!el) return;
    var size = max; el.style.fontSize = size + 'px';
    while ((el.scrollWidth > el.clientWidth + 1) && size > 30) { size -= 4; el.style.fontSize = size + 'px'; }
  }

  function countUp(el, to) {
    var t0 = null, dur = 700;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || to === 0) { el.textContent = to; return; }
    function step(t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }


  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? MON[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : ''; }
  /* "DIED IN COMMITTEE · MAR 12, 2026": what happened last, and when */
  function statusLine(b) { var d = fmtDate(b.lastActionDate); return (b.status || 'Introduced') + (d ? ' · ' + d : ''); }
  function headline(b) { return b.headline || b.title; }
  /* green when the outcome is good for science, red when bad: a dead anti bill is good news */
  function stClass(b) {
    var good = (b.stage === 'dead' && b.type === 'anti') || (b.stage === 'signed' && b.type === 'pro');
    var bad = (b.stage === 'signed' && b.type === 'anti') || (b.stage === 'dead' && b.type === 'pro');
    var near = b.stage === 'passed1' || b.stage === 'passed2';
    return 'stat-line' + (good ? ' st-good' : bad ? ' st-bad' : near ? ' st-near' : '');
  }

  /* ---------- data ---------- */
  function index() {
    byState = {};
    Object.keys(D.states).forEach(function (c) { byState[c] = { pro: [], anti: [], watch: [] }; });
    D.bills.forEach(function (b) { if (byState[b.state]) byState[b.state][b.type].push(b); });
    Object.keys(byState).forEach(function (c) {
      ['pro','anti'].forEach(function (t) { byState[c][t].sort(function (a, z) { return STAGE_RANK[z.stage] - STAGE_RANK[a.stage]; }); });
    });
  }
  function billsFor(c) { var x = byState[c] || { pro: [], anti: [], watch: [] }; return x.pro.concat(x.anti, x.watch); }
  function unreviewed(list) { return list.some(function (b) { return !b.reviewed && b.type !== 'watch'; }); }

  /* ---------- chrome ---------- */
  function setChrome(beats, draft) {
    $('rail-week').innerHTML = D ? 'WEEK<br>' + esc(D.week.split('-W')[1]) : '';
    var r = $('rail-beats'); r.innerHTML = '';
    for (var i = 0; i < beats; i++) { var d = document.createElement('i'); if (i < S.beat) d.className = 'on'; r.appendChild(d); }
    $('rail-draft').hidden = !draft;
    var slug = (S.scene === 'map' || S.scene === 'zero' || S.scene === 'versus' || S.scene === 'intro') ? '' : '/' + S.state.toLowerCase();
    $('cta-url').textContent = 'scienceandfreedom.com' + (S.state === 'US' ? '' : slug);
  }

  function setHash() {
    var h = S.scene;
    if (S.scene === 'docket' || S.scene === 'pipeline') h += '/' + S.state;
    if (S.scene === 'versus') h += '/' + S.vs[0] + '/' + S.vs[1];
    if (S.scene === 'spot' && S.spot) h += '/' + S.spot.id;
    history.replaceState(null, '', '#' + h);
  }

  /* ---------- scenes ---------- */
  var SCENES = {

    intro: { beats: 4, render: function (el) {
      var tot = { a: 0, p: 0, t: 0 }; Object.keys(D.states).forEach(function (c) { var v = D.states[c]; tot.a += v.anti; tot.p += v.pro; tot.t += v.tracked; });
      var zero = Object.keys(D.states).filter(function (c) { return c !== 'US' && c !== 'DC' && D.states[c].pro === 0; }).length;
      el.innerHTML = '<div class="intro">' +
        '<div class="intro-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.6l3 6.4 7 .85-5.15 4.85 1.35 6.9L12 17.1l-6.2 3.5 1.35-6.9L2 8.85 9 8z" fill="#c8930f" stroke="#f1f3fa" stroke-width="0.8" stroke-linejoin="round"/></svg>' +
        '<div><div class="bb intro-word">SAFE <span>ACTION</span></div><div class="intro-sub">Science and Freedom for Everyone</div></div></div>' +
        '<div class="intro-b reveal" id="ib1"><div class="eyebrow">What we do</div><div class="bb intro-line">We track science bills in <span>all 50 states</span> and Congress</div>' +
          '<div class="intro-stat"><b id="it">0</b> bills tracked</div></div>' +
        '<div class="intro-b reveal" id="ib2"><div class="intro-nums"><div class="anti"><b id="ia">0</b>anti-science</div><div class="pro"><b id="ip">0</b>pro-science</div>' +
          '<div class="zero"><b id="iz">0</b>states with zero pro-science bills on our tracker</div></div></div>' +
        '<div class="intro-b reveal" id="ib3"><div class="eyebrow">What you can do</div><div class="intro-steps">' +
          '<div><i>1</i>Find your state<em>scienceandfreedom.com/your-state</em></div>' +
          '<div><i>2</i>Message your lawmakers<em>Take Action: two minutes</em></div>' +
          '<div><i>3</i>Join the team<em>Volunteer · follow @scienceandfreedom</em></div></div></div>' +
        '<div class="intro-b reveal" id="ib4"><div class="bb intro-close">Every week. <span>State by state.</span></div></div>' +
        '<div class="intro-legal">I founded SAFE Action, a 501(c)(4). Contributions are not tax-deductible.</div></div>';
      el._tot = tot; el._zero = zero;
      return unreviewed(D.bills);
    }, beat: function (el, k) {
      // one beat at a time in the slot under the logo: the newest replaces the last
      // order: the numbers first (cold open), then what SAFE does, then what you can do, then the close
      ['ib2', 'ib1', 'ib3', 'ib4'].forEach(function (id, i) { $(id).classList.toggle('in', i + 1 === k); });
      if (k === 1) { countUp($('ia'), el._tot.a); countUp($('ip'), el._tot.p); countUp($('iz'), el._zero); }
      if (k === 2) countUp($('it'), el._tot.t);
    } },
    map: { beats: 2, render: function (el) {
      var tot = { a: 0, p: 0 }; Object.keys(D.states).forEach(function (c) { tot.a += D.states[c].anti; tot.p += D.states[c].pro; });
      var html = '<div class="eyebrow">Where the anti-science bills are · 2026 sessions</div><div class="map-wrap"><div class="map">';
      Object.keys(TILE).forEach(function (c) {
        var n = (D.states[c] || {}).anti || 0;
        var b = n === 0 ? 'b0' : n <= 2 ? 'b1' : n <= 6 ? 'b2' : n <= 12 ? 'b3' : 'b4';
        html += '<div class="tile dim' + (c === 'US' ? ' us' : '') + (DONE[c] ? ' done' : '') + '" data-b="' + b + '" data-st="' + c + '" style="grid-column:' + (TILE[c][0] + 1) + ';grid-row:' + (TILE[c][1] + 1) + '">' + c + '<b>' + n + '</b></div>';
      });
      html += '<div class="map-key reveal" id="mk"><div class="big"><span>' + tot.a + '</span> anti · <em>' + tot.p + '</em> pro</div></div>' +
        '<div class="map-sub reveal" id="ms">' + (D.moved.length ? D.moved.length + ' bills moved this week' : 'Bills SAFE tracks, all 50 states + Congress') + '</div>' +
        '<div class="legend"><i class="b0"></i>0 <i class="b1"></i>1-2 <i class="b2"></i>3-6 <i class="b3"></i>7-12 <i class="b4"></i>13+</div></div></div>';
      el.innerHTML = html;
      el.querySelectorAll('.tile').forEach(function (t) { t.onclick = function () { go('docket', t.dataset.st); }; });
      return unreviewed(D.bills);
    }, beat: function (el, k) {
      if (k >= 1) {
        // Fill tiles lightest to darkest so the worst states land last.
        var tiles = [].slice.call(el.querySelectorAll('.tile')).sort(function (a, z) { return +a.textContent.replace(/\D/g, '') - +z.textContent.replace(/\D/g, ''); });
        tiles.forEach(function (t, i) { setTimeout(function () { t.classList.remove('dim'); t.classList.add(t.dataset.b); }, i * 28); });
      }
      if (k >= 2) { $('mk').classList.add('in'); $('ms').classList.add('in'); }
    } },

    docket: { beats: function () { return 2 + billsFor(S.state).length; }, render: function (el) {
      var st = D.states[S.state], x = byState[S.state];
      el.innerHTML = '<div class="eyebrow">State docket · tracked bills · 2026 session</div>' +
        '<div class="bb state-name fit" id="sn">' + esc(st.name) + '</div>' +
        '<div class="counts"><div class="count pro reveal" id="cp"><div class="lab">Pro-science</div><div class="n" id="np">0</div>' +
        (x.pro.length === 0 ? '<div class="stamp">ZERO</div>' : '') + '</div>' +
        '<div class="count anti reveal" id="ca"><div class="lab">Anti-science</div><div class="n" id="na">0</div>' +
        (x.anti.length === 0 ? '<div class="stamp">NONE</div>' : '') + '</div></div><div id="bn"></div>';
      fit($('sn'), 150);
      return unreviewed(billsFor(S.state));
    }, beat: function (el, k) {
      var x = byState[S.state];
      if (k >= 1 && !$('cp').classList.contains('in')) { $('cp').classList.add('in'); countUp($('np'), x.pro.length); }
      if (k >= 2 && !$('ca').classList.contains('in')) { $('ca').classList.add('in'); countUp($('na'), x.anti.length); }
      var list = billsFor(S.state);
      S.billIdx = k >= 3 ? Math.min(k - 3, list.length - 1) : -1;
      var bn = $('bn');
      if (S.billIdx < 0) { bn.innerHTML = k >= 2 && !list.length ? '<div class="bill-empty">No tracked bills this session</div>' : ''; return; }
      var b = list[S.billIdx];
      bn.innerHTML = '<div class="bill-now ' + b.type + ' scene-enter" id="bnow">' +
        '<div class="row"><span class="num">' + esc(nice(b.number)) + '</span><span class="pill ' + b.type + '">' + (b.type === 'pro' ? 'PRO' : b.type === 'watch' ? 'ONE TO WATCH' : 'ANTI') + '</span>' +
        (b.topic ? '<span class="topic">' + esc(b.topic) + '</span>' : '') +
        (b.reviewed ? (b.reviewBasis === 'sponsor_record' ? '<span class="pill unrev">INFERRED</span>' : '') : '<span class="pill unrev">UNREVIEWED</span>') + '</div>' +
        '<div class="hl-big">' + esc(headline(b)) + '</div>' +
        '<div class="' + stClass(b) + '">' + esc(statusLine(b)) + '</div>' +
        (b.headline ? '<div class="off-title">' + esc(b.title) + '</div>' : '') +
        '<div class="idx">' + (S.billIdx + 1) + ' / ' + list.length + '</div></div>';
      $('bnow').onclick = function () { spotlight(b); };
    } },

    spot: { beats: 3, render: function (el) {
      var b = S.spot; if (!b) { el.innerHTML = '<div class="loading">Pick a bill first</div>'; return false; }
      var rank = STAGE_RANK[b.stage];
      var pipe = STAGES.map(function (s, i) {
        var cls = b.stage === s[0] ? 'on' : (rank > i ? 'done' : '');
        return '<div class="' + cls + '"><i></i>' + esc(s[1].toUpperCase()) + '</div>';
      }).join('');
      var text = b.summary && b.summary.length > b.title.length ? b.summary : b.title;
      var sp = b.sponsors.filter(function (s) { return s.type === 'primary'; })[0] || b.sponsors[0];
      el.innerHTML = '<div class="spot"><div class="spot-head"><span class="pill code">' + esc(b.state + ' · ' + nice(b.number)) + '</span>' +
        '<span class="pill ' + b.type + '">' + (b.type === 'pro' ? 'PRO-SCIENCE BILL' : b.type === 'watch' ? 'ONE TO WATCH' : 'ANTI-SCIENCE BILL') + '</span>' +
        (b.reviewed ? (b.reviewBasis === 'sponsor_record' ? '<span class="pill unrev">INFERRED</span>' : '') : '<span class="pill unrev">UNREVIEWED</span>') + '</div>' +
        '<div class="bb spot-title" id="stt">' + esc(headline(b)) + '</div>' +
        '<div class="spot-sub"><span class="' + stClass(b) + '">' + esc(statusLine(b)) + '</span>' + (b.headline ? '<span class="off-title">' + esc(b.title) + '</span>' : '') + '</div>' +
        '<div class="pipe">' + pipe + '</div>' +
        '<div class="paper reveal" id="pp"><div class="txt" id="ptxt">' + markEvidence(text, b.evidence) + '</div>' +
        '<div class="meta"><span>' + esc(b.source.replace(/^https?:\/\//, '')) + '</span><span>' +
        esc((sp ? 'Sponsor: ' + sp.name + (sp.party ? ' (' + sp.party + ')' : '') + ' · ' : '') + (b.lastActionDate || '')) + '</span></div></div>' +
        '<div id="stampHost"></div></div>';
      var t = $('stt'); var size = 84; while (t.scrollHeight > 232 && size > 48) { size -= 4; t.style.fontSize = size + 'px'; }
      var pt = $('ptxt'), ps = 60; pt.style.fontSize = ps + 'px'; while (pt.scrollHeight > 322 && ps > 30) { ps -= 2; pt.style.fontSize = ps + 'px'; }
      return !b.reviewed;
    }, beat: function (el, k) {
      if (k >= 1) $('pp').classList.add('in');
      if (k >= 2) el.querySelectorAll('mark.hl').forEach(function (m) { m.classList.add('on'); });
      if (k >= 3 || S.stamp) showStamp();
    } },

    versus: { beats: 3, render: function (el) {
      var a = S.vs[0], z = S.vs[1];
      var side = function (c, i) {
        var s = D.states[c];
        return '<div class="vs-side"><div class="bb vs-name fit" id="vn' + i + '">' + esc(s.name) + '</div>' +
          '<div class="vs-row reveal" id="vr' + i + '"><div class="a">ANTI<b id="va' + i + '">0</b></div><div class="p">PRO<b id="vp' + i + '">0</b></div></div></div>';
      };
      var pct = function (c) { var s = D.states[c], t = s.anti + s.pro; return t ? Math.round(100 * s.pro / t) : 0; };
      el.innerHTML = '<div class="eyebrow" style="text-align:center">Head to head · tracked bills · 2026 sessions</div>' +
        '<div class="vs">' + side(a, 0) + '<div class="vs-badge">VS</div>' + side(z, 1) + '</div>' +
        '<div class="bars reveal" id="vb">' + [a, z].map(function (c, i) {
          var s = D.states[c];
          return '<div><div class="bar"><i id="vbar' + i + '" data-w="' + pct(c) + '"></i></div><div class="bar-cap"><span>' + c + ' ' + pct(c) + '% pro</span><span>' + s.pro + ' of ' + (s.pro + s.anti) + '</span></div></div>';
        }).join('') + '</div><div class="bb verdict reveal" id="vv">' + esc(verdict(a, z)) + '</div>';
      fit($('vn0'), 110); fit($('vn1'), 110);
      return unreviewed(billsFor(a).concat(billsFor(z)));
    }, beat: function (el, k) {
      if (k >= 1 && !$('vr0').classList.contains('in')) {
        [0, 1].forEach(function (i) { var s = D.states[S.vs[i]]; $('vr' + i).classList.add('in'); countUp($('va' + i), s.anti); countUp($('vp' + i), s.pro); });
      }
      if (k >= 2) { $('vb').classList.add('in'); [0, 1].forEach(function (i) { var b = $('vbar' + i); b.style.width = b.dataset.w + '%'; }); }
      if (k >= 3) $('vv').classList.add('in');
    } },

    pipeline: { beats: 1, render: function (el) {
      var list = billsFor(S.state);
      var lanes = {}; LANES.forEach(function (l) { lanes[l[0]] = []; });
      list.forEach(function (b) { lanes[b.stage].push(b); });
      el.innerHTML = '<div class="eyebrow">' + esc(stName(S.state)) + ' · how close to law</div>' +
        '<div class="bb pipe-head">' + esc(pipelineHeadline(list)) + '</div><div class="lanes reveal" id="ln">' +
        LANES.map(function (l) {
          var items = lanes[l[0]], max = items.length > 9 ? 8 : 9;
          var hot = l[0] === 'passed2' || l[0] === 'signed' ? items.some(function (b) { return b.type === 'anti'; }) : false;
          var won = l[0] === 'dead' && items.some(function (b) { return b.type === 'anti'; });
          return '<div class="lane' + (hot ? ' hot' : '') + (won ? ' won' : '') + '"><h6>' + esc(l[1]) + '</h6>' +
            items.slice(0, max).map(function (b) { return '<div class="tok ' + b.type + '" data-id="' + esc(b.id) + '">' + esc(nice(b.number)) + '</div>'; }).join('') +
            (items.length > max ? '<div class="tok more">+' + (items.length - max) + ' more</div>' : '') + '</div>';
        }).join('') + '</div>';
      el.querySelectorAll('.tok[data-id]').forEach(function (t) { t.onclick = function () { spotlight(D.bills.filter(function (b) { return b.id === t.dataset.id; })[0]); }; });
      return unreviewed(list);
    }, beat: function () { $('ln').classList.add('in'); } },

    zero: { beats: 1, render: function (el) {
      var codes = Object.keys(D.states).filter(function (c) { return c !== 'US' && c !== 'DC'; });
      var zero = codes.filter(function (c) { return D.states[c].pro === 0; });
      el.innerHTML = '<div class="eyebrow">The Zero Club · 2026 sessions</div>' +
        '<div class="bb zero-head"><span>' + zero.length + '</span> states filed zero pro-science bills we track</div>' +
        '<div class="zero-grid reveal" id="zg">' + codes.map(function (c) { return '<div class="' + (D.states[c].pro === 0 ? 'z' : '') + '" data-st="' + c + '">' + c + '</div>'; }).join('') + '</div>';
      el.querySelectorAll('[data-st]').forEach(function (t) { t.onclick = function () { go('docket', t.dataset.st); }; });
      return unreviewed(D.bills);
    }, beat: function () { $('zg').classList.add('in'); } }
  };

  function verdict(a, z) {
    var A = D.states[a], Z = D.states[z];
    if (A.anti === Z.anti) return 'Dead even on anti-science bills';
    var worse = A.anti > Z.anti ? A : Z, diff = Math.abs(A.anti - Z.anti);
    return worse.name + ' filed ' + diff + ' more anti-science bill' + (diff === 1 ? '' : 's');
  }

  function pipelineHeadline(list) {
    var anti = list.filter(function (b) { return b.type === 'anti'; });
    var count = function (st) { return anti.filter(function (b) { return b.stage === st; }).length; };
    var pl = function (n) { return n + ' anti-science bill' + (n === 1 ? '' : 's'); };
    if (count('signed')) return pl(count('signed')) + ' signed into law';
    if (count('passed2')) return pl(count('passed2')) + ' cleared both chambers';
    if (count('passed1')) return pl(count('passed1')) + ' passed one chamber';
    if (count('dead') && count('dead') === anti.length) return 'Every anti-science bill died';
    if (anti.length) return pl(anti.length) + ' filed, none past committee yet';
    return 'No anti-science bills on file';
  }

  /* Wrap the verified evidence quotes in highlight marks (exact substring only). */
  function markEvidence(text, ev) {
    var out = esc(text);
    (ev || []).forEach(function (q) {
      var eq = esc(q); if (q && out.indexOf(eq) !== -1) out = out.replace(eq, '<mark class="hl">' + eq + '</mark>');
    });
    return out;
  }

  function showStamp() {
    var b = S.spot, host = $('stampHost'); if (!b || !host || host.firstChild) return;
    var label = '', cls = '';
    if (b.stage === 'dead') { label = b.type === 'anti' ? 'DEAD' : 'KILLED'; cls = b.type === 'anti' ? 'win' : 'loss'; }
    else if (b.stage === 'signed') { label = b.type === 'anti' ? 'SIGNED INTO LAW' : 'WIN · LAW'; cls = b.type === 'anti' ? 'loss' : 'win'; }
    if (!label) return;
    host.innerHTML = '<div class="big-stamp ' + cls + '">' + label + '</div>';
  }


  /* ---------- OBS chapter markers (opt-in: /live?obs or /live?obs&obspw=PASSWORD once) ----------
     Each new state or national segment drops a record chapter named "SAFE ...", so the Shorts
     pipeline can cut one Short per state. Names avoid the pipeline's marker words
     (START, END, CLIP, CUT, DEAD, CAM, LEFT, CENTER, ZOOM). Needs OBS 30.2+ recording Hybrid MP4. */
  var OBS = { ws: null, ready: false, last: '' };
  function obsInit() {
    var q = new URLSearchParams(location.search);
    if (!q.has('obs')) return;
    var pw = q.get('obspw');
    try { if (pw) localStorage.setItem('safe-live-obspw', pw); else pw = localStorage.getItem('safe-live-obspw') || ''; } catch (e) { pw = pw || ''; }
    if (q.has('obspw')) { q.delete('obspw'); history.replaceState(null, '', location.pathname + '?' + q.toString() + location.hash); }
    var port = /^\d+$/.test(q.get('obs') || '') ? q.get('obs') : '4455';
    function connect() {
      var ws;
      try { ws = new WebSocket('ws://127.0.0.1:' + port); } catch (e) { return; }
      OBS.ws = ws;
      ws.onmessage = function (ev) {
        var m = JSON.parse(ev.data);
        if (m.op === 0) {
          var a = m.d.authentication;
          var hello = { rpcVersion: 1 };
          if (!a) { ws.send(JSON.stringify({ op: 1, d: hello })); return; }
          sha64(pw + a.salt).then(function (secret) { return sha64(secret + a.challenge); }).then(function (auth) {
            hello.authentication = auth; ws.send(JSON.stringify({ op: 1, d: hello }));
          });
        } else if (m.op === 2) { OBS.ready = true; obsDot(); }
      };
      ws.onclose = function () { OBS.ready = false; obsDot(); setTimeout(connect, 5000); };
    }
    connect();
  }
  function sha64(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    });
  }
  function obsDot() { var d = document.querySelector('.live-dot'); if (d) d.style.background = OBS.ready ? '#2fb27f' : '#ff5a47'; }
  function obsMark() {
    var key = S.scene === 'intro' ? 'SAFE NATIONAL INTRO' : S.scene === 'map' ? 'SAFE NATIONAL MAP' : S.scene === 'zero' ? 'SAFE NATIONAL ZERO CLUB'
      : S.scene === 'versus' ? 'SAFE VS ' + S.vs[0] + ' ' + S.vs[1] : 'SAFE STATE ' + S.state;
    if (key === OBS.last) return;
    OBS.last = key;
    if (!OBS.ready) return;
    OBS.ws.send(JSON.stringify({ op: 6, d: { requestType: 'CreateRecordChapter', requestId: String(Date.now()), requestData: { chapterName: key } } }));
  }


  /* ---------- run sheet: which states are covered this week (saved in this browser) ---------- */
  var DONE = {};
  function doneKey() { return 'safe-live-done-' + (D ? D.week : ''); }
  function loadDone() { try { DONE = JSON.parse(localStorage.getItem(doneKey()) || '{}'); } catch (e) { DONE = {}; } }
  function saveDone() { try { localStorage.setItem(doneKey(), JSON.stringify(DONE)); } catch (e) {} }
  function stateOrder() { return Object.keys(D.states).filter(function (c) { return c !== 'DC'; }).sort(function (a, z) { return a === 'US' ? 1 : z === 'US' ? -1 : D.states[a].name.localeCompare(D.states[z].name); }); }
  function renderRunsheet() {
    var codes = stateOrder(), n = codes.filter(function (c) { return DONE[c]; }).length;
    $('rs-count').textContent = n + ' OF ' + codes.length + ' DONE';
    var cur = (S.scene === 'docket' || S.scene === 'pipeline' || S.scene === 'spot') ? S.state : '';
    $('rs-grid').innerHTML = codes.map(function (c) {
      return '<button type="button" data-st="' + c + '" class="' + (DONE[c] ? 'done' : '') + (c === cur ? ' now' : '') + '">' + c + '<small>' + D.states[c].anti + '</small></button>';
    }).join('');
    $('rs-grid').querySelectorAll('button').forEach(function (b) { b.onclick = function () { b.blur(); go('docket', b.dataset.st); }; });
  }
  function nextUndone() {
    var codes = stateOrder(), i = codes.indexOf(S.state);
    for (var j = 1; j <= codes.length; j++) { var c = codes[(i + j) % codes.length]; if (!DONE[c]) return c; }
    return null;
  }


  /* ---------- control panel (left column) ---------- */
  var LABEL = { intro: 'Intro', map: 'Map', docket: 'State', spot: 'Bill', versus: 'Versus', pipeline: 'Pipeline', zero: 'Zero Club' };
  var KEYS = [['intro', '0'], ['map', '1'], ['docket', '2'], ['spot', '3'], ['versus', '4'], ['pipeline', '5'], ['zero', '6']];
  function pbtn(id, html, fn, off) { return { id: id, html: html, fn: fn, off: off }; }
  function renderPanel() {
    if (!D) return;
    $('pn-scene').textContent = LABEL[S.scene] || S.scene;
    $('pn-state').textContent = S.scene === 'versus' ? stName(S.vs[0]) + ' vs ' + stName(S.vs[1])
      : (S.scene === 'docket' || S.scene === 'pipeline' || S.scene === 'spot') ? stName(S.state) + (S.scene === 'spot' && S.spot ? ' · ' + nice(S.spot.number) : '') : '';
    var n = beatsOf(S.scene);
    $('pn-steptxt').textContent = S.beat >= n ? 'All shown' : 'Step ' + S.beat + ' of ' + n;
    $('pn-dots').innerHTML = n <= 40 ? new Array(n + 1).join('<i></i>') : '';
    [].forEach.call($('pn-dots').children, function (d, i) { if (i < S.beat) d.className = 'on'; });
    $('pn-back').disabled = S.beat === 0; $('pn-next').disabled = S.beat >= n;
    if (!$('pn-scenes').firstChild) {
      $('pn-scenes').innerHTML = KEYS.map(function (k) { return '<button type="button" data-sc="' + k[0] + '">' + LABEL[k[0]] + '<kbd>' + k[1] + '</kbd></button>'; }).join('') +
        '<button type="button" data-sc="help">Keys<kbd>?</kbd></button>';
      $('pn-scenes').querySelectorAll('button').forEach(function (b) { b.onclick = function () { b.blur(); if (b.dataset.sc === 'help') { $('help').hidden = !$('help').hidden; return; } if (b.dataset.sc === 'spot' && !S.spot) { var l = billsFor(S.state); if (l.length) spotlight(l[Math.max(0, S.billIdx)]); return; } go(b.dataset.sc); }; });
    }
    $('pn-scenes').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.sc === S.scene); });
    var ctx = [];
    if (S.scene === 'docket') {
      ctx.push(pbtn('c-prev', '<kbd>&uarr;</kbd> Prev bill', function () { stepBill(-1); }));
      ctx.push(pbtn('c-nextb', 'Next bill <kbd>&darr;</kbd>', function () { stepBill(1); }));
      ctx.push(pbtn('c-zoom', 'Zoom into bill <kbd>Enter</kbd>', function () { var l = billsFor(S.state); if (S.billIdx >= 0) spotlight(l[S.billIdx]); }, S.billIdx < 0));
      ctx.push(pbtn('c-pipe', 'Pipeline view', function () { go('pipeline', S.state); }));
    } else if (S.scene === 'spot') {
      ctx.push(pbtn('c-up', '<kbd>Esc</kbd> Back to ' + S.state, escUp));
      ctx.push(pbtn('c-prev', '<kbd>&uarr;</kbd> Prev bill', function () { stepBill(-1); }));
      ctx.push(pbtn('c-nextb', 'Next bill <kbd>&darr;</kbd>', function () { stepBill(1); }));
      ctx.push(pbtn('c-hl', 'Highlight selected text <kbd>.</kbd>', highlightSelection));
      ctx.push(pbtn('c-stamp', 'Stamp <kbd>!</kbd>', function () { S.stamp = true; showStamp(); }));
    } else if (S.scene === 'pipeline') {
      ctx.push(pbtn('c-prev', '<kbd>&uarr;</kbd> Prev state', function () { stepBill(-1); }));
      ctx.push(pbtn('c-nextb', 'Next state <kbd>&darr;</kbd>', function () { stepBill(1); }));
      ctx.push(pbtn('c-dock', 'State docket', function () { go('docket', S.state); }));
    }
    var box = $('pn-ctx');
    var opts = function (sel) { return Object.keys(D.states).filter(function (c) { return c !== 'DC'; }).map(function (c) { return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + '</option>'; }).join(''); };
    box.innerHTML = ctx.map(function (b) { return '<button type="button" class="pn-mini" id="' + b.id + '"' + (b.off ? ' disabled' : '') + '>' + b.html + '</button>'; }).join('') +
      (S.scene === 'versus' ? '<select id="c-vs0" aria-label="First state">' + opts(S.vs[0]) + '</select><span style="align-self:center;color:#93a0c4;font-weight:700">vs</span><select id="c-vs1" aria-label="Second state">' + opts(S.vs[1]) + '</select>' : '');
    ctx.forEach(function (b) { $(b.id).onclick = function () { $(b.id).blur(); b.fn(); }; });
    if (S.scene === 'versus') ['c-vs0', 'c-vs1'].forEach(function (id, i) { $(id).onchange = function () { S.vs[i] = $(id).value; $(id).blur(); go('versus'); }; });
  }
  function escUp() {
    if (S.scene === 'spot' && S.spot) { var l = billsFor(S.spot.state); return go('docket', S.spot.state, 3 + Math.max(0, l.indexOf(S.spot))); }
    go('map');
  }

  /* ---------- navigation ---------- */
  function beatsOf(sc) { var b = SCENES[sc].beats; return typeof b === 'function' ? b() : b; }

  function render() {
    if (!D) return;
    var el = $('scene'), sc = SCENES[S.scene];
    el.className = 'scene-enter'; void el.offsetWidth;
    var draft = sc.render(el);
    sc.beat(el, S.beat);
    setChrome(beatsOf(S.scene), draft);
    setHash();
    obsMark();
    if (S.scene === 'docket' && !DONE[S.state]) { DONE[S.state] = 1; saveDone(); }
    renderRunsheet();
    renderPanel();
  }

  function go(scene, state, beat) {
    if (scene !== 'spot') S.prevScene = scene;
    S.scene = scene; if (state && D.states[state]) S.state = state;
    S.beat = beat || 0; S.stamp = false; render();
  }

  function spotlight(b) { if (!b) return; S.spot = b; S.state = b.state; S.scene = 'spot'; S.beat = 0; S.stamp = false; render(); }

  function next() {
    var n = beatsOf(S.scene);
    if (S.beat < n) { S.beat++; SCENES[S.scene].beat($('scene'), S.beat); setChrome(n, !$('rail-draft').hidden); renderPanel(); }
  }
  function prev() { if (S.beat > 0) { S.beat--; render(); } }

  function stepBill(d) {
    if (S.scene === 'docket') {
      var list = billsFor(S.state); if (!list.length) return;
      var i = Math.max(0, Math.min(list.length - 1, (S.billIdx < 0 ? -1 : S.billIdx) + d));
      S.beat = 3 + i; render();
    } else if (S.scene === 'spot' && S.spot) {
      var l = billsFor(S.spot.state), j = l.indexOf(S.spot) + d;
      if (j >= 0 && j < l.length) spotlight(l[j]);
    } else if (S.scene === 'pipeline') {
      var codes = stateOrder(), k = codes.indexOf(S.state) + d;
      if (k >= 0 && k < codes.length) go('pipeline', codes[k]);
    }
  }

  function highlightSelection() {
    var sel = window.getSelection(); if (!sel || sel.isCollapsed) return;
    var r = sel.getRangeAt(0); if (!$('ptxt') || !$('ptxt').contains(r.commonAncestorContainer)) return;
    var m = document.createElement('mark'); m.className = 'hl';
    try { r.surroundContents(m); } catch (e) { return; }
    sel.removeAllRanges(); requestAnimationFrame(function () { m.classList.add('on'); });
  }

  function showPicker(label) { $('picker').hidden = false; $('picker-label').textContent = label; $('picker-buf').textContent = buf; }
  function clearBuf() { buf = ''; $('picker').hidden = true; }

  function typeLetter(ch) {
    buf += ch.toUpperCase(); clearTimeout(bufTimer);
    var want = S.scene === 'versus' ? 4 : 2;
    showPicker(S.scene === 'versus' ? 'Matchup' : 'Jump to state');
    if (buf.length >= want) {
      if (S.scene === 'versus') {
        var a = buf.slice(0, 2), z = buf.slice(2, 4);
        if (D.states[a] && D.states[z]) { S.vs = [a, z]; go('versus'); }
      } else if (D.states[buf]) {
        go(S.scene === 'map' || S.scene === 'zero' || S.scene === 'spot' || S.scene === 'intro' ? 'docket' : S.scene, buf);
      }
      setTimeout(clearBuf, 250); return;
    }
    bufTimer = setTimeout(clearBuf, 1600);
  }

  document.addEventListener('keydown', function (e) {
    if (!D || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key, map = { '0':'intro','1':'map','2':'docket','3':'spot','4':'versus','5':'pipeline','6':'zero' };
    if (map[k]) { e.preventDefault(); return go(map[k]); }
    if (k === ' ' || k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); return next(); }
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); return prev(); }
    if (k === 'ArrowDown') { e.preventDefault(); return stepBill(1); }
    if (k === 'ArrowUp') { e.preventDefault(); return stepBill(-1); }
    if (k === 'Enter') { var l = billsFor(S.state); if (S.scene === 'docket' && S.billIdx >= 0) spotlight(l[S.billIdx]); return; }
    if (k === 'Escape') { if (buf) return clearBuf(); return escUp(); }
    if (k === '.') return highlightSelection();
    if (k === ',') { document.querySelectorAll('#ptxt mark.hl').forEach(function (m) { m.classList.remove('on'); }); return; }
    if (k === '!') { S.stamp = true; return showStamp(); }
    if (k === '?') { $('help').hidden = !$('help').hidden; return; }
    if (k === 'Tab') { e.preventDefault(); var nx = nextUndone(); if (nx) go('docket', nx); return; }
    if (/^[a-zA-Z]$/.test(k)) return typeLetter(k);
  });

  function fromHash() {
    var h = location.hash.replace(/^#/, ''), at = h.indexOf('@'), beat = 0;
    if (at !== -1) { beat = parseInt(h.slice(at + 1), 10) || 0; h = h.slice(0, at); }
    var p = h.split('/');
    if (!p[0] || !SCENES[p[0]]) return;
    if (p[0] === 'versus' && D.states[p[1]] && D.states[p[2]]) S.vs = [p[1], p[2]];
    if (p[0] === 'spot') { var b = D.bills.filter(function (x) { return x.id === p[1]; })[0]; if (b) { spotlight(b); while (S.beat < beat) next(); return; } }
    go(p[0], p[1], beat);
  }
  window.addEventListener('hashchange', function () { if (D) fromHash(); });

  scaleStage();
  obsInit();
  $('scene').innerHTML = '<div class="loading">Loading tracker…</div>';
  fetch('/data/live.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
    D = d; index(); loadDone();
    $('rs-reset').onclick = function () { DONE = {}; saveDone(); renderRunsheet(); if (S.scene === 'map') render(); };
    $('home-link').onclick = function (ev) { ev.preventDefault(); go('map'); };
    $('pn-back').onclick = function () { $('pn-back').blur(); prev(); };
    $('pn-next').onclick = function () { $('pn-next').blur(); next(); };
    $('pn-nextstate').onclick = function () { $('pn-nextstate').blur(); var nx = nextUndone(); if (nx) go('docket', nx); };
    if (location.hash) fromHash(); else render();
  }).catch(function (err) {
    $('scene').innerHTML = '<div class="loading">Could not load /data/live.json (' + esc(err.message) + '). Run scripts/build_live.py.</div>';
  });
})();
