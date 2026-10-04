#!/usr/bin/env python3
"""Build data/live.json, the compact weekly snapshot that streamer mode (/live) reads.

bills.json is ~10 MB; the presenter only needs classified (pro/anti) bills and
per-state counts. Each run also freezes data/live-history/<ISO week>.json and
diffs against the previous week so the show can say what moved.

Stance overrides from human review (data/stance-overrides.json) win over the
crawler's classification. A bill counts as "reviewed" only when an override
exists for it; the page watermarks anything unreviewed.

Usage: python3 scripts/build_live.py [--repo .]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

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
    "US": "U.S. Congress",
}

# Pipeline lanes, in order. Anything not listed maps to "introduced".
STAGE = {
    "Introduced": "introduced",
    "In Committee": "committee",
    "Passed House": "passed1", "Passed Senate": "passed1", "Passed One Chamber": "passed1",
    "Passed Both Chambers": "passed2",
    "Signed into Law": "signed",
    "Vetoed": "dead", "Died in Committee": "dead", "Failed": "dead",
}


def _sponsors(b: dict) -> list[dict]:
    out = []
    for s in b.get("sponsorships") or []:
        if isinstance(s, dict) and s.get("name"):
            out.append({k: s.get(k, "") for k in ("name", "party", "role", "district", "type")})
    return out[:6]


def _future(date: str, today: str) -> bool:
    return bool(date) and date > today


def build(repo: Path) -> dict:
    today = dt.date.today().isoformat()
    doc = json.loads((repo / "data/bills.json").read_text())
    bills = doc.get("bills", doc) if isinstance(doc, dict) else doc
    ov_path = repo / "data/stance-overrides.json"
    overrides = json.loads(ov_path.read_text()).get("overrides", {}) if ov_path.exists() else {}

    states = {code: {"name": name, "anti": 0, "pro": 0, "tracked": 0} for code, name in STATE_NAMES.items()}
    out_bills = []
    for b in bills:
        if not isinstance(b, dict) or b.get("state") not in states:
            continue
        st = states[b["state"]]
        st["tracked"] += 1
        bid = b.get("billId")
        ov = overrides.get(bid)
        bt = (ov or {}).get("billType") or b.get("billType", "monitor")
        if bt not in ("pro", "anti"):
            continue
        st[bt] += 1
        ver = b.get("verification") or {}
        last_date = b.get("lastActionDate") or ""
        out_bills.append({
            "id": bid,
            "state": b["state"],
            "number": b.get("billNumber", ""),
            "title": (b.get("title") or "").strip(),
            "summary": (b.get("summary") or "").strip()[:900],
            "type": bt,
            "category": b.get("category", ""),
            "status": b.get("status", ""),
            "stage": STAGE.get(b.get("status", ""), "introduced"),
            "lastAction": b.get("lastAction", ""),
            # Dates after today are scheduled events (hearings), not past actions.
            "lastActionDate": "" if _future(last_date, today) else last_date,
            "upcomingDate": last_date if _future(last_date, today) else "",
            "source": b.get("sourceUrl") or b.get("url") or "",
            "sponsors": _sponsors(b),
            "evidence": [e for e in (ver.get("evidence") or []) if isinstance(e, str)][:3],
            "reviewed": bool(ov),
            "reviewNote": (ov or {}).get("note", ""),
        })

    year, week, _ = dt.date.today().isocalendar()
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "crawl_generated_at": doc.get("generated_at", "") if isinstance(doc, dict) else "",
        "week": f"{year}-W{week:02d}",
        "states": states,
        "bills": sorted(out_bills, key=lambda x: (x["state"], x["type"], x["number"])),
    }


def diff(prev: dict | None, cur: dict) -> list[dict]:
    """Bills that are new, changed stage, or changed classification since last week."""
    if not prev:
        return []
    old = {b["id"]: b for b in prev.get("bills", [])}
    moved = []
    for b in cur["bills"]:
        p = old.get(b["id"])
        if p is None:
            moved.append({"id": b["id"], "change": "new"})
        elif p.get("stage") != b["stage"]:
            moved.append({"id": b["id"], "change": "stage", "from": p.get("stage"), "to": b["stage"]})
        elif p.get("type") != b["type"]:
            moved.append({"id": b["id"], "change": "reclassified", "from": p.get("type"), "to": b["type"]})
    return moved


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    repo = Path(ap.parse_args().repo).resolve()
    cur = build(repo)
    hist = repo / "data/live-history"
    hist.mkdir(exist_ok=True)
    previous = sorted(p for p in hist.glob("*.json") if p.stem != cur["week"])
    prev = json.loads(previous[-1].read_text()) if previous else None
    cur["previous_week"] = prev["week"] if prev else ""
    cur["moved"] = diff(prev, cur)
    blob = json.dumps(cur, ensure_ascii=False, separators=(",", ":"))
    (repo / "data/live.json").write_text(blob)
    (hist / f"{cur['week']}.json").write_text(blob)
    n = len(cur["bills"])
    print(f"live.json: week {cur['week']}, {n} classified bills, "
          f"{sum(b['reviewed'] for b in cur['bills'])} reviewed, {len(cur['moved'])} moved, {len(blob)//1024} KB")


if __name__ == "__main__":
    main()
