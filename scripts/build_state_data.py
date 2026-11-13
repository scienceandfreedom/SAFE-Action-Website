#!/usr/bin/env python3
"""Build the per-state data files the state pages (/ca, /tx ... and /states) read.

Writes, for each of the 50 states and the District of Columbia:

  data/states/<xx>.json         legislators and members of Congress, from data/legislators.json,
                                with record links and act counts from data/scorecard.json
  data/states/<xx>.health.json  public health snapshot from What's In My County (published by
                                Priori Intelligence): state-level figures and a county table
  data/states/index.json        one row per state for the /states index

Bills are NOT baked here: the pages read data/live.json at run time, so bill counts and labels
always match the tracker.

Why a snapshot: What's In My County sends no cross-origin header and this site's
Content-Security-Policy allows same-origin requests only, so a browser on scienceandfreedom.com
cannot read it directly. The snapshot is same-origin and every figure carries its own period.

Fail-soft rules:
  * If What's In My County cannot be reached at all, existing *.health.json files are left as
    they are (their dates show their age) and the script still exits 0.
  * If one measure cannot be fetched, it is written as {"available": false} and the page says so.
  * A state-level figure is only written if two counties of the state report the same value.

No territories: What's In My County covers the 50 states and the District of Columbia, and the
bill tracker has no territory entries.

Usage: python3 scripts/build_state_data.py [--repo .] [--skip-health] [--health-only]
Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request
from pathlib import Path

# The one place the What's In My County address lives. Change it here when
# whatsinmycounty.com is pointed; the pages read it from the generated files.
WIMC_BASE = "https://whatsinmycounty.com"
WIMC_NAME = "What's In My County"
WIMC_PUBLISHER = "Priori Intelligence"
CREDIT = "Data: What's In My County, published by Priori Intelligence"

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

# County-level measures taken from What's In My County, in table order. Each is one published
# measure; nothing here is combined into a score. Regional (health service area) measures are
# left out on purpose: they are not county values.
MEASURES = [
    "ww_covid_n_sites", "ww_covid_wval_level_max", "ww_covid_trend_4wk",
    "ww_flu_a_n_sites", "ww_flu_a_wval_level_max", "ww_flu_a_trend_4wk",
    "ww_rsv_n_sites", "ww_rsv_wval_level_max", "ww_rsv_trend_4wk",
    "ww_measles_detected_recent",
    "measles_cases_ytd", "measles_cases_4wk",
    "mmr2_kindergarten_ca_low", "mmr2_kindergarten_ca_high",
    "aqi_days_over_100", "water_systems_hb_violation_5y", "superfund_npl_final",
    "dc_locations_osm",
]
# Only bases that are true county values may enter the county table.
COUNTY_BASES = {"measured_county", "aggregated_sites", "modeled"}

# ------------------------------------------------------------------ What's In My County reader

ESC, TABLE, DTABLE = "§", "§T", "§D"


def _unref(x, d):
    if isinstance(x, str):
        if x.startswith(ESC) and not x.startswith(ESC + ESC) and x not in (TABLE, DTABLE):
            return _unref(d[int(x[1:], 36)], d)
        return x
    if isinstance(x, list):
        return [_unref(v, d) for v in x]
    if isinstance(x, dict):
        return {k: _unref(v, d) for k, v in x.items()}
    return x


def _untables(x):
    if isinstance(x, list):
        if x and x[0] == TABLE:
            keys = x[1]
            return [{k: _untables(r[i]) for i, k in enumerate(keys)} for r in x[2:]]
        return [_untables(v) for v in x]
    if isinstance(x, dict):
        if DTABLE in x:
            keys = x[DTABLE]
            return {k: {c: _untables(r[i]) for i, c in enumerate(keys)} for k, r in x.items() if k != DTABLE}
        return {k: _untables(v) for k, v in x.items()}
    if isinstance(x, str) and x.startswith(ESC + ESC):
        return x[1:]
    return x


def unpack(x, dictionary=None):
    """Mirror of unpack() in What's In My County's js/data.js (tables, then shared dictionary)."""
    return _untables(_unref(x, dictionary) if dictionary is not None else x)


class Wimc:
    def __init__(self, base: str, timeout: int = 30):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.manifest = None
        self._dict = None
        self._counties: dict = {}

    def _get(self, url: str):
        req = urllib.request.Request(url, headers={"User-Agent": "state-pages-build/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def open(self):
        self.manifest = self._get(self.base + "/data/manifest.json")
        return self.manifest

    def raw(self, rel: str):
        return self._get(self.base + self.manifest["base"] + rel)

    def shared(self, rel: str):
        return unpack(self.raw(rel))

    def county(self, fips: str):
        if self._dict is None:
            self._dict = self.raw("dict.json")
        if fips not in self._counties:
            self._counties[fips] = unpack(self.raw(f"c/{fips}.json"), self._dict)
        return self._counties[fips]


# ------------------------------------------------------------------ helpers

def slug(legislator_id: str) -> str:
    """Same rule as crawler/crawler/records.py _slug(): the /record/<slug> address."""
    s = re.sub(r"[^a-z0-9-]+", "-", (legislator_id or "").lower())
    return re.sub(r"-+", "-", s).strip("-")


def clean(s):
    """House rule: no em-dashes in published text, including text passed through from sources."""
    if isinstance(s, str):
        return s.replace("—", ", ").replace("  ", " ")
    return s


def write(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")


def district_key(d: str):
    m = re.search(r"\d+", d or "")
    return (0, int(m.group()), d) if m else (1, 0, d or "")


# ------------------------------------------------------------------ people (legislators.json)

def build_people(repo: Path) -> dict:
    doc = json.loads((repo / "data/legislators.json").read_text())
    score_doc = json.loads((repo / "data/scorecard.json").read_text())
    scores = {r["slug"]: r for r in score_doc["legislators"]}
    out = {c: {"state": c, "name": n, "generated_at": doc.get("generated_at", ""),
               "scorecard_generated_at": score_doc.get("generated_at", ""),
               "source": "data/legislators.json (Open States, state legislature sites, congress-legislators)",
               "congress": [], "legislature": []} for c, n in STATE_NAMES.items()}
    skipped = {}
    # A record page belongs to exactly one person. Where two legislators share a slug (same
    # surname and district) the link and act counts are dropped for both, never guessed.
    seen: dict[str, int] = {}
    for l in doc["legislators"]:
        seen[slug(l.get("legislator_id", ""))] = seen.get(slug(l.get("legislator_id", "")), 0) + 1
    unlinked = []
    for l in doc["legislators"]:
        st = l.get("state")
        if st not in out:
            skipped[st] = skipped.get(st, 0) + 1
            continue
        c = l.get("contact") or {}
        sl = slug(l.get("legislator_id", ""))
        sc = scores.get(sl)
        if sc and (seen[sl] > 1 or sc.get("name") != l.get("name")):
            unlinked.append(l.get("legislator_id", ""))
            sc = None
        row = {
            "name": clean(l.get("name", "")),
            "party": (scores.get(sl) or {}).get("party") or l.get("party", ""),
            "office": l.get("office", ""),
            "chamber": l.get("chamber", ""),
            "district": l.get("district", ""),
        }
        for k in ("phone", "email", "contact_form", "website"):
            v = (c.get(k) or "").strip()
            if v and (k in ("phone", "email") or v.startswith("https://") or v.startswith("http://")):
                row[k] = v
        if sc:  # link and counts only where a record page exists
            row["slug"] = sl
            row["pro_acts"] = sc.get("pro_acts", 0)
            row["anti_acts"] = sc.get("anti_acts", 0)
        out[st]["congress" if l.get("level") == "Federal" else "legislature"].append(row)
    for st in out.values():
        st["congress"].sort(key=lambda r: (0 if r["chamber"] == "Senate" else 1, district_key(r["district"]), r["name"]))
        st["legislature"].sort(key=lambda r: (r["chamber"] != "Senate", r["chamber"], district_key(r["district"]), r["name"]))
    return {"states": out, "skipped": skipped, "unlinked": unlinked}


# ------------------------------------------------------------------ health (What's In My County)

def build_health(w: Wimc, log) -> dict:
    """Return {state: health doc}. Raises only if the manifest or county list cannot be read."""
    man = w.open()
    counties = w.shared("counties.json")
    try:
        feeds = {f["id"]: f for f in w.shared("feeds.json")["feeds"]}
    except Exception as e:  # credits are then omitted, figures still carry feed ids
        log(f"feeds.json unavailable: {e}")
        feeds = {}

    by_state: dict[str, list] = {}
    for c in counties:
        by_state.setdefault(c["state"], []).append(c)

    measures = {}
    for key in MEASURES:
        try:
            m = w.shared(f"metric/{key}.json")
            if m.get("basis") not in COUNTY_BASES:
                raise ValueError(f"basis {m.get('basis')!r} is not a county value")
            measures[key] = m
        except Exception as e:
            log(f"measure {key} unavailable: {e}")
            measures[key] = None

    fetched = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out = {}
    for st, name in STATE_NAMES.items():
        rows = sorted(by_state.get(st, []), key=lambda c: c["fips"])
        doc = {
            "state": st, "name": name, "credit": CREDIT,
            "source": {"name": WIMC_NAME, "publisher": WIMC_PUBLISHER, "site": WIMC_BASE,
                       "data_version": man.get("version", ""), "built": man.get("built", ""), "fetched": fetched},
            "counties_total": len(rows),
            "population": sum(c.get("population") or 0 for c in rows),
            "measures": {}, "feeds": {},
        }
        used_feeds = set()
        fips_set = {c["fips"] for c in rows}
        values = {c["fips"]: {} for c in rows}
        for key in MEASURES:
            m = measures[key]
            if m is None:
                doc["measures"][key] = {"available": False}
                continue
            meta = m["metric"]
            vals = {f: v for f, v in m["values"].items() if f in fips_set}
            texts = m.get("value_text") or {}
            classes = {}
            if (m.get("legend") or {}).get("type") == "categorical":
                classes = {str(int(c["value"])): c["label"] for c in m["legend"]["classes"] if c.get("value") is not None}
            for f, v in vals.items():
                if v is None:
                    t = texts.get(f)
                    if t:
                        values[f][key] = {"t": clean(t)}  # reported, but no value (e.g. insufficient data)
                else:
                    values[f][key] = v
            feed_id = meta.get("feed") or (m.get("feed") or {}).get("id") or ""
            if feed_id:
                used_feeds.add(feed_id)
            doc["measures"][key] = {
                "available": True, "label": clean(meta.get("label", key)), "about": clean(meta.get("about", "")),
                "unit": meta.get("unit", ""), "kind": meta.get("kind", ""), "period": m.get("period", ""),
                "basis": clean(m.get("basis_label", "")), "feed": feed_id, "classes": classes,
                "no_data": clean(m.get("no_data_label") or "no data"),
                # The source's own map classes, so the state map bins values exactly as it does.
                "legend": {"type": (m.get("legend") or {}).get("type", ""),
                           "classes": [{"label": clean(c.get("label", "")), "tone": c.get("tone"), "value": c.get("value"),
                                        "min": c.get("min"), "max": c.get("max")} for c in (m.get("legend") or {}).get("classes", [])]},
                "n_counties": sum(1 for v in vals.values() if v is not None),
            }
        doc["counties"] = [{"fips": c["fips"], "name": clean(c["name"]), "population": c.get("population"),
                            "v": values[c["fips"]]} for c in rows]

        # State-level figures: read from two counties of the state and kept only if they agree,
        # so a county value can never be mistaken for a state value.
        ctx = {"available": False, "items": []}
        try:
            first = w.county(rows[0]["fips"])["county"]["state_context"]
            items = [{"metric": i["metric"], "label": clean(i["label"]), "about": clean(i.get("about", "")),
                      "value": i.get("value"), "unit": i.get("unit", ""), "display": clean(i.get("display", "")), "status": i.get("status", ""),
                      "period": i.get("period_start", ""), "quality": clean(i.get("quality") or ""),
                      "feed": i.get("feed_id", "")} for i in first]
            if len(rows) > 1:
                other = w.county(rows[-1]["fips"])["county"]["state_context"]
                sig = lambda xs: sorted((i["metric"], i.get("value"), i.get("period_start")) for i in xs)
                if sig(first) != sig(other):
                    raise ValueError(f"{rows[0]['fips']} and {rows[-1]['fips']} disagree")
            ctx = {"available": True, "items": items, "read_from": [rows[0]["fips"], rows[-1]["fips"]]}
            used_feeds.update(i["feed"] for i in items if i["feed"])
        except Exception as e:
            log(f"{st} state-level figures unavailable: {e}")
            ctx["reason"] = "not available in this snapshot"
        doc["state_context"] = ctx

        for fid in sorted(used_feeds):
            f = feeds.get(fid)
            if f:
                doc["feeds"][fid] = {"publisher": clean(f.get("publisher", "")), "title": clean(f.get("title", "")),
                                     "url": f.get("url", ""), "license": clean(f.get("license") or ""),
                                     "credit": clean(f.get("credit") or "")}
        out[st] = doc

    # Where each state sits among the 50 states and DC on each state-level figure. This is a
    # comparison of state values with state values; the "middle" is the median state, not a
    # national figure. Only percentages and rates are compared: raw case counts would mostly
    # rank states by population, so they are shown as a number with no comparison.
    by_metric: dict[str, list] = {}
    for doc in out.values():
        for i in doc["state_context"].get("items", []):
            if i["status"] == "ok" and isinstance(i["value"], (int, float)) and i["unit"] != "cases":
                by_metric.setdefault(i["metric"], []).append((i["period"], i["value"]))
    for doc in out.values():
        cmp = {}
        for i in doc["state_context"].get("items", []):
            vals = sorted(v for p, v in by_metric.get(i["metric"], []) if p == i["period"])
            if len(vals) >= 10:
                cmp[i["metric"]] = {"n": len(vals), "median": round(statistics.median(vals), 4), "values": vals}
        doc["state_compare"] = cmp

    # Weekly measles cases: county weekly counts added up by state. Only counties with at least
    # one case this year are read (the rest add zero), so this is a few hundred requests. A failed
    # request or a sum that does not match only marks that one state unavailable.
    def county_weeks(fips):
        try:
            m = w.county(fips).get("series", {}).get("measles")
            if not m or m.get("geo_level") != "county" or not m.get("series"):
                return None
            return (m.get("feed") or {}).get("id", ""), [(x["week"], x["cases"]) for x in m["series"][0]["weeks"]]
        except Exception:
            return None

    need = {st: [c["fips"] for c in doc["counties"] if isinstance(c["v"].get("measles_cases_ytd"), (int, float)) and c["v"]["measles_cases_ytd"] >= 1]
            for st, doc in out.items() if doc["measures"].get("measles_cases_ytd", {}).get("available")}
    try:
        first = next((f for fs in need.values() for f in fs), None)
        if first:
            w.county(first)  # loads the shared dictionary once, before the threads
    except Exception:
        pass
    with ThreadPoolExecutor(8) as pool:
        got = dict(zip([f for fs in need.values() for f in fs], pool.map(county_weeks, [f for fs in need.values() for f in fs])))
    for st, doc in out.items():
        m = doc["measures"].get("measles_cases_ytd", {})
        if not m.get("available"):
            doc["measles_weekly"] = {"available": False, "reason": "not available in this snapshot"}
            continue
        if not m.get("n_counties"):
            doc["measles_weekly"] = {"available": False, "reason": "no county in this state has a published count"}
            continue
        ytd = int(sum(c["v"]["measles_cases_ytd"] for c in doc["counties"] if isinstance(c["v"].get("measles_cases_ytd"), (int, float))))
        weekly: dict[str, int] = {}
        feed, bad = m.get("feed", ""), False
        for f in need.get(st, []):
            if got.get(f) is None:
                bad = True
                break
            feed = got[f][0] or feed
            for wk, n in got[f][1]:
                weekly[wk] = weekly.get(wk, 0) + n
        if bad or sum(weekly.values()) != ytd:
            log(f"{st}: weekly measles series unavailable (a county file failed or the weeks do not add up)")
            doc["measles_weekly"] = {"available": False, "reason": "not available in this snapshot"}
            continue
        doc["measles_weekly"] = {"available": True, "feed": feed, "period": m.get("period", ""), "counties_reporting": m["n_counties"],
                                 "total": ytd, "weeks": [{"week": k, "cases": n} for k, n in sorted(weekly.items())]}
    return out


# ------------------------------------------------------------------ county shapes

def _albers(lon0, lat0, lat1, lat2):
    """Albers equal-area conic, fitted per state so shapes are not stretched."""
    r = math.radians
    n = (math.sin(r(lat1)) + math.sin(r(lat2))) / 2
    c = math.cos(r(lat1)) ** 2 + 2 * n * math.sin(r(lat1))
    rho0 = math.sqrt(c - 2 * n * math.sin(r(lat0))) / n

    def proj(lon, lat):
        rho = math.sqrt(max(c - 2 * n * math.sin(r(lat)), 0)) / n
        th = n * r(lon - lon0)
        return rho * math.sin(th), rho0 - rho * math.cos(th)
    return proj


def build_geo(w: Wimc, width: int = 800) -> dict:
    """Return {state: {"w","h","paths":{fips: svg path}}} from the source's county boundaries."""
    topo = w.raw("topo.json")
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for a in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in a:
            x += dx; y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        out = []
        for i in idx:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts if not out else pts[1:])
        return out

    by_state: dict[str, dict] = {}
    for g in next(iter(topo["objects"].values()))["geometries"]:
        st = (g.get("properties") or {}).get("s")
        if st not in STATE_NAMES or not g.get("arcs"):
            continue
        polys = [g["arcs"]] if g["type"] == "Polygon" else g["arcs"]
        rings = [ring(r) for poly in polys for r in poly]
        if st == "AK":   # the Aleutians cross the 180th meridian
            rings = [[(lon - 360 if lon > 0 else lon, lat) for lon, lat in r] for r in rings]
        if st == "HI":   # leave out the uninhabited Northwestern Hawaiian Islands so the map is readable
            rings = [r for r in rings if max(lon for lon, _ in r) > -161] or rings
        by_state.setdefault(st, {})[g["id"]] = rings

    out = {}
    for st, counties in by_state.items():
        lons = [lon for rs in counties.values() for r in rs for lon, _ in r]
        lats = [lat for rs in counties.values() for r in rs for _, lat in r]
        la0, la1 = min(lats), max(lats)
        proj = _albers((min(lons) + max(lons)) / 2, (la0 + la1) / 2, la0 + (la1 - la0) / 6, la1 - (la1 - la0) / 6)
        pr = {f: [[proj(lon, lat) for lon, lat in r] for r in rs] for f, rs in counties.items()}
        xs = [x for rs in pr.values() for r in rs for x, _ in r]
        ys = [y for rs in pr.values() for r in rs for _, y in r]
        k = width / (max(xs) - min(xs))
        h = (max(ys) - min(ys)) * k
        if h > width * 1.15:           # tall states: fit the height instead
            k *= width * 1.15 / h
            h = width * 1.15
        x0, y1 = min(xs), max(ys)
        paths = {}
        for f, rs in pr.items():
            parts = []
            for r in rs:
                pts = []
                for x, y in r:
                    q = (round((x - x0) * k, 1), round((y1 - y) * k, 1))
                    if not pts or q != pts[-1]:
                        pts.append(q)
                if len(pts) >= 4:
                    parts.append("M" + " ".join(f"{a:g} {b:g}" for a, b in pts[:-1]) + "Z")
            if parts:
                paths[f] = "".join(parts)
        out[st] = {"state": st, "w": round((max(xs) - min(xs)) * k, 1), "h": round(h, 1), "paths": paths,
                   "source": "County boundaries from What's In My County (United States Census Bureau cartographic boundaries)."}
    return out


