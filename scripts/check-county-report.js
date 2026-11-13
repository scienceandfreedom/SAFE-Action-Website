#!/usr/bin/env node
// Checks for the county report card. No packages needed.
//
//   node scripts/check-county-report.js          offline checks only
//   node scripts/check-county-report.js --live   also reads What's In My County
//
// Offline: unpacking, county name matching (including the collision cases), the
// summary rules (state-level figures kept apart), fail-soft answers when the data
// site is down or a county is missing, the bill selection rules against
// data/bills.json, and two house rules on the new files.
// Live: three counties in three states, one of them with little data.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const fn = require(path.join(ROOT, 'functions/county-report.js'));
const CountyReport = require(path.join(ROOT, 'js/county-report.js'));

let failed = 0, passed = 0;
function ok(cond, label) {
    if (cond) { passed++; } else { failed++; console.error('FAIL  ' + label); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + '  got ' + JSON.stringify(a)); }

function call(query) {
    return new Promise((resolve) => {
        const res = {
            headers: {}, code: 0,
            setHeader(k, v) { this.headers[k] = v; },
            status(c) { this.code = c; return this; },
            json(body) { resolve({ status: this.code, headers: this.headers, body }); },
        };
        fn.countyReport({ query }, res);
    });
}
function resetCache() { Object.assign(fn._cache, { manifest: null, manifestAt: 0, version: null, dict: null, counties: null }); }

// ------------------------------------------------------------ unpacking
const S = '§';
eq(fn.unpack({ a: S + '0', b: [S + 'T', ['x', 'y'], [1, S + '1'], [2, 'z']] }, ['hello', 'world']),
    { a: 'hello', b: [{ x: 1, y: 'world' }, { x: 2, y: 'z' }] }, 'unpack: dictionary refs and row tables');
eq(fn.unpack({ [S + 'D']: ['n'], k1: [5], k2: [6] }), { k1: { n: 5 }, k2: { n: 6 } }, 'unpack: keyed tables');
eq(fn.unpack([S + S + 'literal']), [S + 'literal'], 'unpack: escaped literal');

// ------------------------------------------------------------ county matching
const COUNTIES = [
    ['24005', 'Baltimore County', 'MD'], ['24510', 'Baltimore city', 'MD'],
    ['29189', 'St. Louis County', 'MO'], ['29510', 'St. Louis city', 'MO'],
    ['51059', 'Fairfax County', 'VA'], ['51600', 'Fairfax city', 'VA'],
    ['22071', 'Orleans Parish', 'LA'], ['22051', 'Jefferson Parish', 'LA'],
    ['02020', 'Anchorage Municipality', 'AK'], ['02110', 'Juneau City and Borough', 'AK'],
    ['02290', 'Yukon-Koyukuk Census Area', 'AK'],
    ['32510', 'Carson City', 'NV'], ['32003', 'Clark County', 'NV'],
    ['11001', 'District of Columbia', 'DC'],
    ['48453', 'Travis County', 'TX'], ['48301', 'Loving County', 'TX'],
    ['35013', 'Doña Ana County', 'NM'], ['35001', 'Bernalillo County', 'NM'],
    ['17037', 'DeKalb County', 'IL'], ['17031', 'Cook County', 'IL'],
    ['09110', 'Capitol Planning Region', 'CT'], ['09190', 'Western Connecticut Planning Region', 'CT'],
].map(([fips, name, state]) => ({ fips, name, state }));
const m = (st, kind, name) => { const h = fn.matchCounty(COUNTIES, st, kind, name); return h ? h.fips : null; };
eq(m('MD', 'county', 'baltimore'), '24005', 'match: Baltimore County');
eq(m('MD', 'place', 'baltimore'), '24510', 'match: Baltimore city (independent)');
eq(m('MO', 'county', 'st_louis'), '29189', 'match: St. Louis County');
eq(m('MO', 'place', 'st_louis'), '29510', 'match: St. Louis city');
eq(m('MO', 'county', 'saint_louis'), '29189', 'match: Saint spelled out');
eq(m('VA', 'county', 'fairfax'), '51059', 'match: Fairfax County');
eq(m('VA', 'place', 'fairfax'), '51600', 'match: Fairfax city');
eq(m('LA', 'parish', 'orleans'), '22071', 'match: Louisiana parish');
eq(m('AK', 'borough', 'anchorage'), '02020', 'match: Alaska municipality');
eq(m('AK', 'borough', 'juneau'), '02110', 'match: Alaska city and borough');
eq(m('AK', 'census_area', 'yukon-koyukuk'), '02290', 'match: Alaska census area');
eq(m('NV', 'place', 'carson_city'), '32510', 'match: Carson City');
eq(m('DC', '', ''), '11001', 'match: single-county state');
eq(m('NM', 'county', 'doña_ana'), '35013', 'match: accented name');
eq(m('IL', 'county', 'de_kalb'), '17037', 'match: spacing variant');
eq(m('TX', 'place', 'austin'), null, 'match: an ordinary city is not a county');
eq(m('CT', 'county', 'fairfield'), null, 'match: Connecticut old county names do not match planning regions');
eq(m('TX', 'county', ''), null, 'match: empty name');
eq(m('TX', 'bogus', 'travis'), null, 'match: unknown kind');
eq(m('ZZ', 'county', 'travis'), null, 'match: unknown state');

