// ============================================
// SAFE Action - V6 homepage live wiring.
// Computes every displayed number from data/bills.json at load plus the
// Firestore action counter. Nothing on this page is hardcoded except the
// disclosed pre-tracking baselines in js/config.js.
// ============================================
(function () {
    'use strict';

    var STATE_NAMES = { AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California', CO:'Colorado', CT:'Connecticut', DE:'Delaware', DC:'District of Columbia', FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', US:'US Congress' };

    // 11-column US tile-grid cartogram positions [col, row]
    var POS = { AK:[1,1], ME:[11,1], VT:[10,2], NH:[11,2],
        WA:[1,3], ID:[2,3], MT:[3,3], ND:[4,3], MN:[5,3], WI:[6,3], MI:[7,3], NY:[9,3], MA:[10,3], RI:[11,3],
        OR:[1,4], NV:[2,4], WY:[3,4], SD:[4,4], IA:[5,4], IL:[6,4], IN:[7,4], OH:[8,4], PA:[9,4], NJ:[10,4], CT:[11,4],
        CA:[1,5], UT:[2,5], CO:[3,5], NE:[4,5], MO:[5,5], KY:[6,5], WV:[7,5], VA:[8,5], MD:[9,5], DE:[10,5],
        AZ:[2,6], NM:[3,6], KS:[4,6], AR:[5,6], TN:[6,6], NC:[7,6], SC:[8,6], DC:[9,6],
        OK:[4,7], LA:[5,7], MS:[6,7], AL:[7,7], GA:[8,7],
        HI:[1,8], TX:[4,8], FL:[9,8] };

    var STATUS_ORDER = ['Pre-filed','Introduced','In Committee','Passed Committee','Floor Vote Scheduled','Passed One Chamber','In Conference','Passed Both Chambers','Sent to Governor'];
    // govinfo emits chamber-specific federal statuses; rank them as one chamber passed.
    var STATUS_ALIAS = { 'Passed Senate': 'Passed One Chamber', 'Passed House': 'Passed One Chamber' };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
    function fmt(n) { return Number(n).toLocaleString(); }

    function bucket(n) { return n >= 13 ? 'b4' : n >= 7 ? 'b3' : n >= 3 ? 'b2' : n >= 1 ? 'b1' : 'b0'; }

    function dateLabel(iso) {
        var d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }).toUpperCase();
    }

    fetch('data/bills.json').then(function (r) {
        if (!r.ok) throw new Error('bills.json HTTP ' + r.status);
        return r.json();
    }).then(function (data) {
        var bills = data.bills || [];
        var anti = bills.filter(function (b) { return b.billType === 'anti'; });
        var activeAnti = anti.filter(function (b) { return b.isActive === 'Yes'; });
        var pro = bills.filter(function (b) { return b.billType === 'pro' && b.isActive === 'Yes'; });
        var signed = bills.filter(function (b) { return b.status === 'Signed into Law'; });
        var states = {};
        // DC gets a map tile but is not a state; keep it out of the "states
        // covered" count so 50 means fifty states.
        bills.forEach(function (b) { if (b.state && b.state !== 'US') states[b.state] = true; });
        var stateOnly = Object.keys(states).filter(function (s) { return s !== 'DC'; });
        var stateCount = stateOnly.length;

        // Status bar + hero chips
        var upd = data.generated_at ? dateLabel(data.generated_at) : '';
        setText('sb-label', 'TRACKING ' + fmt(bills.length) + ' BILLS - UPDATED ' + upd);
        setText('sb-side', stateCount + ' STATES + CONGRESS');
        setText('chip-updated', 'BILL DATA UPDATED ' + upd);
        setText('watch-updated', 'UPDATED ' + upd);
        setText('lede-bills', fmt(bills.length));
        setText('lede-threats', String(activeAnti.length));

        // Stats
        setText('stat-bills', fmt(bills.length));
        setText('stat-threats', fmt(activeAnti.length));
        setText('stat-pro', fmt(pro.length));
        setText('stat-signed', fmt(signed.length));
        setText('stat-states', String(stateCount));
        setText('map-chip', activeAnti.length + ' ACTIVE THREATS');

        // Per-state active-threat counts
        var perState = {};
        activeAnti.forEach(function (b) {
            var s = b.state || '';
            if (s) perState[s] = (perState[s] || 0) + 1;
        });
        var fedCount = perState.US || 0;

        // Cartogram
        var grid = document.getElementById('cartogrid');
        if (grid) {
            grid.innerHTML = '';
            Object.keys(POS).forEach(function (st) {
                // A state absent from the dataset has NO coverage yet; showing it
                // as "0 threats" would assert something we have not verified.
                var covered = !!states[st];
                var n = perState[st] || 0;
                var a = document.createElement('a');
                a.className = 'tile ' + (covered ? bucket(n) : 'nodata');
                a.style.gridArea = POS[st][1] + '/' + POS[st][0];
                // Every tile opens that state's report (/ca, /tx ...): bills, public health
                // data and legislators. The report links on to the tracker's bill browser.
                a.href = '/' + st.toLowerCase();
                a.title = (STATE_NAMES[st] || st) +
                    (covered ? ': ' + n + ' active threat' + (n === 1 ? '' : 's') : ': no bill data yet') + '. Open the state report.';
                a.innerHTML = '<span class="ab">' + st + '</span>' +
                    (covered && n ? '<span class="ct">' + n + '</span>' : '');
                grid.appendChild(a);
            });
            var aria = Object.keys(perState).filter(function (s) { return s !== 'US'; })
                .sort(function (x, y) { return perState[y] - perState[x]; }).slice(0, 5)
                .map(function (s) { return (STATE_NAMES[s] || s) + ' ' + perState[s]; }).join(', ');
            grid.setAttribute('aria-label', 'Tile map of active anti-science bills per state. Highest: ' + aria + '.');
        }
        var fed = document.getElementById('fedchip');
        if (fed) fed.innerHTML = 'US CONGRESS <span class="ct">' + fedCount + ' ACTIVE THREATS (FEDERAL)</span>';

        // Ranked sidebar (top 6 jurisdictions)
        var rank = Object.keys(perState).map(function (s) { return { s: s, n: perState[s] }; })
            .sort(function (a, b) { return b.n - a.n; }).slice(0, 6);
        var max = rank.length ? rank[0].n : 1;
        var rEl = document.getElementById('rank');
        if (rEl) {
            rEl.innerHTML = rank.map(function (r) {
                return '<li><div class="row"><span>' + esc(STATE_NAMES[r.s] || r.s) + '</span><span class="n">' + r.n + '</span></div>' +
                    '<div class="bar"><i style="width:' + Math.max(6, Math.round(r.n / max * 100)) + '%"></i></div></li>';
            }).join('');
        }
        setText('rank-note', 'Active anti-science bills by jurisdiction, from bill data updated ' +
            (data.generated_at ? new Date(data.generated_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : 'daily') + '.');

        // Watchlist: furthest-along active threats
        var rankOf = {};
        STATUS_ORDER.forEach(function (s, i) { rankOf[s] = i; });
        var wl = activeAnti.slice().sort(function (a, b) {
            return (rankOf[STATUS_ALIAS[b.status] || b.status] || 0) - (rankOf[STATUS_ALIAS[a.status] || a.status] || 0) ||
                String(b.lastActionDate || '').localeCompare(String(a.lastActionDate || ''));
        }).slice(0, 6);
        var bl = document.getElementById('bills-live');
        if (bl) {
            bl.innerHTML = wl.map(function (b) {
                var isFed = b.state === 'US';
                var stParam = isFed ? '' : '&state=' + encodeURIComponent(b.state);
                var href = 'action.html?bill=' + encodeURIComponent(b.billId || '') + stParam;
                return '<div class="bill">' +
                    '<span class="jur' + (isFed ? '' : ' state') + '">' + esc(b.state) + '</span>' +
                    '<div><span class="id">' + esc(b.billNumber) + '</span> <span class="ttl">' + esc((b.title || '').slice(0, 110)) + '</span></div>' +
                    '<span class="bstatus">' + esc((b.status || '').toUpperCase()) + '</span>' +
                    '<a class="actlink" href="' + href + '">Act on this bill &rarr;</a></div>';
            }).join('');
        }
    }).catch(function (e) {
        console.warn('home wiring:', e);
        ['stat-bills','stat-threats','stat-pro','stat-signed','stat-states'].forEach(function (id) {
            var el = document.getElementById(id); if (el) el.textContent = 'n/a';
        });
        setText('sb-label', 'BILL DATA TEMPORARILY UNAVAILABLE');
        var w = document.getElementById('bills-live');
        if (w) w.innerHTML = '<div class="card center"><p class="muted">Bill data is temporarily unavailable. ' +
            '<a href="tracker.html">Open the tracker</a> or try again shortly.</p></div>';
    });

    // Actions stat: disclosed baseline + live Firestore counter (same honest
    // formula the old impact section used).
    try {
        if (typeof firebase !== 'undefined' && SAFE_CONFIG.FIREBASE_CONFIG) {
            if (!firebase.apps.length) firebase.initializeApp(SAFE_CONFIG.FIREBASE_CONFIG);
            firebase.firestore().collection('actionStats').doc('counters').onSnapshot(function (doc) {
                var live = doc.exists ? (doc.data().allTime_total || 0) : 0;
                setText('stat-actions', fmt((SAFE_CONFIG.BASE_ACTIONS || 0) + live));
            }, function (err) {
                console.warn('actions counter:', err);
                setText('stat-actions', fmt(SAFE_CONFIG.BASE_ACTIONS || 0));
            });
        } else {
            setText('stat-actions', fmt((window.SAFE_CONFIG && SAFE_CONFIG.BASE_ACTIONS) || 0));
        }
    } catch (e) {
        console.warn('actions stat:', e);
    }
})();
