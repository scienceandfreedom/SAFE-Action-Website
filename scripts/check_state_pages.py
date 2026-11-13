#!/usr/bin/env python3
"""Check the state pages (/ca, /tx ... and /states) for all 50 states and the District of Columbia.

Part 1, data (standard library, always runs): the generated files under data/states/ agree with
their sources (data/live.json, data/legislators.json, data/scorecard.json), every public health
figure has a source and a period, county and state values are kept apart, and no published text
contains an em-dash.

Part 2, render (--render, needs the Python `playwright` package with Chromium): starts
dev-server.js, opens every state page and the index in a real browser, and checks what is on the
page against the data. It then blocks the public health file to prove each page still works when
What's In My County data is missing, and removes one measure to prove the page says so.

Usage: python3 scripts/check_state_pages.py [--repo .] [--render]
Exit status is 0 only if every check passes.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_state_data import COUNTY_BASES, CREDIT, MEASURES, STATE_NAMES, health_summary, slug  # noqa: E402

EM_DASH = "—"
FAILS: list[str] = []
CHECKS = 0


def check(ok: bool, msg: str) -> bool:
    global CHECKS
    CHECKS += 1
    if not ok:
        FAILS.append(msg)
    return ok


# ------------------------------------------------------------------ part 1: data

def data_checks(repo: Path) -> None:
    live = json.loads((repo / "data/live.json").read_text())
    legs = json.loads((repo / "data/legislators.json").read_text())["legislators"]
    slugs = {r["slug"] for r in json.loads((repo / "data/scorecard.json").read_text())["legislators"]}
    record_slugs = {r["slug"] for r in json.loads((repo / "data/records.json").read_text())["legislators"]}
    score_names = {r["slug"]: r["name"] for r in json.loads((repo / "data/scorecard.json").read_text())["legislators"]}
    shared = {}
    for l in legs:
        shared[slug(l["legislator_id"])] = shared.get(slug(l["legislator_id"]), 0) + 1
    index = json.loads((repo / "data/states/index.json").read_text())
    check(sorted(index["states"]) == sorted(STATE_NAMES), "index.json does not list exactly the 50 states and DC")
    check(index.get("credit") == CREDIT, "index.json credit line is wrong")

    fb = json.loads((repo / "firebase.json").read_text())
    rx = next(r["regex"] for r in fb["hosting"]["rewrites"] if r.get("destination") == "/state.html")
    rx = re.compile(rx.replace("(?i:", "(?:"), re.I)
    sitemap = (repo / "sitemap.xml").read_text()

    for st, name in STATE_NAMES.items():
        lo = st.lower()
        check(bool(rx.match("/" + lo)), f"{st}: firebase.json rewrite does not serve /{lo}")
        check(f"<loc>https://scienceandfreedom.com/{lo}</loc>" in sitemap, f"{st}: not in sitemap.xml")

        # bills: the page reads live.json; its headline counts must equal the rows it lists
        ls = live["states"].get(st)
        if check(ls is not None, f"{st}: missing from live.json states"):
            bills = [b for b in live["bills"] if b["state"] == st]
            for t in ("pro", "anti"):
                check(ls[t] == sum(1 for b in bills if b["type"] == t), f"{st}: live.json {t} count does not match its bill rows")
            check(all(b["type"] in ("pro", "anti", "watch") for b in bills), f"{st}: a bill has an unknown label")

        # people
        p = repo / f"data/states/{lo}.json"
        if check(p.exists(), f"{st}: people file missing"):
            d = json.loads(p.read_text())
            src = [l for l in legs if l.get("state") == st]
            check(len(d["congress"]) == sum(1 for l in src if l["level"] == "Federal"), f"{st}: members of Congress count differs from legislators.json")
            check(len(d["legislature"]) == sum(1 for l in src if l["level"] != "Federal"), f"{st}: state legislator count differs from legislators.json")
            check(len(d["congress"]) >= 1, f"{st}: no members of Congress")
            for r in d["congress"] + d["legislature"]:
                if "slug" in r:
                    check(r["slug"] in slugs, f"{st}: record link {r['slug']} has no scorecard row")
                    check(r["slug"] in record_slugs, f"{st}: record link {r['slug']} has no record page")
                    check(shared[r["slug"]] == 1, f"{st}: record link {r['slug']} is shared by two legislators")
                    check(score_names[r["slug"]] == r["name"], f"{st}: {r['name']} is linked to the record of {score_names[r['slug']]}")
                else:
                    check("pro_acts" not in r and "anti_acts" not in r, f"{st}: {r['name']} has act counts without a record link")
                for k in ("website", "contact_form"):
                    if k in r:
                        check(r[k].startswith(("https://", "http://")), f"{st}: {r['name']} {k} is not a web address")
            want = {slug(l["legislator_id"]) for l in src if shared[slug(l["legislator_id"])] == 1} & slugs
            check({r["slug"] for r in d["congress"] + d["legislature"] if "slug" in r} == want, f"{st}: record links differ from scorecard matches")

        # health
        h = repo / f"data/states/{lo}.health.json"
        if not check(h.exists(), f"{st}: public health file missing (page will say unavailable)"):
            continue
        d = json.loads(h.read_text())
        check(d.get("credit") == CREDIT, f"{st}: credit line missing or changed")
        check(bool(d["source"].get("data_version")) and d["source"].get("site", "").startswith("https://"), f"{st}: snapshot version or site address missing")
        check(d["counties_total"] == len(d["counties"]) and d["counties_total"] >= 1, f"{st}: county count does not match county rows")
        check(len({c["fips"][:2] for c in d["counties"]}) == 1, f"{st}: county rows span more than one state code")
        check(len({c["fips"] for c in d["counties"]}) == len(d["counties"]), f"{st}: duplicate county")
        check(sorted(d["measures"]) == sorted(MEASURES), f"{st}: measure list differs from the builder's")
        bases = {"published for the county", "counted from sites in the county", "modeled estimate"}
        for k, m in d["measures"].items():
            if not m.get("available"):
                continue
            check(bool(m.get("period")), f"{st}: measure {k} has no period")
            check(bool(m.get("feed")) and m["feed"] in d["feeds"] and bool(d["feeds"][m["feed"]].get("publisher")), f"{st}: measure {k} has no named source")
            check(m.get("basis") in bases, f"{st}: measure {k} basis {m.get('basis')!r} is not a county value")
            n = sum(1 for c in d["counties"] if isinstance(c["v"].get(k), (int, float)))
            check(n == m["n_counties"], f"{st}: measure {k} n_counties does not match rows")
        for c in d["counties"]:
            check(set(c["v"]) <= set(MEASURES), f"{st}: {c['name']} carries a value outside the measure list")
        ctx = d["state_context"]
        if check(ctx.get("available") is True, f"{st}: state-level figures unavailable"):
            for i in ctx["items"]:
                check(bool(i.get("period")) and i.get("feed") in d["feeds"], f"{st}: state figure {i['metric']} lacks a period or source")
                check("(state)" in i["label"], f"{st}: state figure {i['metric']} is not labeled as state level")
                check(i["metric"] not in MEASURES, f"{st}: {i['metric']} appears as both a state and a county measure")
        check(index["states"][st].get("health") == health_summary(d), f"{st}: index.json health row does not match the state file")
        # every mapped value falls in one of the source's classes, so no value is drawn as "no data"
        for k, m in d["measures"].items():
            if not m.get("available"):
                continue
            classes = m["legend"]["classes"]
            check(len(classes) >= 2 and all(c.get("tone") in (1, 2, 3, 4, 5) for c in classes), f"{st}: measure {k} has no usable map classes")
            for c in d["counties"]:
                v = c["v"].get(k)
                if isinstance(v, (int, float)) and not k.endswith(("_n_sites", "_trend_4wk", "_ca_high")):
                    hit = any(x["value"] == v for x in classes if x["value"] is not None) or any(
                        not (x["value"] is not None and x["min"] is None and x["max"] is None)
                        and (x["min"] is None or v >= x["min"]) and (x["max"] is None or v < x["max"]) for x in classes)
                    check(hit, f"{st}: {c['name']} {k}={v} fits no map class")
        g = repo / f"data/states/{lo}.geo.json"
        if check(g.exists(), f"{st}: map file missing (page will say the map is unavailable)"):
            geo = json.loads(g.read_text())
            check(set(geo["paths"]) == {c["fips"] for c in d["counties"]}, f"{st}: map shapes do not match the county list")
            check(geo["w"] > 0 and geo["h"] > 0 and all(p.startswith("M") and p.endswith("Z") for p in geo["paths"].values()), f"{st}: malformed map shapes")
        w = d["measles_weekly"]
        if w.get("available"):
            ytd = sum(c["v"]["measles_cases_ytd"] for c in d["counties"] if isinstance(c["v"].get("measles_cases_ytd"), (int, float)))
            check(w["total"] == ytd and sum(x["cases"] for x in w["weeks"]) in (ytd, 0) and w["counties_reporting"] == d["measures"]["measles_cases_ytd"]["n_counties"],
                  f"{st}: weekly measles cases do not add up to the county year-to-date sum")
        else:
            check(not d["measures"]["measles_cases_ytd"].get("n_counties"), f"{st}: weekly measles series missing although counties report counts")
        for i in ctx.get("items", []):
            c = d["state_compare"].get(i["metric"])
            if c and i["status"] == "ok":
                check(i["value"] in c["values"] and c["values"] == sorted(c["values"]) and c["values"][0] <= c["median"] <= c["values"][-1], f"{st}: state comparison for {i['metric']} is inconsistent")
        check(index["states"][st].get("congress") == len(json.loads(p.read_text())["congress"]) if p.exists() else False, f"{st}: index.json people count is stale")

    check(len(COUNTY_BASES) == 3, "county bases changed")

    # territories get no page and no data file
    for t in ("pr", "gu", "vi", "as", "mp"):
        check(not (repo / f"data/states/{t}.json").exists(), f"territory file {t}.json should not exist")

    # house rules on everything this feature publishes
    published = [repo / "state.html", repo / "states.html", repo / "js/state.js", repo / "js/states.js", repo / "css/states.css"]
    published += sorted((repo / "data/states").glob("*.json"))
    check("whatsinmycounty.priori-intelligence.workers.dev" not in "".join(f.read_text() for f in published), "a published file still points at the preview host")
    for f in published:
        check(EM_DASH not in f.read_text(), f"{f.relative_to(repo)}: contains an em-dash")
    for f in (repo / "js/state.js", repo / "js/states.js"):
        js = f.read_text()
        check(not re.search(r"""(fetch|getJSON)\(\s*['"]https?:""", js), f"{f.name}: fetches another origin")
        check("XMLHttpRequest" not in js and "import(" not in js, f"{f.name}: unexpected loader")
    for f in (repo / "state.html", repo / "states.html"):
        html = f.read_text()
        check(not re.search(r"""<(script|link)[^>]+(src|href)=["']https?://(?!scienceandfreedom\.com)""", html), f"{f.name}: loads a file from another origin")


# ------------------------------------------------------------------ part 2: render

def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def render_checks(repo: Path) -> None:
    from playwright.sync_api import sync_playwright

    live = json.loads((repo / "data/live.json").read_text())
    port = free_port()
    server = subprocess.Popen(["node", "dev-server.js"], cwd=repo, env={**os.environ, "PORT": str(port)},
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://localhost:{port}"
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(service_workers="block")  # sw.js would answer blocked files from its cache
            page = ctx.new_page()
            errors: list[str] = []
            offsite: list[str] = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("request", lambda r: offsite.append(r.url) if not r.url.startswith(base) and not r.url.startswith("data:") else None)

            def settle(what: str):
                page.wait_for_function(
                    "() => !['st-rows','st-health','st-people'].some(id => { const e = document.getElementById(id); return e && /Loading\\.\\.\\./.test(e.textContent); })",
                    timeout=15000)
                check(not errors, f"{what}: console errors {errors[:2]}")
                check(not offsite, f"{what}: requested another origin {offsite[:2]}")
                errors.clear(); offsite.clear()

            # ---- index
            page.goto(base + "/states")
            page.wait_for_function("() => document.querySelectorAll('#ss-rows tr').length >= 51", timeout=15000)
            check(not errors and not offsite, f"/states: console errors or off-site requests {errors[:2]} {offsite[:2]}")
            errors.clear(); offsite.clear()
            rows = page.eval_on_selector_all("#ss-rows tr", "rs => rs.map(r => [r.cells[0].querySelector('a').getAttribute('href'), r.cells[1].textContent, r.cells[2].textContent, r.cells[7].textContent])")
            check(len(rows) == 51, f"/states: {len(rows)} rows, expected 51")
            by_href = {r[0]: r for r in rows}
            for st in STATE_NAMES:
                r = by_href.get("/" + st.lower())
                if check(r is not None, f"/states: no row linking to /{st.lower()}"):
                    hs = json.loads((repo / f"data/states/{st.lower()}.health.json").read_text())
                    if not hs["measures"]["measles_cases_ytd"].get("n_counties"):
                        check(r[3] == "no data", f"/states: {st} has no county measles counts but shows {r[3]!r}")
                    check(r[1] == str(live["states"][st]["pro"]) and r[2] == str(live["states"][st]["anti"]), f"/states: {st} bill counts differ from live.json")
            body = page.inner_text("body")
            check(CREDIT in body, "/states: credit line missing")
            check(EM_DASH not in body, "/states: em-dash on page")

            # ---- every state page
            for st, name in STATE_NAMES.items():
                lo = st.lower()
                H = json.loads((repo / f"data/states/{lo}.health.json").read_text())
                P = json.loads((repo / f"data/states/{lo}.json").read_text())
                page.goto(f"{base}/{lo}")
                settle(f"/{lo}")
                N = H["counties_total"]
                check(page.inner_text("#st-name") == name, f"/{lo}: heading is not {name}")
                check(page.inner_text("#st-pro") == str(live["states"][st]["pro"]) and page.inner_text("#st-anti") == str(live["states"][st]["anti"]), f"/{lo}: headline bill counts differ from live.json")
                sb = [b for b in live["bills"] if b["state"] == st]
                nb = len(sb)
                bill_rows = page.locator("#st-rows tr").count()
                if nb:
                    check(bill_rows == nb, f"/{lo}: {bill_rows} bill rows, expected {nb}")
                    split = page.eval_on_selector_all("#st-billviz .st-split div", "ds => ds.map(d => [d.className, d.textContent])")
                    want = [[t, str(sum(1 for b in sb if b["type"] == t))] for t in ("pro", "anti", "watch") if any(b["type"] == t for b in sb)]
                    check(split == want, f"/{lo}: bill split bar {split} differs from {want}")
                    stage = page.eval_on_selector_all("#st-billviz .st-stage .tr span", "ss => ss.map(s => s.textContent)")
                    tot = sum(int(n) for t in stage for n in re.findall(r"(\d+) (?:pro|anti)", t))
                    check(len(stage) == 6 and tot == sum(1 for b in sb if b["type"] in ("pro", "anti")), f"/{lo}: stage chart does not add up to the classified bills")
                else:
                    check("no pro-science or anti-science bills on file" in page.inner_text("#st-billviz") and bill_rows == 0,
                          f"/{lo}: no plain statement that there are no classified bills")
                check(page.locator("#st-ctable tbody tr").count() == N, f"/{lo}: county table rows differ from county count")
                links = page.eval_on_selector_all("#st-ctable tbody tr td:first-child a", "as => as.map(a => a.href)")
                check(len(links) == N and all(re.fullmatch(re.escape(H["source"]["site"]) + r"/county/\d{5}", u) for u in links), f"/{lo}: county links are not What's In My County county pages")
                check(page.locator("#st-cong tbody tr").count() == len(P["congress"]), f"/{lo}: members of Congress rows differ")
                if P["legislature"]:
                    check(page.locator("#st-leg tbody tr").count() == len(P["legislature"]), f"/{lo}: state legislator rows differ")
                health = page.text_content("#st-health")   # includes the collapsed table and sources
                check(health.count(CREDIT) >= 1, f"/{lo}: credit line missing")
                check("not medical advice" in health, f"/{lo}: public data notice missing")
                check("Statewide values, never county values" in health, f"/{lo}: state figures are not labeled as statewide")
                for m in H["measures"].values():
                    if m.get("available") and m["n_counties"]:
                        check(m["period"] in health, f"/{lo}: period {m['period']} of {m['label']} not shown")
                # tiles: 4 to 6, each with a source line
                tiles = page.eval_on_selector_all("#st-health .st-tile", "ts => ts.map(t => [t.querySelector('.n').textContent, t.querySelector('.s').textContent, t.querySelector('.scope').textContent])")
                check(4 <= len(tiles) <= 6 and all(t[1].strip() for t in tiles), f"/{lo}: expected 4 to 6 headline tiles with sources, got {len(tiles)}")
                # the map: one shape per county; a county without a value is hatched, never colored
                check(page.locator("#st-map path").count() == N, f"/{lo}: map does not have one shape per county")
                opts = page.eval_on_selector_all("#st-msel option", "os => os.map(o => o.value)")
                check(len(opts) >= 1, f"/{lo}: map has no measure to show")
                for k in opts:
                    page.select_option("#st-msel", k)
                    fills = page.eval_on_selector_all("#st-map path", "ps => ps.map(p => p.getAttribute('fill'))")
                    hatched = sum(1 for f in fills if f == "url(#st-hatch)")
                    check(all(fills) and hatched == N - H["measures"][k]["n_counties"], f"/{lo}: map of {k} hatches {hatched} counties, expected {N - H['measures'][k]['n_counties']}")
                    check(H["measures"][k]["period"] in page.inner_text("#st-mapsrc") and "Source:" in page.inner_text("#st-mapsrc"), f"/{lo}: map of {k} lacks its source and period")
                page.dispatch_event("#st-map path", "click")
                pick = page.eval_on_selector("#st-pick a", "a => a.href")
                check(bool(re.fullmatch(re.escape(H["source"]["site"]) + r"/county/\d{5}", pick)), f"/{lo}: selecting a county does not link to its What's In My County page")
                # weekly measles: bars only where the source has county counts
                W = H["measles_weekly"]
                bars = page.locator("#st-weekly rect.bar").count()
                if W.get("available") and W["total"] > 0:
                    check(bars == sum(1 for w in W["weeks"] if w["cases"] > 0), f"/{lo}: weekly measles bars differ from the data")
                else:
                    check(bars == 0, f"/{lo}: weekly measles chart drawn without data")
                    if not W.get("available"):
                        check("This is missing data, not a count of zero" in health, f"/{lo}: missing weekly measles data is not stated as missing")
                if not H["measures"]["measles_cases_ytd"].get("n_counties"):
                    check(sum(1 for t in tiles if t[0] == "no data") >= 2, f"/{lo}: measles tiles should read no data")
                check(page.locator("#st-health .st-strip").count() == len(H["state_context"]["items"]), f"/{lo}: statewide rows differ from the data")
                body = page.inner_text("body")
                check(EM_DASH not in body and EM_DASH not in health, f"/{lo}: em-dash on page")
                # acronyms: the spelled-out form comes before the first bare use in the health section
                for short, full in (("RSV", "respiratory syncytial virus"), ("MMR", "measles, mumps and rubella"), ("CDC", "Centers for Disease Control and Prevention"), ("EPA", "Environmental Protection Agency")):
                    if short in health:
                        check(full.lower() in health.lower() and health.lower().index(full.lower()) < health.index(short) + 60, f"/{lo}: {short} used before it is spelled out")

            # ---- sorting works (one page)
            page.goto(base + "/ca"); settle("/ca sort")
            page.click("#counties > summary")
            page.click("#st-ctable thead th:nth-child(2) button"); page.click("#st-ctable thead th:nth-child(2) button")
            check(page.inner_text("#st-ctable tbody tr:first-child td:first-child") == "Los Angeles County", "/ca: sorting by population (largest first) does not put Los Angeles County first")
            page.fill("#st-cq", "san d")
            check(page.locator("#st-ctable tbody tr:not([hidden])").count() == 1, "/ca: county filter does not narrow to San Diego County")

            # ---- phone width: no sideways scrolling
            phone = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block").new_page()
            for lo in ("mn", "tx", "wy", "ak"):
                phone.goto(f"{base}/{lo}")
                phone.wait_for_selector("#st-map path")
                check(phone.evaluate("document.documentElement.scrollWidth") <= 390, f"/{lo}: page scrolls sideways at phone width")

            # ---- the map file alone is missing: everything else still renders
            page.route("**/data/states/*.geo.json", lambda r: r.abort())
            for lo in ("mn", "tx", "wy"):
                page.goto(f"{base}/{lo}")
                page.wait_for_selector("#st-health .st-tile")
                check("county map is unavailable right now" in page.inner_text("#st-health") and page.locator("#st-health .st-strip").count() >= 1, f"/{lo}: page does not degrade cleanly without the map file")
            errors.clear(); offsite.clear()
            page.unroute("**/data/states/*.geo.json")

            # ---- outage: the public health file cannot be loaded
            page.route("**/data/states/*.health.json", lambda r: r.abort())
            for st, name in STATE_NAMES.items():
                lo = st.lower()
                page.goto(f"{base}/{lo}")
                page.wait_for_function("() => !/Loading\\.\\.\\./.test(document.getElementById('st-people').textContent + document.getElementById('st-rows').textContent + document.getElementById('st-health').textContent)", timeout=15000)
                check("unavailable right now" in page.inner_text("#st-health"), f"/{lo} outage: page does not say the data is unavailable")
                check(page.inner_text("#st-name") == name and page.locator("#st-cong tbody tr").count() >= 1, f"/{lo} outage: bills or legislators did not render")
            errors.clear(); offsite.clear()
            page.unroute("**/data/states/*.health.json")

            # ---- outage: the index file cannot be loaded
            page.route("**/data/states/index.json", lambda r: r.abort())
            page.goto(base + "/states")
            page.wait_for_function("() => document.querySelectorAll('#ss-rows tr').length >= 51", timeout=15000)
            check("unavailable" in page.inner_text("#ss-rows") and "unavailable right now" in page.inner_text("#ss-src"), "/states outage: page does not say county figures are unavailable")
            page.unroute("**/data/states/index.json")
            errors.clear(); offsite.clear()

            # ---- one measure missing, and state-level figures missing
            def drop(route):
                d = json.loads((repo / "data/states/wy.health.json").read_text())
                d["measures"]["measles_cases_ytd"] = {"available": False}
                d["measures"]["ww_covid_wval_level_max"] = {"available": False}
                d["state_context"] = {"available": False, "items": []}
                d["measles_weekly"] = {"available": False, "reason": "not available in this snapshot"}
                for c in d["counties"]:
                    c["v"].pop("measles_cases_ytd", None); c["v"].pop("ww_covid_wval_level_max", None)
                route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
            page.route("**/data/states/wy.health.json", drop)
            page.goto(base + "/wy"); settle("/wy with measures removed")
            health = page.text_content("#st-health")
            check("State-level figures are not available in this snapshot" in health, "/wy: missing state-level figures not stated")
            check("Weekly measles counts by county are unavailable" in health, "/wy: missing weekly measles data not stated")
            gone = page.eval_on_selector_all("#st-msel option", "os => os.map(o => o.value)")
            check("measles_cases_ytd" not in gone and "ww_covid_wval_level_max" not in gone and len(gone) >= 1, "/wy: a removed measure is still offered on the map")
            check("Columns unavailable in this snapshot" in health and "COVID-19 wastewater level" in health.split("Columns unavailable in this snapshot")[1], "/wy: missing column not stated")
            check(page.locator("#st-ctable tbody tr").count() == 23, "/wy: county table did not render with a measure missing")
            browser.close()
    finally:
        server.terminate()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--render", action="store_true")
    args = ap.parse_args()
    repo = Path(args.repo).resolve()
    data_checks(repo)
    print(f"data: {CHECKS} checks, {len(FAILS)} failed")
    if args.render:
        before = CHECKS
        render_checks(repo)
        print(f"render: {CHECKS - before} checks")
    for f in FAILS:
        print("FAIL", f)
    print("PASS" if not FAILS else f"FAILED ({len(FAILS)})")
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