// ------------------------------------------------------------ summary rules
const bundle = { county: {
    county: { fips: '30069', name: 'Petroleum County', state: 'MT', state_name: 'Montana', population: 500, pop_year: 2025 },
    basis_labels: { measured_county: 'published for the county', state_context: 'state level' },
    headline: {
        is_here: { title: 'Is it here?', value: 'No measles cases reported', empty_value: 'No data published', tags: ['from case counts'], tag: 'from case counts', as_of: '2026-11-06',
            details: ['d1'], also: [{ tag: 'state level', text: 'ED visits statewide: 1%.' }, { tag: 'from case counts', text: 'Cases: 0.' }] },
        is_rising: { title: 'Is it rising?', value: 'Increasing statewide', empty_value: 'No data published', tags: ['state level'], tag: 'state level', as_of: '2026-11-07', details: [] },
        protected: { title: 'How protected is this community?', value: null, empty_value: 'No county figure', tags: [], state: { text: 'Statewide coverage: 92.9%.' } },
    },
    readings: {
        outbreak: [{ family: 'cases', sentences: [
            { text: 'County sentence.', basis: 'measured_county', as_of: '2026-11-06' },
            { text: 'State sentence.', basis: 'state_context', as_of: '2025-08-01', tags: ['state level'] },
        ] }],
        environment: [{ family: 'air', sentences: [
            { text: 'Recent air.', basis: 'measured_county', as_of: '2026-11-12' },
            { text: 'Old air.', basis: 'measured_county', as_of: '2025-12-31' },
        ] }],
    },
    evidence_summary: { text: 'Evidence.' },
} };
const sum = fn.summarize(bundle, '2026-11-13T15:21:53+00:00');
eq(sum.questions.map(q => q.scope), ['county', 'state', 'county'], 'summary: scope of each headline');
eq(sum.questions[2].value, 'No county figure', 'summary: empty value shown when there is no figure');
eq(sum.questions[2].has_value, false, 'summary: empty headline is flagged');
eq(sum.questions[0].also, [{ text: 'Cases: 0.', tag: 'from case counts' }], 'summary: state-level "also" lines leave the county tile');
eq(sum.state_context.map(s => s.text), ['ED visits statewide: 1%.', 'State sentence.', 'Statewide coverage: 92.9%.'], 'summary: state context collected in one list');
eq(sum.outbreak.map(s => s.text), ['County sentence.'], 'summary: county list holds no state sentences');
eq(sum.environment.map(s => s.text), ['Recent air.'], 'summary: only recent environment readings');
ok(sum.has_outbreak_data === true, 'summary: county outbreak data present');
const empty = fn.summarize({ county: { county: { fips: '99999' }, headline: { is_rising: bundle.county.headline.is_rising } } }, null);
ok(empty.has_outbreak_data === false, 'summary: a statewide headline alone is not county outbreak data');

// ------------------------------------------------------------ bills
const bills = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bills.json'), 'utf8')).bills;
const headlines = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bill-headlines.json'), 'utf8')).headlines;
const byId = new Map(bills.map(b => [b.billId, b]));
let zeroState = null;
for (const st of ['CA', 'NY', 'TX', 'MT']) {
    const sel = CountyReport.selectBills(bills, st, headlines);
    const all = sel.supports.concat(sel.opposes);
    ok(all.every(x => { const b = byId.get(x.billId); return b.isActive === 'Yes' && b.review && (b.state === st || b.level === 'Federal'); }),
        'bills ' + st + ': every listed bill is active, reviewed, and from the state or Congress');
    ok(sel.supports.every(x => byId.get(x.billId).billType === 'pro') && sel.opposes.every(x => byId.get(x.billId).billType === 'anti'),
        'bills ' + st + ': sides follow the tracker position');
    const want = bills.filter(b => b.isActive === 'Yes' && b.review && (b.billType === 'pro' || b.billType === 'anti') && (b.state === st || b.level === 'Federal')).length;
    eq(all.length, want, 'bills ' + st + ': count matches an independent filter');
    ok(JSON.stringify(sel).indexOf('sponsor') === -1, 'bills ' + st + ': no sponsor data carried');
    if (!all.some(x => !x.federal)) zeroState = zeroState || st;
    console.log('  ' + st + ': supports ' + sel.supports.length + ', opposes ' + sel.opposes.length + ', monitored in state ' + sel.monitoredInState);
}
ok(zeroState !== null, 'bills: at least one checked state has no state bill with a position (the "none" case)');
eq(CountyReport.selectBills(null, 'CA'), { state: 'CA', supports: [], opposes: [], monitoredInState: 0, unreviewed: 0 }, 'bills: missing data gives empty lists');
eq(CountyReport.billTopic({ billId: 'x', category: 'fluoride' }, {}), 'Drinking water', 'bills: topic from category');

