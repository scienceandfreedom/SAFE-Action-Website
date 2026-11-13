// County report card data: a small cached proxy in front of What's In My County
// (published by Priori Intelligence). That site serves static JSON without
// cross-origin headers, so the browser cannot read it directly; this function
// reads it server side and returns a short summary for one county.
//
// Plain (req, res) handler with no requires, so dev-server.js and
// scripts/check-county-report.js can load it without installing anything.
//
// GET /api/county-report?fips=06073
// GET /api/county-report?state=CA&kind=county&name=san_diego
//
// Rules this file keeps:
// - Sentences and values are passed through as the data site wrote them. Nothing
//   here scores, grades or interprets a county.
// - State-level figures go in their own list (`state_context`) and are never
//   mixed into the county lists.
// - A county is returned only when it is identified exactly: a 5-digit FIPS code,
//   or a state plus a name that matches one county in that state and no other.
// - Any failure answers with { available: false, reason } so the page can say the
//   data is unavailable and carry on.

// The one place the data site's address lives. The custom domain
// (whatsinmycounty.com) is not pointed yet; change this line when it is.
const COUNTY_SITE_BASE = 'https://whatsinmycounty.priori-intelligence.workers.dev';

const CREDIT = "Data: What's In My County, published by Priori Intelligence";
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const STATE_TAG = 'state level';

// ---------------------------------------------------------------- unpacking
// Same rules as the data site's own loader (static/js/data.js, src/chm/export/pack.py).

const ESCAPE = '§';
const TABLE = ESCAPE + 'T';
const DTABLE = ESCAPE + 'D';

function unref(x, dict) {
  if (typeof x === 'string') {
    if (x.startsWith(ESCAPE) && !x.startsWith(ESCAPE + ESCAPE) && x !== TABLE && x !== DTABLE) {
      return unref(dict[parseInt(x.slice(1), 36)], dict);
    }
    return x;
  }
  if (Array.isArray(x)) return x.map((v) => unref(v, dict));
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) o[k] = unref(v, dict);
    return o;
  }
  return x;
}

function untables(x) {
  if (Array.isArray(x)) {
    if (x.length && x[0] === TABLE) {
      const keys = x[1];
      return x.slice(2).map((row) => {
        const o = {};
        keys.forEach((k, i) => { o[k] = untables(row[i]); });
        return o;
      });
    }
    return x.map(untables);
  }
  if (x && typeof x === 'object') {
    const o = {};
    if (DTABLE in x) {
      const keys = x[DTABLE];
      for (const [k, row] of Object.entries(x)) {
        if (k === DTABLE) continue;
        const r = {};
        keys.forEach((c, i) => { r[c] = untables(row[i]); });
        o[k] = r;
      }
      return o;
    }
    for (const [k, v] of Object.entries(x)) o[k] = untables(v);
    return o;
  }
  if (typeof x === 'string' && x.startsWith(ESCAPE + ESCAPE)) return x.slice(1);
  return x;
}

function unpack(x, dict) {
  return untables(dict ? unref(x, dict) : x);
}

// ---------------------------------------------------------------- county matching

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste')
    .replace(/[^a-z0-9]+/g, '');
}

// What a county-level division of each kind is called in the county list.
const KIND_SUFFIXES = {
  county: ['county'],
  parish: ['parish'],
  borough: ['borough', 'city and borough', 'municipality'],
  census_area: ['census area'],
  // An independent city (Virginia, Baltimore, St. Louis, Carson City). A place
  // matches only when the county list has a county-equivalent city of that name.
  place: ['city', ''],
};

