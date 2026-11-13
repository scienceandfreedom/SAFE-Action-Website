// ============================================
// SAFE Action - County Report Card
// ============================================
// Shown on the Take Action page after an address lookup. Four parts:
//   1. Recent public health data for the visitor's county, as published by
//      What's In My County (Priori Intelligence), read through /api/county-report.
//   2. State and federal bills on which SAFE Action has a reviewed position.
//   3. The visitor's officials (the contact actions are the cards below).
//   4. A link to the full county page, with the data credit.
//
// Rules:
// - County sentences and values are shown as the data site wrote them. No grade,
//   no score, no advice.
// - State-level figures sit in their own block and are never shown as county values.
// - If the county data cannot be loaded, the card says so and the rest still works.
// - Bills are listed only when the tracker carries a reviewed Support or Oppose
//   position. Labels describe bills, never people; no sponsor names.

const CountyReport = {
    MAX_BILLS_PER_SIDE: 4,
    FETCH_TIMEOUT_MS: 12000,
    BROWSE_URL: 'tracker.html',

    // ── Bills (pure; also run by scripts/check-county-report.js) ──

    // Topic for a bill: the tracker's own headline topic when it has one, else a
    // plain grouping of the tracker's category.
    billTopic(bill, headlines) {
        const h = headlines && headlines[bill.billId];
        if (h && h.topic) return h.topic;
        const cat = String(bill.category || '').toLowerCase();
        if (/vaccin|mrna|informed-consent|immuniz/.test(cat)) return 'Immunization';
        if (cat === 'fluoride') return 'Drinking water';
        if (cat === 'raw-milk') return 'Food safety';
        return 'Public health';
    },

    // Active, reviewed bills for one state plus Congress, split by SAFE Action's
    // recorded position. Returns counts too, so the card can say "none" honestly.
    selectBills(bills, state, headlines) {
        const st = String(state || '').toUpperCase();
        const out = { state: st, supports: [], opposes: [], monitoredInState: 0, unreviewed: 0 };
        if (!Array.isArray(bills) || !st) return out;
        const impact = { High: 0, Medium: 1, Low: 2 };
        for (const b of bills) {
            if (!b || b.isActive !== 'Yes') continue;
            const federal = b.level === 'Federal';
            if (!federal && b.state !== st) continue;
            const side = b.billType === 'pro' ? 'supports' : b.billType === 'anti' ? 'opposes' : null;
            if (!side) {
                if (!federal) out.monitoredInState++;
                continue;
            }
            if (!b.review) { out.unreviewed++; continue; }
            const h = headlines && headlines[b.billId];
            out[side].push({
                billId: b.billId,
                billNumber: b.billNumber || b.billId,
                title: (h && h.headline) || b.title || b.billNumber || '',
                officialTitle: b.title || '',
                where: federal ? 'Congress' : st,
                federal,
                status: b.status || '',
                lastActionDate: b.lastActionDate || '',
                topic: this.billTopic(b, headlines),
                impact: b.impact || '',
                url: /^https:\/\//.test(b.url || '') ? b.url : '',
            });
        }
        const order = (a, b) =>
            (a.federal - b.federal) ||
            ((impact[a.impact] ?? 3) - (impact[b.impact] ?? 3)) ||
            String(b.lastActionDate).localeCompare(String(a.lastActionDate)) ||
            String(a.billNumber).localeCompare(String(b.billNumber));
        out.supports.sort(order);
        out.opposes.sort(order);
        return out;
    },

    // ── County data (fail-soft) ──

    async _getJson(url) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.FETCH_TIMEOUT_MS);
        try {
            const r = await fetch(url, { signal: ctl.signal });
            return await r.json();
        } finally {
            clearTimeout(timer);
        }
    },

    // loc: { state, county: { kind, name } | null, fips, normalizedAddress }
    // Always resolves; on any failure returns { available: false, reason }.
    async fetchCounty(loc) {
        const miss = (reason) => ({ available: false, reason });
        if (!loc || !loc.state) return miss('no_address');
        // A state-only lookup carries nothing that identifies a county.
        const hasPlace = loc.fips || loc.county || (loc.normalizedAddress && loc.normalizedAddress.line1) || loc.state === 'DC';
        if (!hasPlace) return miss('no_address');
        let last = miss('county_not_matched');
        try {
            if (loc.fips) {
                return await this._getJson('/api/county-report?fips=' + encodeURIComponent(loc.fips));
            }
            // First choice: the county named by the address lookup. Only the state
            // and county name leave the browser on this path.
            if (loc.county || loc.state === 'DC') {
                const p = new URLSearchParams({
                    state: loc.state,
                    kind: (loc.county && loc.county.kind) || '',
                    name: (loc.county && loc.county.name) || '',
                });
                last = await this._getJson('/api/county-report?' + p.toString());
                if (last && (last.available || last.reason !== 'county_not_matched')) return last;
            }
            // Fallback: the Census geocoder behind /api/districts, the same call the
            // representative lookup already makes when it needs state districts.
            const a = loc.normalizedAddress || {};
            if (a.line1 && (a.state || loc.state)) {
                const p = new URLSearchParams({ street: a.line1, city: a.city || '', state: a.state || loc.state, zip: a.zip || '' });
                const d = await this._getJson('/api/districts?' + p.toString());
                if (d && d.county && /^\d{5}$/.test(d.county.fips || '')) {
                    return await this._getJson('/api/county-report?fips=' + d.county.fips);
                }
            }
            return last || miss('county_not_matched');
        } catch (e) {
            return miss('unreachable');
        }
    },

    async _headlines() {
        if (!this._headlineCache) {
            this._headlineCache = fetch('data/bill-headlines.json')
                .then(r => (r.ok ? r.json() : {}))
                .then(d => d.headlines || {})
                .catch(() => ({}));
        }
        return this._headlineCache;
    },

    // ── Rendering (DOM built with textContent only) ──

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    },

    _date(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        if (!m) return '';
        const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
        return mon + ' ' + Number(m[3]) + ', ' + m[1];
    },

    _list(items, cls) {
        const ul = this._el('ul', cls || 'crc-list');
        items.forEach(it => {
            const li = this._el('li');
            li.appendChild(document.createTextNode(typeof it === 'string' ? it : it.text));
            if (it && it.tag) { li.appendChild(document.createTextNode(' ')); li.appendChild(this._el('span', 'crc-chip', it.tag)); }
            ul.appendChild(li);
        });
        return ul;
    },

    _stateName(code) {
        return (typeof SAFE_CONFIG !== 'undefined' && SAFE_CONFIG.STATES && SAFE_CONFIG.STATES[code]) || code || '';
    },

    _renderData(box, data, stateCode) {
        box.appendChild(this._el('h3', 'crc-h', '1. Recent public health data'));
        if (!data || !data.available) {
            const why = {
                no_address: 'Enter a full street address above to see data for your county.',
                county_not_matched: 'This address could not be matched to a single county, so no county data is shown.',
                no_county_file: 'No data file is published for this county.',
            }[data && data.reason] || 'County data is unavailable right now. The rest of this page works as usual.';
            box.appendChild(this._el('p', 'crc-empty', why));
            return;
        }

        const countyQs = (data.questions || []).filter(q => q.scope !== 'state');
        const stateQs = (data.questions || []).filter(q => q.scope === 'state');

        if (!data.has_outbreak_data) {
            box.appendChild(this._el('p', 'crc-empty', 'No outbreak figures are published for this county itself.'));
        }

        if (countyQs.length) {
            const grid = this._el('div', 'crc-grid');
            countyQs.forEach(q => {
                const t = this._el('div', 'crc-tile');
                t.appendChild(this._el('div', 'crc-q', q.title));
                t.appendChild(this._el('div', 'crc-v', q.value));
                const meta = this._el('div', 'crc-meta');
                if (q.scope === 'regional') meta.appendChild(this._el('span', 'crc-chip crc-chip-ctx', 'Regional, not this county alone'));
                else if (q.tag) meta.appendChild(this._el('span', 'crc-chip', q.tag));
                if (q.as_of) meta.appendChild(this._el('span', 'crc-asof', 'as of ' + this._date(q.as_of)));
                t.appendChild(meta);
                if (q.details && q.details.length) t.appendChild(this._list(q.details));
                const extra = (q.also || []).length;
                if (extra || q.note) {
                    const more = this._el('details', 'crc-more');
                    more.appendChild(this._el('summary', null, extra ? 'More signals (' + extra + ') and method' : 'How this is measured'));
                    if (extra) more.appendChild(this._list(q.also));
                    if (q.note) more.appendChild(this._el('p', 'crc-note', q.note));
                    t.appendChild(more);
                }
                grid.appendChild(t);
            });
            box.appendChild(grid);
        }

        if (stateQs.length) {
            const names = stateQs.map(q => '"' + q.title + '"').join(' and ');
            box.appendChild(this._el('p', 'crc-empty', 'No county figure is published for ' + names + '. The statewide figure is under State context below.'));
        }

        if (data.environment && data.environment.length) {
            box.appendChild(this._el('h4', 'crc-sub', 'Recent environment readings in this county'));
            box.appendChild(this._list(data.environment.map(s => ({ text: s.text, tag: s.basis }))));
        }

        const ctx = (data.state_context || []).map(s => s.text);
        stateQs.forEach(q => {
            // The coverage headline repeats the statewide coverage sentence already listed.
            if (q.key === 'protected' && ctx.some(t => /kindergarten/i.test(t))) return;
            const details = (q.details || []).filter(d => !/^No county figure/i.test(d));
            ctx.push(q.title + ' ' + q.value + (q.as_of ? ' (as of ' + this._date(q.as_of) + ')' : '') +
                (details.length ? ': ' + details.join(' ') : '.'));
        });
        if (ctx.length) {
            const sc = this._el('div', 'crc-state');
            sc.appendChild(this._el('h4', 'crc-sub', 'State context: ' + (data.county.state_name || this._stateName(stateCode))));
            sc.appendChild(this._el('p', 'crc-note', 'These figures describe the state as a whole. They are not values for this county.'));
            sc.appendChild(this._list(Array.from(new Set(ctx))));
            box.appendChild(sc);
        }

        if (data.evidence) {
            const ev = this._el('details', 'crc-more');
            ev.appendChild(this._el('summary', null, 'How much data is behind this'));
            ev.appendChild(this._el('p', 'crc-note', data.evidence.replace(/^How much data is behind this page:\s*/i, '')));
            box.appendChild(ev);
        }
    },

    _renderBills(box, sel) {
        const stName = this._stateName(sel.state);
        box.appendChild(this._el('h3', 'crc-h', '2. Bills SAFE Action supports or opposes'));
        box.appendChild(this._el('p', 'crc-note',
            'County-level bills are not in the tracker. These are active ' + stName + ' and federal bills with a reviewed SAFE Action position. Bills still marked Monitor are not listed.'));

        const side = (label, cls, list) => {
            const wrap = this._el('div', 'crc-bills ' + cls);
            wrap.appendChild(this._el('h4', 'crc-sub', label + ' (' + list.length + ')'));
            if (!list.length) {
                wrap.appendChild(this._el('p', 'crc-empty', 'None right now.'));
                return wrap;
            }
            const ul = this._el('ul', 'crc-list');
            list.slice(0, this.MAX_BILLS_PER_SIDE).forEach(b => {
                const li = this._el('li');
                const num = b.url ? this._el('a', 'crc-billnum', b.where + ' ' + b.billNumber) : this._el('strong', 'crc-billnum', b.where + ' ' + b.billNumber);
                if (b.url) { num.href = b.url; num.rel = 'noopener'; num.target = '_blank'; }
                li.appendChild(num);
                li.appendChild(document.createTextNode(' ' + b.title + ' '));
                li.appendChild(this._el('span', 'crc-chip', b.topic));
                if (b.status) { li.appendChild(document.createTextNode(' ')); li.appendChild(this._el('span', 'crc-asof', b.status)); }
                ul.appendChild(li);
            });
            wrap.appendChild(ul);
            if (list.length > this.MAX_BILLS_PER_SIDE) {
                wrap.appendChild(this._el('p', 'crc-note', 'Showing ' + this.MAX_BILLS_PER_SIDE + ' of ' + list.length + '.'));
            }
            return wrap;
        };

        if (!sel.supports.length && !sel.opposes.length) {
            box.appendChild(this._el('p', 'crc-empty',
                'No active ' + stName + ' or federal bill carries a SAFE Action support or oppose position right now.'));
        } else {
            if (!sel.supports.concat(sel.opposes).some(b => !b.federal)) {
                box.appendChild(this._el('p', 'crc-empty',
                    'No active ' + stName + ' bill carries a SAFE Action support or oppose position right now. The bills below are federal.'));
            }
            const cols = this._el('div', 'crc-cols');
            cols.appendChild(side('SAFE Action supports', 'crc-pro', sel.supports));
            cols.appendChild(side('SAFE Action opposes', 'crc-anti', sel.opposes));
            box.appendChild(cols);
        }
        const more = this._el('p', 'crc-note');
        if (sel.monitoredInState) {
            more.appendChild(document.createTextNode(sel.monitoredInState.toLocaleString() + ' more active ' + stName + ' bills are being monitored with no position yet. '));
        }
        const a = this._el('a', null, 'Browse all ' + stName + ' bills');
        a.href = this.BROWSE_URL + '?state=' + encodeURIComponent(sel.state) + '#browse-bills';
        more.appendChild(a);
        box.appendChild(more);
    },

    _renderOfficials(box, reps) {
        box.appendChild(this._el('h3', 'crc-h', '3. Your officials'));
        if (!reps || !reps.length) {
            box.appendChild(this._el('p', 'crc-empty', 'No officials were found for this lookup.'));
            return;
        }
        const p = this._el('p', 'crc-empty');
        p.appendChild(document.createTextNode(reps.length + (reps.length === 1 ? ' official was' : ' officials were') + ' found for this lookup. Email, call and contact form options for each are above. '));
        const a = this._el('a', 'btn primary small', 'Contact them');
        a.href = '#email-all-hero';
        p.appendChild(a);
        box.appendChild(p);
    },

    _renderFooter(box, data) {
        if (!data || !data.site) return;
        const f = this._el('div', 'crc-foot');
        if (data.available && data.url) {
            const a = this._el('a', 'crc-full', 'See the full county page for ' + data.county.name);
            a.href = data.url; a.rel = 'noopener'; a.target = '_blank';
            f.appendChild(a);
        }
        const credit = this._el('p', 'crc-credit');
        const c = this._el('a', null, data.credit || '');
        c.href = data.site; c.rel = 'noopener'; c.target = '_blank';
        credit.appendChild(c);
        if (data.built) credit.appendChild(document.createTextNode('. Data built ' + this._date(data.built) + '.'));
        f.appendChild(credit);
        box.appendChild(f);
    },

    hide() {
        const box = document.getElementById('county-report');
        if (box) { box.style.display = 'none'; box.textContent = ''; }
        this._token = null;
    },

    // loc: { state, county, fips, normalizedAddress } (county parts optional).
    // Never throws: the representative list must not depend on this card.
    async show(loc, reps) {
        const box = document.getElementById('county-report');
        if (!box || !loc || !loc.state) return;
        const token = this._token = {};
        try {
            box.style.display = '';
            box.textContent = '';
            box.appendChild(this._el('p', 'crc-eyebrow', 'COUNTY REPORT CARD'));
            box.appendChild(this._el('p', 'crc-empty', 'Loading county data...'));

            const [data, bills, headlines] = await Promise.all([
                this.fetchCounty(loc),
                typeof LegislationAPI !== 'undefined' ? LegislationAPI.getLegislation(null).catch(() => []) : [],
                this._headlines(),
            ]);
            if (this._token !== token) return; // a newer lookup replaced this one

            box.textContent = '';
            box.appendChild(this._el('p', 'crc-eyebrow', 'COUNTY REPORT CARD'));
            const ok = data && data.available && data.county;
            const title = ok ? data.county.name + ', ' + (data.county.state_name || loc.state) : this._stateName(loc.state);
            box.appendChild(this._el('h2', 'crc-title', title));
            if (ok && data.county.population) {
                box.appendChild(this._el('p', 'crc-note', 'Population ' + data.county.population.toLocaleString() + (data.county.pop_year ? ' (' + data.county.pop_year + ')' : '') + '.'));
            }
            this._renderData(box, data, loc.state);
            this._renderBills(box, this.selectBills(bills, loc.state, headlines));
            this._renderOfficials(box, reps);
            this._renderFooter(box, data);
        } catch (e) {
            console.warn('County report card failed:', e);
            box.style.display = 'none';
        }
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CountyReport;