// ------------------------------------------------------------ house rules on new files
const NEW = ['functions/county-report.js', 'js/county-report.js', 'scripts/check-county-report.js', 'docs/plans/2026-11-13-county-report-card.md'];
const HOST = ['whatsinmycounty', 'priori-intelligence', 'workers', 'dev'].join('.'); // split so this file does not hold the address
for (const f of NEW) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    ok(text.indexOf(String.fromCharCode(8212)) === -1 && text.indexOf(String.fromCharCode(8211)) === -1, 'house: no em or en dash in ' + f);
    if (f !== 'functions/county-report.js') ok(text.indexOf(HOST) === -1, 'house: data site address only in functions/county-report.js, not ' + f);
}
for (const f of ['js/my-reps.js', 'js/my-reps-page.js', 'outreach.html', 'js/config.js', 'dev-server.js', 'sw.js', 'firebase.json']) {
    ok(fs.readFileSync(path.join(ROOT, f), 'utf8').indexOf(HOST) === -1, 'house: data site address not in ' + f);
}

// ------------------------------------------------------------ fail-soft and live
(async () => {
    const realFetch = global.fetch;

    eq((await call({})).status, 400, 'handler: no parameters is a bad request');
    eq((await call({ fips: '6073' })).status, 400, 'handler: malformed FIPS is a bad request');

    resetCache();
    global.fetch = async () => { throw new Error('down'); };
    let r = await call({ fips: '06073' });
    ok(r.status === 502 && r.body.available === false && r.body.reason === 'upstream_unreachable', 'handler: data site down answers available:false');
    eq(r.headers['Cache-Control'], 'no-store', 'handler: an outage is not cached');
    ok(r.body.credit === fn.CREDIT, 'handler: credit present even when unavailable');

    resetCache();
    let manifestReads = 0;
    global.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith('/data/manifest.json')) { manifestReads++; return { ok: true, status: 200, json: async () => ({ version: 'v1', base: '/data/v/v1/', built: '2026-11-13T00:00:00+00:00' }) }; }
        if (u.endsWith('/counties.json')) return { ok: true, status: 200, json: async () => COUNTIES };
        if (u.endsWith('/dict.json')) return { ok: true, status: 200, json: async () => [] };
        if (u.endsWith('/c/30069.json')) return { ok: true, status: 200, json: async () => bundle };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    r = await call({ fips: '99999' });
    ok(r.status === 200 && r.body.available === false && r.body.reason === 'no_county_file', 'handler: a county with no file is reported as such');
    eq(manifestReads, 2, 'handler: manifest is re-read once before calling a county missing');
    r = await call({ state: 'TX', kind: 'place', name: 'austin' });
    ok(r.body.available === false && r.body.reason === 'county_not_matched', 'handler: unmatched name returns no county');
    r = await call({ fips: '30069' });
    ok(r.status === 200 && r.body.available === true && r.body.county.name === 'Petroleum County', 'handler: county summary returned');
    ok(r.body.url === fn.COUNTY_SITE_BASE + '/county/30069', 'handler: county page link built from the one constant');
    ok(/s-maxage=3600/.test(r.headers['Cache-Control']), 'handler: success is cached at the edge');

    global.fetch = realFetch;
    resetCache();

    if (process.argv.includes('--live')) {
        // The reference county file checked against the data site's own loader rules
        // lives upstream; here we check three real counties end to end.
        for (const [fips, name, st] of [['06073', 'San Diego County', 'CA'], ['36001', 'Albany County', 'NY'], ['30069', 'Petroleum County', 'MT']]) {
            const x = await call({ fips });
            ok(x.status === 200 && x.body.available === true, 'live ' + fips + ': available');
            if (!x.body.available) continue;
            ok(x.body.county.name === name && x.body.county.state === st, 'live ' + fips + ': is ' + name + ', ' + st);
            ok(x.body.questions.length === 3, 'live ' + fips + ': three headline questions');
            ok(x.body.outbreak.every(s => !/statewide/i.test(s.text) || /this county/i.test(s.text)), 'live ' + fips + ': no statewide sentence in the county list');
            console.log('  ' + name + ', ' + st + ': ' + x.body.questions.map(q => q.value + ' [' + q.scope + ']').join(' | ') +
                '; county sentences ' + x.body.outbreak.length + ', state context ' + x.body.state_context.length);
        }
        const byName = await call({ state: 'MT', kind: 'county', name: 'petroleum' });
        ok(byName.body.available && byName.body.county.fips === '30069', 'live: name lookup finds Petroleum County');
    }

    console.log((failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