// Returns the one county in `state` that the name identifies, or null. Never guesses:
// zero matches or more than one match both return null.
function matchCounty(counties, state, kind, name) {
  const st = String(state || '').toUpperCase();
  const inState = (counties || []).filter((c) => c.state === st);
  if (!inState.length) return null;
  // A state with a single county-equivalent (the District of Columbia).
  if (inState.length === 1) return inState[0];
  const suffixes = KIND_SUFFIXES[String(kind || '').toLowerCase()];
  const base = normName(String(name || '').replace(/_/g, ' '));
  if (!suffixes || !base) return null;
  const wanted = new Set(suffixes.map((s) => base + normName(s)));
  const hits = inState.filter((c) => wanted.has(normName(c.name)));
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------- summary

function isStateLevel(tags) {
  return Array.isArray(tags) ? tags.includes(STATE_TAG) : tags === STATE_TAG;
}

function daysBetween(a, b) {
  const x = Date.parse(a), y = Date.parse(b);
  if (isNaN(x) || isNaN(y)) return null;
  return Math.round((y - x) / 86400000);
}

// Builds the short report from one unpacked county file. `built` is the data
// site's build time (ISO string), used only to decide which environment readings
// are recent.
function summarize(bundle, built) {
  const b = (bundle && bundle.county) || {};
  const c = b.county || {};
  const labels = b.basis_labels || {};
  const headline = b.headline || {};
  const stateContext = [];
  const seen = new Set();
  const pushState = (text, asOf) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    stateContext.push({ text, as_of: asOf || null });
  };

  const questions = [];
  const headlineState = [];
  for (const key of ['is_here', 'is_rising', 'protected']) {
    const h = headline[key];
    if (!h) continue;
    const hasValue = h.value !== null && h.value !== undefined && h.value !== '';
    const also = [];
    for (const a of h.also || []) {
      if (!a || !a.text) continue;
      if (isStateLevel(a.tag)) pushState(a.text, h.as_of);
      else also.push({ text: a.text, tag: a.tag || null });
    }
    if (h.state && h.state.text) headlineState.push(h.state.text);
    // The data site falls back to a regional or statewide figure when a county has
    // none of its own, and tags it. Carry that through as `scope` so the page can
    // keep a statewide figure out of the county's own list.
    const tags = Array.isArray(h.tags) ? h.tags : [];
    const scope = isStateLevel(tags) || isStateLevel(h.tag) ? 'state'
      : (tags.includes('regional') || h.tag === 'regional') ? 'regional' : 'county';
    questions.push({
      key,
      title: h.title || '',
      value: hasValue ? String(h.value) : (h.empty_value || 'No data published'),
      has_value: hasValue,
      scope,
      tag: h.tag || (Array.isArray(h.tags) && h.tags[0]) || null,
      as_of: h.as_of || null,
      details: (h.details || []).filter(Boolean),
      also,
      note: h.note || h.rule || null,
      missing: (h.missing || []).filter(Boolean),
    });
  }

  // Sentences the data site wrote about outbreak signals. County-basis sentences
  // stay with the county; state-level ones go to state context.
  const outbreak = [];
  for (const fam of (b.readings && b.readings.outbreak) || []) {
    for (const s of fam.sentences || []) {
      if (!s || !s.text) continue;
      if (s.basis === 'state_context' || isStateLevel(s.tags)) { pushState(s.text, s.as_of); continue; }
      outbreak.push({
        text: s.text,
        as_of: s.as_of || null,
        family: fam.family || null,
        basis: s.basis ? (labels[s.basis] || s.basis) : null,
      });
    }
  }

  // A headline's own statewide line repeats the coverage sentence above when there
  // is one; keep it only when the readings had no state-level coverage sentence.
  const hasStateCoverage = ((b.readings && b.readings.outbreak) || []).some((fam) =>
    fam.family === 'coverage' && (fam.sentences || []).some((s) => s && (s.basis === 'state_context' || isStateLevel(s.tags))));
  if (!hasStateCoverage) headlineState.forEach((t) => pushState(t, null));

  // Recent environment readings: dated within 45 days of the data build.
  const environment = [];
  for (const fam of (b.readings && b.readings.environment) || []) {
    for (const s of fam.sentences || []) {
      if (!s || !s.text || s.basis === 'state_context' || isStateLevel(s.tags)) continue;
      const age = daysBetween(s.as_of, built);
      if (age === null || age < 0 || age > 45) continue;
      environment.push({
        text: s.text,
        as_of: s.as_of,
        family: fam.family || null,
        basis: s.basis ? (labels[s.basis] || s.basis) : null,
      });
    }
  }

  const anyOutbreak = questions.some((q) => q.has_value && q.scope !== 'state') || outbreak.length > 0;
  return {
    county: {
      fips: c.fips || null,
      name: c.name || null,
      state: c.state || null,
      state_name: c.state_name || null,
      population: typeof c.population === 'number' ? c.population : null,
      pop_year: c.pop_year || null,
    },
    has_outbreak_data: anyOutbreak,
    questions,
    outbreak,
    environment: environment.slice(0, 3),
    state_context: stateContext,
    evidence: (b.evidence_summary && b.evidence_summary.text) || null,
  };
}