def health_summary(doc: dict) -> dict:
    """The few per-state numbers the /states index shows. Each is one measure, never a blend."""
    def has(key):  # the measure loaded and at least one county of this state has a value
        m = doc["measures"].get(key, {})
        return bool(m.get("available") and m.get("n_counties"))

    def count(key, test, zero_ok=False):
        if not (has(key) or (zero_ok and doc["measures"].get(key, {}).get("available"))):
            return None  # no county has a value: "no data", never 0
        return sum(1 for c in doc["counties"] if test(c["v"].get(key)))

    def total(key):
        if not has(key):
            return None
        return int(sum(v for c in doc["counties"] if isinstance((v := c["v"].get(key)), (int, float))))
    num = lambda v: isinstance(v, (int, float))
    return {
        "counties_total": doc["counties_total"],
        # A county is in the sites measure only if it has a site, so no rows means zero counties.
        "ww_covid_counties": count("ww_covid_n_sites", lambda v: num(v) and v >= 1, zero_ok=True),
        "ww_covid_high_counties": count("ww_covid_wval_level_max", lambda v: num(v) and v >= 4),
        "ww_covid_level_counties": doc["measures"].get("ww_covid_wval_level_max", {}).get("n_counties"),
        "measles_ytd_county_sum": total("measles_cases_ytd"),
        "measles_ytd_counties_reporting": doc["measures"].get("measles_cases_ytd", {}).get("n_counties"),
        "measles_4wk_counties": count("measles_cases_4wk", lambda v: num(v) and v >= 1),
        "periods": {k: doc["measures"][k].get("period", "") for k in
                    ("ww_covid_n_sites", "ww_covid_wval_level_max", "measles_cases_ytd", "measles_cases_4wk")
                    if doc["measures"].get(k, {}).get("available")},
        "data_version": doc["source"]["data_version"],
    }


