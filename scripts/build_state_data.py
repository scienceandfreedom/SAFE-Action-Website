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
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# The one place the What's In My County address lives. Change it here when
# whatsinmycounty.com is pointed; the pages read it from the generated files.
WIMC_BASE = "https://whatsinmycounty.priori-intelligence.workers.dev"
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
        return unpack(self.raw(f"c/{fips}.json"), self._dict)


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
               "source": "data/legislators.json (LegiScan, Open States, congress-legislators)",
               "congress": [], "legislature": []} for c, n in STATE_NAMES.items()}
    skipped = {}
    for l in doc["legislators"]:
        st = l.get("state")
        if st not in out:
            skipped[st] = skipped.get(st, 0) + 1
            continue
        c = l.get("contact") or {}
        sl = slug(l.get("legislator_id", ""))
        sc = scores.get(sl)
        row = {
            "name": clean(l.get("name", "")),
            "party": (sc or {}).get("party") or l.get("party", ""),
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
    return {"states": out, "skipped": skipped}


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
                      "value": i.get("value"), "display": clean(i.get("display", "")), "status": i.get("status", ""),
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
        print(f"people: {len(people['states'])} state files; not given a page: {people['skipped']}")

    health_note = "skipped"
    if not args.skip_health:
        try:
            health = build_health(Wimc(args.base), log)
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