// ---------------------------------------------------------------- upstream

const cache = { manifest: null, manifestAt: 0, version: null, dict: null, counties: null };

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}

async function getManifest(force) {
  if (!force && cache.manifest && Date.now() - cache.manifestAt < MANIFEST_TTL_MS) return cache.manifest;
  const m = await getJson(COUNTY_SITE_BASE + '/data/manifest.json');
  if (!m || !m.base) throw new Error('no manifest');
  if (m.version !== cache.version) { cache.dict = null; cache.counties = null; cache.version = m.version; }
  cache.manifest = m;
  cache.manifestAt = Date.now();
  return m;
}

function shared(m, key, rel, transform) {
  if (!cache[key]) {
    const p = getJson(COUNTY_SITE_BASE + m.base + rel).then((x) => {
      if (x === null) throw new Error(rel + ' missing');
      return transform ? transform(x) : x;
    });
    p.catch(() => { if (cache[key] === p) cache[key] = null; });
    cache[key] = p;
  }
  return cache[key];
}

async function loadCounty(fips) {
  let m = await getManifest(false);
  let raw = await getJson(COUNTY_SITE_BASE + m.base + 'c/' + fips + '.json');
  if (raw === null) {
    // A nightly build may have replaced the versioned files: read the manifest
    // again and retry once before calling the county missing.
    m = await getManifest(true);
    raw = await getJson(COUNTY_SITE_BASE + m.base + 'c/' + fips + '.json');
  }
  if (raw === null) return { manifest: m, bundle: null };
  const dict = await shared(m, 'dict', 'dict.json');
  return { manifest: m, bundle: unpack(raw, dict) };
}

// ---------------------------------------------------------------- handler

function base() {
  return { site: COUNTY_SITE_BASE, credit: CREDIT };
}

function unavailable(res, status, reason, extra) {
  // Failures are never cached at the edge for long: an outage should clear by itself.
  res.setHeader('Cache-Control', status === 200 ? 'public, s-maxage=300' : 'no-store');
  return res.status(status).json(Object.assign({ available: false, reason }, base(), extra || {}));
}

const countyReport = async (req, res) => {
  const q = req.query || {};
  let fips = String(q.fips || '').trim();
  const state = String(q.state || '').trim().toUpperCase();

  if (fips && !/^\d{5}$/.test(fips)) return unavailable(res, 400, 'bad_request');
  if (!fips && !/^[A-Z]{2}$/.test(state)) return unavailable(res, 400, 'bad_request');

  try {
    if (!fips) {
      const m = await getManifest(false);
      const counties = await shared(m, 'counties', 'counties.json', (x) => unpack(x));
      const hit = matchCounty(counties, state, q.kind, q.name);
      if (!hit) return unavailable(res, 200, 'county_not_matched');
      fips = hit.fips;
    }

    const { manifest, bundle } = await loadCounty(fips);
    if (!bundle) return unavailable(res, 200, 'no_county_file', { fips });

    const summary = summarize(bundle, manifest.built);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(Object.assign({ available: true }, base(), {
      url: COUNTY_SITE_BASE + '/county/' + fips,
      built: manifest.built || null,
    }, summary));
  } catch (e) {
    console.error('County report upstream error:', e && e.message);
    return unavailable(res, 502, 'upstream_unreachable');
  }
};

module.exports = { countyReport, unpack, matchCounty, summarize, normName, COUNTY_SITE_BASE, CREDIT, _cache: cache };