# ------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--skip-health", action="store_true", help="people files only, no network")
    ap.add_argument("--health-only", action="store_true")
    ap.add_argument("--base", default=WIMC_BASE)
    args = ap.parse_args()
    repo = Path(args.repo).resolve()
    out_dir = repo / "data/states"
    out_dir.mkdir(parents=True, exist_ok=True)
    log = lambda msg: print("  warn:", msg, file=sys.stderr)

    people_n = {}
    if not args.health_only:
        people = build_people(repo)
        for st, doc in people["states"].items():
            write(out_dir / f"{st.lower()}.json", doc)
            people_n[st] = {"congress": len(doc["congress"]), "legislature": len(doc["legislature"])}
        print(f"people: {len(people['states'])} state files; not given a page: {people['skipped']}; "
              f"record link withheld (slug shared by two people): {people['unlinked']}")

    health_note = "skipped"
    if not args.skip_health:
        try:
            w = Wimc(args.base)
            health = build_health(w, log)
            try:   # the map shapes are a separate file, so a page still works without them
                for st, g in build_geo(w).items():
                    if set(g["paths"]) == {c["fips"] for c in health[st]["counties"]}:
                        write(out_dir / f"{st.lower()}.geo.json", g)
                    else:
                        log(f"{st}: county shapes do not match the county list; map file not written")
            except Exception as e:
                log(f"county shapes unavailable: {e}")
            for st, doc in health.items():
                write(out_dir / f"{st.lower()}.health.json", doc)
            health_note = f"{len(health)} state files, data version {next(iter(health.values()))['source']['data_version']}"
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as e:
            health_note = f"NOT refreshed ({e}); existing files kept"
    print("health:", health_note)

    # Index: built from what is on disk, so a failed refresh still lists the last good snapshot.
    index = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
             "credit": CREDIT, "site": args.base, "states": {}}
    for st, name in STATE_NAMES.items():
        row = {"name": name}
        p = out_dir / f"{st.lower()}.json"
        if p.exists():
            d = json.loads(p.read_text())
            row["congress"] = len(d["congress"])
            row["legislature"] = len(d["legislature"])
        h = out_dir / f"{st.lower()}.health.json"
        row["health"] = health_summary(json.loads(h.read_text())) if h.exists() else None
        index["states"][st] = row
    write(out_dir / "index.json", index)
    print(f"index: {len(index['states'])} states")
    return 0


if __name__ == "__main__":
    sys.exit(main())
