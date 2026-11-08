"""Open States REST API integration for state legislator and bill data.

Uses the Open States v3 REST API (https://v3.openstates.org/) to fetch
structured legislator and bill data without browser crawling.  Falls back
gracefully when no API key is configured.

Bill search covers a 6-month lookback window across all priority states
using science/health keywords to catch legislation that may have been
introduced, amended, or reactivated.
"""

import asyncio
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ..config import (
    OPENSTATES_API_KEY,
    OPENSTATES_BASE_URL,
    OPENSTATES_RATE_LIMIT,
    PRIORITY_STATES,
)
from ..utils.rate_limiter import RateLimiter

rate_limiter = RateLimiter(OPENSTATES_RATE_LIMIT)

# Open States uses lowercase two-letter jurisdiction abbreviations
# (they also accept full OCDID strings, but abbreviations work fine).

# Chamber mapping: Open States returns "upper" / "lower"; we normalise to
# the labels the rest of the pipeline expects.
_CHAMBER_MAP = {
    "upper": "Senate",
    "lower": "House",
}


# ── HTTP helpers ──────────────────────────────────────────────────────────

def _headers() -> dict[str, str]:
    return {"X-API-KEY": OPENSTATES_API_KEY, "Accept": "application/json"}


async def _get(client: httpx.AsyncClient, path: str, params: dict | None = None) -> dict | list | None:
    """Issue a rate-limited GET against the Open States API.

    Returns the parsed JSON body, or *None* on failure.
    """
    url = f"{OPENSTATES_BASE_URL}{path}"
    await rate_limiter.wait(url)

    try:
        resp = await client.get(url, params=params, headers=_headers(), timeout=30.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as exc:
        print(f"  Open States API error {exc.response.status_code} for {url}")
        return None
    except httpx.RequestError as exc:
        print(f"  Open States request failed for {url}: {exc}")
        return None


# ── Legislators ──────────────────────────────────────────────────────────

def _normalize_person(person: dict[str, Any], state: str) -> dict:
    """Normalise an Open States person record to our LegislatorProfile schema."""
    current_role = _current_role(person)
    chamber_raw = current_role.get("org_classification", "") if current_role else ""
    chamber = _CHAMBER_MAP.get(chamber_raw, chamber_raw.title() if chamber_raw else "Unknown")
    district = current_role.get("district", "") if current_role else ""
    title = current_role.get("title", "") if current_role else ""

    name = person.get("name", "Unknown")
    party = _extract_party(person)

    # Build a stable ID consistent with the rest of the pipeline
    last_name = name.split()[-1] if name else "Unknown"
    id_parts = [state.upper(), "State", chamber, last_name]
    if district:
        id_parts.append(str(district))
    legislator_id = "-".join(id_parts).replace(" ", "-")

    # Contact info
    contact: dict[str, Any] = {}
    for link in person.get("links", []):
        url = link.get("url", "")
        if url:
            contact.setdefault("website", url)
    for office in person.get("offices", []):
        if office.get("voice"):
            contact.setdefault("phone", office["voice"])
        if office.get("email"):
            contact.setdefault("email", office["email"])
        if office.get("address"):
            contact.setdefault("address", office["address"])

    # Committee memberships (included when the API returns them)
    committees: list[dict[str, str]] = []
    for membership in person.get("committees", []):
        if isinstance(membership, dict):
            committees.append({
                "name": membership.get("name", ""),
                "role": membership.get("role", "member"),
            })

    return {
        "legislator_id": legislator_id,
        "name": name,
        "party": party,
        "state": state.upper(),
        "district": district,
        "chamber": chamber,
        "level": "State",
        "office": f"State {chamber}",
        "title": title,
        "committees": committees,
        "contact": contact,
        "photo_url": person.get("image", None),
        "openstates_id": person.get("id", ""),
        "source_urls": [
            link.get("url", "") for link in person.get("links", []) if link.get("url")
        ],
        "last_crawled": datetime.now(timezone.utc).isoformat(),
    }


def _current_role(person: dict) -> dict | None:
    """Return the person's current role, if any."""
    for role in person.get("current_role", []) if isinstance(person.get("current_role"), list) else [person.get("current_role", {})]:
        if role:
            return role
    return None


def _extract_party(person: dict) -> str:
    """Extract the primary party from an Open States person record."""
    # current_role sometimes carries the party directly
    role = _current_role(person)
    if role and role.get("party"):
        return role["party"]
    # Fall back to the party list (primary first)
    for p in person.get("party", []):
        if isinstance(p, dict):
            return p.get("name", "Unknown")
        if isinstance(p, str):
            return p
    return "Unknown"


async def fetch_legislators(state: str) -> list[dict]:
    """Fetch all current legislators for *state* from the Open States API.

    *state* is a two-letter abbreviation (e.g. ``"TX"``).  Returns a list
    of dicts conforming to our LegislatorProfile schema.
    """
    if not OPENSTATES_API_KEY:
        print(f"  Open States API key not configured, skipping {state}")
        return []

    async with httpx.AsyncClient() as client:
        # The people endpoint supports pagination; we loop until exhausted.
        legislators: list[dict] = []
        page = 1
        per_page = 50

        while True:
            data = await _get(client, "/people", params={
                "jurisdiction": state.lower(),
                "org_classification": "legislature",
                "include": "links,offices,other_names",
                "per_page": per_page,
                "page": page,
            })

            if data is None:
                break

            results = data.get("results", []) if isinstance(data, dict) else data
            if not results:
                break

            for person in results:
                legislators.append(_normalize_person(person, state))

            # Check if there are more pages
            pagination = data.get("pagination", {}) if isinstance(data, dict) else {}
            total_pages = pagination.get("max_page", page)
            if page >= total_pages:
                break
            page += 1

        print(f"  Open States: found {len(legislators)} legislators for {state}")
        return legislators


async def fetch_all_priority_legislators() -> list[dict]:
    """Fetch legislators for every state in :data:`PRIORITY_STATES`."""
    all_legislators: list[dict] = []
    for state in PRIORITY_STATES:
        print(f"  Fetching {state} via Open States API...")
        state_legs = await fetch_legislators(state)
        all_legislators.extend(state_legs)
    return all_legislators


# ── Bills ────────────────────────────────────────────────────────────────

def _normalize_bill(bill: dict[str, Any], state: str) -> dict:
    """Normalise an Open States bill record to a flat dict."""
    actions = bill.get("actions", [])
    last_action = None
    if actions:
        last = actions[-1] if isinstance(actions, list) else None
        if last and isinstance(last, dict):
            last_action = {
                "description": last.get("description", ""),
                "date": last.get("date", ""),
                "classification": last.get("classification", []),
            }

    sponsors = []
    for s in bill.get("sponsors", []):
        if isinstance(s, dict):
            sponsors.append({
                "name": s.get("name", ""),
                "classification": s.get("classification", ""),
                "primary": s.get("primary", False),
            })

    return {
        "bill_id": bill.get("id", ""),
        "identifier": bill.get("identifier", ""),
        "title": bill.get("title", ""),
        "state": state.upper(),
        "session": bill.get("session", ""),
        "chamber": _CHAMBER_MAP.get(
            bill.get("from_organization", {}).get("classification", ""), ""
        ) if isinstance(bill.get("from_organization"), dict) else "",
        "classification": bill.get("classification", []),
        "subject": bill.get("subject", []),
        "sponsors": sponsors,
        "last_action": last_action,
        "openstates_url": bill.get("openstates_url", ""),
        "sources": [s.get("url", "") for s in bill.get("sources", []) if isinstance(s, dict)],
        "created_at": bill.get("created_at", ""),
        "updated_at": bill.get("updated_at", ""),
    }


async def fetch_bills(state: str, query: str, created_since: str | None = None) -> list[dict]:
    """Search for bills in *state* matching *query*.

    *created_since* is an ISO date string (YYYY-MM-DD) to limit results
    to bills created on or after that date.

    Returns a list of normalised bill dicts.
    """
    if not OPENSTATES_API_KEY:
        print(f"  Open States API key not configured, skipping bill search for {state}")
        return []

    async with httpx.AsyncClient() as client:
        bills: list[dict] = []
        page = 1
        per_page = 20

        while True:
            params: dict[str, Any] = {
                "jurisdiction": state.lower(),
                "q": query,
                "include": "sponsors,actions,sources",
                "per_page": per_page,
                "page": page,
            }
            if created_since:
                params["created_since"] = created_since

            data = await _get(client, "/bills", params=params)

            if data is None:
                break

            results = data.get("results", []) if isinstance(data, dict) else data
            if not results:
                break

            for bill in results:
                bills.append(_normalize_bill(bill, state))

            pagination = data.get("pagination", {}) if isinstance(data, dict) else {}
            total_pages = pagination.get("max_page", page)
            if page >= total_pages:
                break
            page += 1

        return bills


# ── Science/health bill keywords ─────────────────────────────────────────

# Broad set of keywords to catch bills that relate to science, public
# health, vaccines, and medical freedom.  Each query is run per-state
# so we keep the list focused but comprehensive.
BILL_SEARCH_QUERIES = [
    "vaccine",
    "immunization",
    "vaccination",
    "public health",
    "fluoride",
    "medical freedom",
    "informed consent",
    "science education",
    "evolution",
    "climate",
    "environmental health",
    "pandemic",
    "quarantine",
    "raw milk",
    "health department",
    "health officer",
    "vaccine exemption",
    "religious exemption",
    "philosophical exemption",
    "vaccine mandate",
    "vaccine registry",
    "communicable disease",
    "childhood immunization",
    "school vaccination",
    "emergency health",
    "gain of function",
    "WHO treaty",
    "NIH funding",
    "CDC authority",
]


async def fetch_all_science_bills(lookback_months: int = 6) -> list[dict]:
    """Search every priority state for science/health bills from the last
    *lookback_months* months.

    Uses :data:`BILL_SEARCH_QUERIES` across all :data:`PRIORITY_STATES`,
    deduplicates by ``bill_id``, and returns a flat list.

    Respects the 1 req/sec rate limit (500 daily cap).  With 12 states
    and ~30 keywords that's up to 360 queries; pagination may add more.
    To stay within the daily cap the function tracks request count and
    stops early if it approaches the limit.
    """
    if not OPENSTATES_API_KEY:
        print("  Open States API key not configured, skipping bill search")
        return []

    cutoff = (datetime.now(timezone.utc) - timedelta(days=30 * lookback_months)).strftime("%Y-%m-%d")
    print(f"  Bill search window: {cutoff} → today")

    all_bills: dict[str, dict] = {}  # keyed by bill_id for dedup
    request_budget = 450  # stay safely under the 500/day cap
    requests_used = 0

    async with httpx.AsyncClient() as client:
        for state in PRIORITY_STATES:
            state_new = 0
            for query in BILL_SEARCH_QUERIES:
                if requests_used >= request_budget:
                    print(f"  ⚠ Approaching daily request limit ({requests_used}), stopping bill search")
                    break

                # Paginate through results for this state+query combo
                page = 1
                per_page = 20
                while True:
                    params: dict[str, Any] = {
                        "jurisdiction": state.lower(),
                        "q": query,
                        "include": "sponsors,actions,sources",
                        "per_page": per_page,
                        "page": page,
                        "created_since": cutoff,
                    }
                    data = await _get(client, "/bills", params=params)
                    requests_used += 1

                    if data is None:
                        break

                    results = data.get("results", []) if isinstance(data, dict) else data
                    if not results:
                        break

                    for bill in results:
                        normalized = _normalize_bill(bill, state)
                        bid = normalized.get("bill_id", "")
                        if bid and bid not in all_bills:
                            all_bills[bid] = normalized
                            state_new += 1

                    # Check pagination
                    pagination = data.get("pagination", {}) if isinstance(data, dict) else {}
                    total_pages = pagination.get("max_page", page)
                    if page >= total_pages:
                        break
                    page += 1
                    if requests_used >= request_budget:
                        break

            if state_new > 0:
                print(f"  Open States: {state} → {state_new} unique bills")

            if requests_used >= request_budget:
                break

    bills_list = list(all_bills.values())
    print(f"  Open States bill search complete: {len(bills_list)} unique bills across {len(PRIORITY_STATES)} states ({requests_used} API requests used)")
    return bills_list


# ── Status refresh of tracked bills (fallback for LegiScan) ──────────────
#
# The search above returns a different schema and costs hundreds of calls;
# this refresh instead updates bills already in data/bills.json in place.
# GET /bills takes up to 20 ``identifier`` values per call (more is a 400),
# so one call covers 20 bills of one state. ``action_since`` drops older
# sessions' bills with the same number and any bill with no new action, so
# a bill missing from the results simply had nothing new.
#
# Free-tier limits are not published; third parties report about 30/minute
# and 250/day, and Show Brain spends up to 200/day on the same key. Stay
# well under: one call every OS_REFRESH_DELAY seconds, at most
# OPENSTATES_RUN_CAP calls per run.

OS_REFRESH_DELAY = 2.0
OS_IDS_PER_CALL = 20
OS_BREAKER = 3            # consecutive failures that stop Open States for the run
OS_TITLE_MIN = 0.3        # title token overlap needed to accept a match
OPENSTATES_RUN_CAP = int(os.getenv("OPENSTATES_RUN_CAP", "120") or 120)

_PARTY = {"republican": "R", "democratic": "D", "democrat": "D", "independent": "I",
          "libertarian": "L", "green": "G"}
_STOP = {"a", "an", "and", "the", "of", "to", "for", "in", "on", "or", "by", "with", "relating", "act", "bill"}


def os_jurisdiction(state: str) -> str:
    """Open States jurisdiction filter: OCD id for states, name for DC."""
    if state.upper() == "DC":
        return "District of Columbia"
    return f"ocd-jurisdiction/country:us/state:{state.lower()}/government"


def os_query_ident(num: str) -> str | None:
    """'HB4535' -> 'HB 4535' (Open States stores a space). DC-style 'B26-0414' stays unspaced."""
    t = str(num or "").strip().replace(".", "")
    if "-" in t:
        t = t.replace(" ", "").upper()
        return t if re.fullmatch(r"[A-Z]+\d+-\d+[A-Z]*", t) else None
    m = re.fullmatch(r"([A-Za-z]+)\s*0*(\d+)(.*)", t)
    return f"{m.group(1).upper()} {m.group(2)}{m.group(3).upper()}" if m else None


def os_ident_key(num: str) -> tuple | None:
    """Comparable identifier: 'HB 0123', 'hb123' and 'HB123' are equal."""
    m = re.fullmatch(r"([A-Z]+)(\d+)(.*)", re.sub(r"[^A-Z0-9]", "", str(num or "").upper()))
    return (m.group(1), m.group(2).lstrip("0") or "0", m.group(3)) if m else None


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", str(text or "").lower()) if t not in _STOP}


def _overlap(a: set, b: set) -> float:
    return len(a & b) / min(len(a), len(b)) if a and b else 0.0


def os_pick(results: list, bill: dict) -> dict | None:
    """The Open States result for *bill*: same identifier, title overlap >= OS_TITLE_MIN
    against the bill's title or summary, latest action wins (sessions reuse numbers)."""
    want = os_ident_key(bill.get("billNumber"))
    if not want:
        return None
    mine = [_tokens(bill.get("title")), _tokens(bill.get("summary"))]
    ok = [r for r in results or []
          if isinstance(r, dict) and os_ident_key(r.get("identifier")) == want
          and max(_overlap(m, _tokens(r.get("title"))) for m in mine) >= OS_TITLE_MIN]
    if not ok:
        return None
    return max(ok, key=lambda r: str(r.get("latest_action_date") or ""))


def os_sponsorships(ob: dict) -> list[dict]:
    """Open States sponsorships in the shape records.py joins on (state + chamber + district + last name)."""
    out = []
    for sp in ob.get("sponsorships") or []:
        if not isinstance(sp, dict) or sp.get("entity_type", "person") != "person":
            continue
        person = sp.get("person") if isinstance(sp.get("person"), dict) else {}
        name = str(person.get("name") or sp.get("name") or "").strip()
        if not name:
            continue
        role = person.get("current_role") if isinstance(person.get("current_role"), dict) else {}
        org = role.get("org_classification", "")
        party = str(person.get("party") or "")
        out.append({
            "name": name,
            "party": _PARTY.get(party.lower(), party),
            "role": "Sen" if org == "upper" else "Rep" if org == "lower" else "",
            "district": str(role.get("district") or ""),
            "type": "primary" if sp.get("primary") else "cosponsor",
            "openstates_person_id": person.get("id", ""),
        })
    return out


def apply_os_update(bill: dict, ob: dict, now: str) -> bool:
    """Update *bill* in place from an Open States result. Returns True if anything changed.

    Never moves lastActionDate backwards, never downgrades a status to the
    default 'Introduced', and only fills sponsorships when the bill has none
    (LegiScan's carry people_id, which the roll-call join uses).
    """
    from .legiscan import _determine_status  # same text rules as the LegiScan path

    changed = False
    os_date = str(ob.get("latest_action_date") or "")[:10]
    os_desc = str(ob.get("latest_action_description") or "").strip()
    if os_date and os_date >= str(bill.get("lastActionDate") or "")[:10] and os_desc:
        if (os_desc, os_date) != (bill.get("lastAction"), bill.get("lastActionDate")):
            changed = True
        bill["lastAction"] = os_desc
        bill["lastActionDate"] = os_date
        status, active = _determine_status({"last_action": os_desc})
        if status != "Introduced" or bill.get("status") in (None, "", "Introduced"):
            if status != bill.get("status"):
                changed = True
            bill["status"], bill["isActive"] = status, active
    if not bill.get("sponsorships"):
        sp = os_sponsorships(ob)
        if sp:
            bill["sponsorships"] = sp
            primary = [s for s in sp if s["type"] == "primary"] or sp
            if not bill.get("sponsor"):
                bill["sponsor"] = primary[0]["name"] + (f" ({primary[0]['party']})" if primary[0]["party"] else "")
            changed = True
    if ob.get("openstates_url"):
        bill["openstatesUrl"] = ob["openstates_url"]
    bill["statusSource"] = "openstates"
    bill["statusCheckedAt"] = now
    return changed


def _os_priority(b: dict) -> tuple:
    """Stance bills first, then active ones; least recently checked first within a tier."""
    stance = b.get("billType") in ("anti", "pro")
    active = b.get("isActive") == "Yes"
    tier = 0 if stance and active else 1 if stance else 2 if active else 3
    return (tier, b.get("statusCheckedAt") or "")


def plan_os_batches(bills: list[dict], skip_ids: set[str], cap: int) -> list[tuple[str, list[dict]]]:
    """Up to *cap* (state, bills) batches of at most OS_IDS_PER_CALL bills, highest priority first."""
    queue = sorted((b for b in bills
                    if b.get("level") != "Federal" and (b.get("state") or "US").upper() != "US"
                    and b.get("billId") not in skip_ids and os_query_ident(b.get("billNumber"))),
                   key=_os_priority)
    open_batch: dict[str, list[dict]] = {}
    batches: list[tuple[str, list[dict]]] = []
    for b in queue:
        st = b["state"].upper()
        cur = open_batch.setdefault(st, [])
        if not cur:
            if len(batches) >= cap:
                continue
            batches.append((st, cur))
        cur.append(b)
        if len(cur) >= OS_IDS_PER_CALL:
            open_batch[st] = []
    return batches


def _batch_since(batch: list[dict], default: str) -> str:
    """action_since for a batch: a week before the oldest check or last action we already hold."""
    marks = [str(b.get("statusCheckedAt") or b.get("lastActionDate") or "")[:10] for b in batch]
    marks = [m for m in marks if re.fullmatch(r"\d{4}-\d{2}-\d{2}", m)]
    base = min(marks) if len(marks) == len(batch) else default
    try:
        return (datetime.fromisoformat(base) - timedelta(days=7)).strftime("%Y-%m-%d")
    except ValueError:
        return default


async def _os_fetch(client: httpx.AsyncClient, params: list[tuple]) -> tuple[int, Any, dict]:
    """(HTTP status, parsed body or None, headers). Key in the header, never the URL."""
    await rate_limiter.wait(OPENSTATES_BASE_URL, delay=OS_REFRESH_DELAY)
    resp = await client.get(f"{OPENSTATES_BASE_URL}/bills", params=params, headers=_headers(), timeout=30.0)
    try:
        body = resp.json()
    except ValueError:
        body = None
    return resp.status_code, body, dict(resp.headers)


async def refresh_bills_from_openstates(bills: list[dict], skip_ids: set[str] | None = None,
                                        cap: int | None = None, fetch=None,
                                        default_since: str = "2025-01-01") -> dict:
    """Refresh status, last action and (missing) sponsors of state bills in place.

    *skip_ids*: bills LegiScan already refreshed this run. *fetch* is injectable
    for tests: ``async fetch(params) -> (status, body, headers)``.
    Returns run stats for the bills.json ``sources`` block; ``status`` is one of
    ok / partial / failed / no_key.
    """
    stats: dict[str, Any] = {"status": "ok", "calls": 0, "checked": 0, "updated": 0, "unmatched": 0, "error": None}
    if not OPENSTATES_API_KEY and fetch is None:
        stats["status"] = "no_key"
        print("  WARNING Open States refresh skipped: OPENSTATES_API_KEY not set")
        return stats
    cap = OPENSTATES_RUN_CAP if cap is None else cap
    batches = plan_os_batches(bills, skip_ids or set(), cap)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"  Open States refresh: {len(batches)} calls planned (cap {cap}) for {sum(len(b) for _, b in batches)} bills")

    async def _run(do_fetch):
        fails = 0
        for st, batch in batches:
            if stats["calls"] >= cap:
                break
            params = [("jurisdiction", os_jurisdiction(st))]
            params += [("identifier", os_query_ident(b["billNumber"])) for b in batch]
            params += [("action_since", _batch_since(batch, default_since)), ("include", "sponsorships"),
                       ("sort", "updated_desc"), ("per_page", 20)]
            results, page, ok, truncated = [], 1, True, False
            while True:
                retried = False
                while True:
                    stats["calls"] += 1
                    try:
                        code, body, headers = await do_fetch(params + [("page", page)])
                    except Exception as exc:  # network error: count it, keep the run going
                        code, body, headers = 0, None, {}
                        stats["error"] = f"{type(exc).__name__}"
                    if code == 429 and not retried:
                        try:
                            wait = float((headers or {}).get("retry-after") or (headers or {}).get("Retry-After"))
                        except (TypeError, ValueError):
                            wait = None
                        if wait is not None and 0 <= wait <= 60:
                            retried = True
                            await asyncio.sleep(wait)
                            continue
                    break
                if code in (401, 403, 429):
                    stats["status"] = "failed" if stats["checked"] == 0 else "partial"
                    stats["error"] = f"HTTP {code} (rate limit or key refused); stopped"
                    print(f"  ERROR Open States HTTP {code}; stopping Open States for this run")
                    return
                if code != 200 or not isinstance(body, dict) or not isinstance(body.get("results"), list):
                    ok = False
                    stats["error"] = stats["error"] or f"HTTP {code} or bad response"
                    break
                results += body["results"]
                max_page = (body.get("pagination") or {}).get("max_page", page)
                if page >= max_page:
                    break
                if stats["calls"] >= cap:
                    truncated = True   # later pages unread: a missing bill is not "nothing new"
                    break
                page += 1
            if not ok:
                fails += 1
                if fails >= OS_BREAKER:
                    stats["status"] = "partial" if stats["checked"] else "failed"
                    print(f"  ERROR Open States: {fails} consecutive failures ({stats['error']}); stopping")
                    return
                continue
            fails = 0
            for b in batch:
                hit = os_pick(results, b)
                if hit is not None:
                    if apply_os_update(b, hit, now):
                        stats["updated"] += 1
                elif any(os_ident_key(r.get("identifier")) == os_ident_key(b.get("billNumber"))
                         for r in results if isinstance(r, dict)):
                    stats["unmatched"] += 1      # same number, different title: not ours, not "checked"
                    continue
                elif not truncated:
                    b["statusCheckedAt"] = now   # nothing new since action_since
                stats["checked"] += 1

    if fetch is not None:
        await _run(fetch)
    else:
        async with httpx.AsyncClient() as client:
            await _run(lambda params: _os_fetch(client, params))
    if stats["status"] == "ok" and stats["error"]:
        stats["status"] = "partial"
    print(f"  Open States refresh: {stats['checked']} bills checked, {stats['updated']} updated, "
          f"{stats['unmatched']} unmatched (same number, other title), {stats['calls']} calls, status {stats['status']}" + (f" ({stats['error']})" if stats["error"] else ""))
    if stats["status"] in ("failed", "partial"):
        print(f"::warning title=Open States refresh {stats['status']}::{stats['error']}")
    return stats
