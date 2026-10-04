"""LegiScan API integration for state and federal bill tracking.

Uses the LegiScan Pull API (https://legiscan.com/legiscan) to search for
and fetch detailed bill data across all 50 states + Congress.  The free
tier allows 30,000 requests per 30-day rolling window — more than enough
for daily refreshes of ~50-100 tracked bills plus periodic keyword searches.

Bill data is normalised to the same schema used by the SAFE Action website
(``data/bills.json``), including SAFE-specific fields like ``billType``,
``stance``, ``isActive``, and ``category``.
"""

import asyncio
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from ..config import (
    LEGISCAN_API_KEY,
    LEGISCAN_BASE_URL,
    LEGISCAN_RATE_LIMIT,
    PRIORITY_STATES,
)
from ..utils.rate_limiter import RateLimiter

rate_limiter = RateLimiter(LEGISCAN_RATE_LIMIT)

# ── Keywords that signal science/health/vaccine bills ───────────────────

# Broad terms only: getSearch is full-text, so compound phrases like
# "vaccine exemption" are strict subsets of "vaccine" and only burn budget.
# 12 queries x 51 jurisdictions = 612 search calls, leaving headroom for
# enrichment within the daily budget (previously 20 x 51 > budget, which
# silently cut off every state after SC and starved enrichment to zero).
SEARCH_QUERIES = [
    "vaccine",
    "vaccination",
    "immunization",
    "medical freedom",
    "philosophical exemption",
    "public health emergency",
    "communicable disease",
    "quarantine",
    "fluoride",
    "raw milk",
    "health officer authority",
    "pandemic preparedness",
]

# ── Heuristic classification ───────────────────────────────────────────

# ── Core topics that qualify for anti-science classification ──────────
# Only bills explicitly about these topics get classified as anti/pro.
# Everything else found via search is classified as "monitor".
# Based on AP/Plural Policy analysis of 420+ curated anti-science bills.
_CORE_TOPICS = [
    # Vaccines (350+ bills tracked by AP in 2025)
    "vaccine", "vaccination", "immunization", "immunize", "unvaccinated",
    # Raw milk (part of 70+ bills)
    "raw milk", "unpasteurized milk", "unpasteurised milk",
    # Fluoride (part of 70+ bills)
    "fluoride", "fluoridation", "water fluorid",
    # mRNA / anti-vaccine coded language
    "mrna", "mRNA",
    # Geoengineering / chemtrails (FL made it a felony)
    "geoengineering", "chemtrail",
]

# Anti-science keywords — expanded from AP/Plural Policy curated bill patterns.
# Anti-vaccine activists use coded language like "informed consent", "medical
# freedom", "health freedom", and even designate mRNA vaccines as "weapons of
# mass destruction" (MN SF 3456).
_ANTI_KEYWORDS = [
    # Exemption expansion (most common category)
    "exemption", "exempt", "religious exemption", "philosophical exemption",
    "personal belief", "conscience", "nonmedical exemption",
    "opt out", "opt-out", "voluntary",
    # "Freedom" framing
    "medical freedom", "freedom act", "health freedom",
    "right to refuse", "bodily autonomy", "personal liberty",
    "informed health decision",
    # Anti-mandate
    "prohibit mandate", "prohibit vaccination", "ban mandate",
    "prohibit require", "eliminate requirement", "remove requirement",
    # Informed consent (primary coded language per user feedback)
    "informed consent",
    # Anti-vaccine discrimination protections
    "discrimination against unvaccinated", "vaccine status",
    "vaccination status discrimination",
    # Vaccine injury / liability
    "vaccine injury", "vaccine harm", "injury compensation",
    "liability", "criminal offense of vaccine",
    # mRNA reclassification (MN SF 3456 pattern)
    "weapons of mass destruction", "gene therapy", "experimental",
    "biological agent",
    # Waiting periods / blood bank testing
    "vaccine waiting period", "blood bank",
    # Fluoride opposition
    "ban fluoride", "prohibit fluoride", "remove fluoride",
    "fluoride choice",
    # Raw milk expansion
    "raw milk sales", "real milk", "unpasteurized sales",
    # Parental rights framing
    "parental rights", "parent right",
    # Vaccine passport (surveillance concern)
    "vaccine passport", "vaccination passport",
    # Vaccination status (same intent as "vaccine status")
    "vaccination status",
    # "No mandates" pattern (opposing mandates)
    "no mandate",
    # Repeal existing vaccine requirements
    "repeal",
    # Prohibition pattern (banning vaccine requirements, fluoride, etc.)
    "prohibition",
    # Unprofessional conduct (penalizing pro-vaccine doctors)
    "unprofessional conduct",
    # Specific anti patterns
    "vaccine injured",
    "harmful vaccine",
    "vaccine carveout",
    "non-discrimination",
    "no vaccine mandate",
    "no vaccination mandate",
    "no immunization mandate",
]

# Anti keywords that say nothing about direction on their own: "exemption"
# appears in bills that add exemptions and in bills that eliminate them;
# "liability" in bills that strip vaccine-maker protections and in bills that
# protect vaccinators. They can cancel out pro keywords (ties go to Monitor)
# but never make a bill Oppose on their own.
_DIRECTIONLESS_ANTI_KEYWORDS = {
    "exemption", "exempt", "conscience", "voluntary", "liability",
    "repeal", "prohibition", "experimental",
}

# Direction-aware rules, checked per sentence in order; the first rule that
# matches decides that sentence. When any sentence matches, these decide the
# bill and keyword counts are ignored, because keywords cannot tell "add an
# exemption" from "eliminate an exemption". Sentences are not split on ";"
# because LegiScan titles often read "Subject; detail; prohibition".
_VERB_ADD = r"\b(?:add|adds|adding|expand\w*|allow\w*|permit\w*|establish\w*|creat\w*|provid\w*|grant\w*|authoriz\w*|recogniz\w*|broaden\w*|restor\w*|preserv\w*|protect\w*|accept\w*)\b"
_VERB_REMOVE = r"\b(?:eliminat\w*|remov\w*|repeal\w*|prohibit\w*|restrict\w*|limit\w*|tighten\w*|end|ends|ending|narrow\w*|abolish\w*)\b"
_VERB_BAN = r"\b(?:prohibit\w*|ban|bans|banning|bar|bars|barring|forbid\w*|preclud\w*|prevent\w*)\b"
_C = r"[^.]"  # stay inside the sentence
_DIRECTION_RULES = [
    # Coded anti framing decides the sentence before anything else.
    (r"informed consent|medical freedom|health freedom|right to refuse|bodily autonomy"
     r"|vaccine[- ]injur|harmful vaccine|gene-based|genetic-based|bioweapon|weapons of mass destruction"
     r"|who (?:refuse|decline)|vaccine discrimination|choos\w* (?:whether )?to (?:immunize|vaccinate)"
     r"|more stringent than"
     r"|(?:death|fatalit)\w*" + _C + r"{0,80}(?:resulting from|caused by|related to|and the administration of) vaccin"
     r"|protect\w*" + _C + r"{0,40}\bfrom" + _C + r"{0,40}(?:mandat|compulsory|required)", "anti"),
    # Liability aimed at vaccines (injury claims, manufacturer or employer liability).
    (r"liab\w*" + _C + r"{0,80}injur|injur\w*" + _C + r"{0,80}liab|manufacturer\w*" + _C + r"{0,20}liab"
     r"|liabilit\w*" + _C + r"{0,40}(?:vaccine|vaccination|immunization) (?:requirement|mandate)", "anti"),
    # Banning mandates, passports, status discrimination, or administration.
    (_VERB_BAN + _C + r"{0,80}(?:mandat|requir\w*" + _C + r"{0,40}(?:vaccin|immuniz)|compel|compulsory|passport|discriminat|administ\w*" + _C + r"{0,60}(?:vaccin|immuniz|mrna))", "anti"),
    # Removing or restricting exemptions ("eliminating personal conviction
    # exemption"; "use of an exemption ... prohibited").
    (_VERB_REMOVE + _C + r"{0,80}exempt", "pro"),
    (r"exempt" + _C + r"{0,120}" + _VERB_REMOVE, "pro"),
    # Decoupling state law from federal (ACIP) guidance so the state can set
    # its own schedule; must precede the "removing requirements" rule.
    (r"\bremov\w*" + _C + r"{0,40}requirement\w*" + _C + r"{0,50}(?:federal guidance|advisory committee on immunization practices)", "pro"),
    # Adding or expanding exemptions ("permitting religious exemptions";
    # "vaccine exemption; authorize"; "to exempt all persons from").
    (_VERB_ADD + _C + r"{0,60}exempt|exempt\w*" + _C + r"{0,40}" + _VERB_ADD + r"|\bexempt(?:s|ing)?\b" + _C + r"{0,80}\bfrom\b", "anti"),
    # Removing vaccine requirements, or prohibiting them / mRNA / fluoride
    # with the verb after the subject ("vaccine mandate; prohibition").
    (r"\b(?:eliminat|remov|repeal|reduc|delet|strik|rescind)\w*" + _C + r"{0,80}(?:requir|mandat|compulsory|vaccination laws?)"
     r"|(?:mandat|requir\w*|vaccin\w*|immuniz\w*|mrna|fluorid\w*|geoengineering)" + _C + r"{0,60}\bprohibit"
     r"|\b(?:prohibit\w*|ban|bans|banning|remov\w*|eliminat\w*|end)\b" + _C + r"{0,60}(?:fluorid|geoengineering)", "anti"),
    # Stripping liability protection vs. granting it.
    (r"\b(?:eliminat|remov|repeal|waiv|strip|end)\w*" + _C + r"{0,60}liabilit\w*" + _C + r"{0,20}(?:protect|shield|immunit)", "anti"),
    (r"liabilit\w*\s+(?:protect|shield|immunit)|protect\w*" + _C + r"{0,60}from" + _C + r"{0,20}liabilit", "pro"),
    # Requiring vaccination (unless the sentence is about exemptions to it).
    (r"^(?!.*exempt).*\b(?:require|requires|requiring|compulsory|mandatory)\s+(?:\w+\s+){0,2}(?:vaccinations?|immunizations?)\b", "pro"),
    # Expanding who may vaccinate.
    (r"administ\w*" + _C + r"{0,60}(?:vaccin|immuniz)", "pro"),
    (r"\b(?:authoriz|allow|permit)\w*" + _C + r"{0,80}\bto (?:vaccinate|immunize|administer)\b", "pro"),
    # Legalizing raw milk ("unpasteurized" also contains the pro keyword
    # "pasteurized", which is why this needs a rule).
    (r"(?:unpasteuri[sz]ed|raw) milk" + _C + r"{0,40}(?:sale|sell|authoriz|legaliz|allow|permit)|(?:authoriz|legaliz|allow|permit)\w*" + _C + r"{0,40}(?:unpasteuri[sz]ed|raw) milk", "anti"),
]
_DIRECTION_RULES = [(re.compile(pat), side) for pat, side in _DIRECTION_RULES]


def _direction_scores(text: str) -> tuple[int, int]:
    """Return (pro, anti) counts of sentences decided by a direction rule."""
    pro = anti = 0
    for clause in text.split("."):
        for pattern, side in _DIRECTION_RULES:
            if pattern.search(clause):
                if side == "pro":
                    pro += 1
                else:
                    anti += 1
                break
    return pro, anti


# Pro-science keywords
_PRO_KEYWORDS = [
    # Vaccine strengthening
    "strengthen immunization", "require vaccination", "require immunization",
    "safeguard vaccine", "protect public health",
    "limit exemption", "remove exemption", "tighten exemption",
    "eliminate exemption", "restrict exemption",
    "vaccine access", "expand vaccine",
    "immunization registry", "disease surveillance", "outbreak response",
    # Fluoride support
    "fluoridation program", "community water fluoridation",
    "optimal fluoride", "dental health",
    # Pasteurization support
    "pasteurization", "pasteurized", "food safety standard",
    # Science education
    "evidence-based", "science-based",
    # Funding / access expansion
    "fund research", "fund vaccine", "vaccine program",
    "vaccination program", "immunization program",
    "vaccination strategy", "vaccine strategy",
    "vaccine transportation",
]

# Category detection from title/description
# Expanded with patterns from AP/Plural Policy bill tracking
_CATEGORY_PATTERNS = {
    "vaccine-exemption": ["exemption", "exempt", "opt out", "opt-out",
                          "nonmedical", "personal belief", "philosophical",
                          "religious exemption", "conscience"],
    "vaccine-mandate": ["mandate", "require", "requirement", "compulsory",
                        "prohibit mandate", "ban mandate"],
    "medical-freedom": ["medical freedom", "freedom act", "health freedom",
                        "bodily autonomy", "right to refuse", "personal liberty"],
    "informed-consent": ["informed consent", "informed health decision"],
    "vaccine-discrimination": ["discrimination", "vaccine status",
                               "unvaccinated", "vaccination status"],
    "mRNA-reclassification": ["mrna", "mRNA", "gene therapy",
                              "weapons of mass destruction", "biological agent"],
    "vaccine-injury": ["vaccine injury", "vaccine harm", "injury compensation",
                       "liability", "adverse event"],
    "raw-milk": ["raw milk", "unpasteurized", "unpasteurised", "real milk",
                 "donkey milk"],
    "fluoride": ["fluoride", "fluoridation", "fluoride choice"],
    "geoengineering": ["geoengineering", "chemtrail", "cloud seeding"],
    "public-health": ["public health", "disease surveillance", "outbreak",
                      "immunization registry", "quarantine"],
}

# Status mapping from LegiScan status codes to our labels
_STATUS_MAP = {
    # LegiScan status codes (https://legiscan.com/gaits/documentation/legiscan):
    # 1 Introduced, 2 Engrossed, 3 Enrolled, 4 Passed, 5 Vetoed, 6 Failed.
    # These were shifted by one until 2026-10-04 (4 "Passed" = enacted showed as
    # "Passed Both Chambers"; 6 "Failed" showed as "Signed into Law").
    1: "Introduced",
    2: "Passed One Chamber",    # Engrossed
    3: "Passed Both Chambers",  # Enrolled
    4: "Signed into Law",       # Passed (enacted, incl. law without signature)
    5: "Vetoed",
    6: "Failed",
}

# LegiScan progress codes for active/dead determination
_DEAD_PROGRESS = {0}  # 0 = not available / dead
_ENACTED_PROGRESS = {4}  # 4 = enacted/signed


def _classify_bill(title: str, description: str = "") -> tuple[str, str, str]:
    """Classify a bill as pro/anti science and assign a category.

    Returns (billType, stance, category).

    STRICT CLASSIFICATION: Only bills explicitly about vaccines, raw milk,
    or fluoride are classified as anti/pro-science. All other health-related
    bills are classified as "monitor" to avoid false positives.
    """
    text = f"{title} {description}".lower()

    # Determine category first
    category = "public-health"  # default
    best_score = 0
    for cat, patterns in _CATEGORY_PATTERNS.items():
        score = sum(1 for p in patterns if p in text)
        if score > best_score:
            best_score = score
            category = cat

    # GATE: Only classify as anti/pro if bill is about core topics
    is_core_topic = any(topic.lower() in text for topic in _CORE_TOPICS)

    if not is_core_topic:
        # Not about vaccines, raw milk, or fluoride — track but don't label
        return "monitor", "Monitor", category

    # Direction rules first; keyword scoring only when none of them fire.
    pro_score, anti_score = _direction_scores(text)
    if not (pro_score or anti_score):
        anti_hits = [kw for kw in _ANTI_KEYWORDS if kw in text]
        pro_score = sum(1 for kw in _PRO_KEYWORDS if kw in text)
        anti_score = len(anti_hits)
        if all(kw in _DIRECTIONLESS_ANTI_KEYWORDS for kw in anti_hits):
            anti_score = min(anti_score, pro_score)  # cannot win alone

    if pro_score > anti_score:
        bill_type = "pro"
        stance = "Support"
    elif anti_score > pro_score:
        bill_type = "anti"
        stance = "Oppose"
    else:
        # Core topic but no clear (or conflicting) signals: monitor, never
        # Oppose on a guess
        bill_type = "monitor"
        stance = "Monitor"

    return bill_type, stance, category


def _determine_status(bill: dict) -> tuple[str, str]:
    """Determine human-readable status and isActive from LegiScan data.

    Returns (status_label, isActive).
    """
    status_id = bill.get("status", 0)
    progress = bill.get("progress", [])

    # Check progress events for more detail
    last_progress = 0
    if isinstance(progress, list) and progress:
        last_progress = max(p.get("event", 0) if isinstance(p, dict) else (p if isinstance(p, int) else 0)
                           for p in progress)

    status_label = _STATUS_MAP.get(status_id, "Introduced")

    # Override with more specific labels from last action
    last_action = bill.get("last_action", "")
    la_lower = last_action.lower() if last_action else ""

    # "Signed in the Senate" is an enrollment step, not the governor: only
    # governor/chaptering language means the bill became law.
    law_words = ("signed by governor", "signed by the governor", "approved by governor",
                 "approved by the governor", "chaptered", "became law", "become law",
                 "enacted", "effective on", "public law", "act no.")
    if any(w in la_lower for w in law_words):
        status_label = "Signed into Law"
    elif "vetoed" in la_lower or "veto" in la_lower:
        status_label = "Vetoed"
    elif "died" in la_lower or "failed" in la_lower or "tabled" in la_lower:
        status_label = "Died in Committee"
    elif "withdrawn" in la_lower:
        status_label = "Withdrawn"
    elif "passed" in la_lower and ("senate" in la_lower or "house" in la_lower):
        status_label = "Passed One Chamber"
    elif "floor" in la_lower or "third reading" in la_lower:
        status_label = "Floor Vote Scheduled"
    elif "committee" in la_lower and ("referred" in la_lower or "assigned" in la_lower):
        status_label = "In Committee"
    elif "filed" in la_lower or "prefiled" in la_lower or "introduced" in la_lower:
        status_label = "Introduced"

    # Determine if active
    dead_statuses = {"Vetoed", "Died in Committee", "Failed", "Tabled", "Withdrawn", "Signed into Law"}
    is_active = "No" if status_label in dead_statuses else "Yes"

    return status_label, is_active


def _determine_impact(bill: dict, bill_type: str) -> str:
    """3-tier impact scoring based on bill language, status, and momentum."""
    title = (bill.get("title") or "").lower()
    desc = (bill.get("description") or "").lower()
    text = f"{title} {desc}"
    status = bill.get("status", 0)
    sponsors = bill.get("sponsors", [])
    sponsor_count = len(sponsors) if isinstance(sponsors, list) else 0
    last_action = bill.get("last_action", "")
    last_action_date = bill.get("last_action_date", "")

    # HIGH: aggressive language, advanced status, or strong co-sponsorship
    high_signals = [
        "all vaccine", "eliminate", "prohibit", "ban",
        "compulsory", "mandatory", "statewide",
        "all school", "every child", "all children",
        "repeal", "remove all", "abolish",
        "weapons of mass destruction", "gene therapy",
        "criminal penalty", "felony", "misdemeanor",
    ]
    if any(s in text for s in high_signals):
        return "High"
    if status >= 2:  # engrossed or further
        return "High"
    if sponsor_count >= 5:
        return "High"

    # LOW: stalled, no recent action, single sponsor just introduced
    if last_action_date:
        try:
            from datetime import datetime as _dt
            action_dt = _dt.strptime(last_action_date[:10], "%Y-%m-%d")
            days_since = (_dt.now() - action_dt).days
            if days_since > 90 and status <= 1:
                return "Low"
        except (ValueError, TypeError):
            pass

    if sponsor_count <= 1 and status <= 1:
        la = (last_action or "").lower()
        if "introduced" in la or "referred" in la or "filed" in la:
            return "Low"

    # MEDIUM: active but not yet critical
    return "Medium"


def _structured_sponsors(sponsors) -> list[dict]:
    """LegiScan getBill sponsors -> compact structured list for records.json."""
    out = []
    if not isinstance(sponsors, list):
        return out
    for s in sponsors:
        if not isinstance(s, dict) or not s.get("name"):
            continue
        if s.get("committee_sponsor"):
            continue  # committee sponsors are not people
        stype = s.get("sponsor_type_id")
        out.append({
            "people_id": s.get("people_id"),
            "name": s.get("name", ""),
            "first_name": s.get("first_name", ""),
            "last_name": s.get("last_name", ""),
            "party": s.get("party", ""),
            "role": s.get("role", ""),
            "district": s.get("district", ""),
            "type": "primary" if stype in (1, "1") else "cosponsor",
        })
    return out


def _roll_call_summaries(bill: dict) -> list[dict]:
    """LegiScan getBill 'votes' -> roll-call summaries (no individual votes)."""
    out = []
    for v in bill.get("votes", []) or []:
        if not isinstance(v, dict) or not v.get("roll_call_id"):
            continue
        chamber = (v.get("chamber") or "").upper()
        out.append({
            "key": f"LS-{v['roll_call_id']}",
            "legiscan_roll_call_id": v.get("roll_call_id"),
            "date": v.get("date", ""),
            "desc": v.get("desc", ""),
            "chamber": "Senate" if chamber == "S" else ("House" if chamber == "H" else chamber),
            "yea": v.get("yea", 0), "nay": v.get("nay", 0), "nv": v.get("nv", 0),
            "absent": v.get("absent", 0), "total": v.get("total", 0),
            "passed": bool(v.get("passed")),
            "sourceUrl": v.get("state_link") or v.get("url") or "",
        })
    return out


def _normalize_bill(bill: dict, state: str) -> dict:
    """Normalise a LegiScan bill record to the SAFE Action bills.json schema."""
    title = bill.get("title", "")
    description = bill.get("description", "")
    bill_type, stance, category = _classify_bill(title, description)
    status_label, is_active = _determine_status(bill)
    impact = _determine_impact(bill, bill_type)

    bill_number = bill.get("bill_number", "")
    bill_id_str = f"{state.upper()}-{bill_number.replace(' ', '').replace('.', '')}"

    # Sponsor info: keep the legacy display string AND the structured list
    # (people_id/role/district) that the legislative-records join needs.
    sponsors = bill.get("sponsors", [])
    sponsorships = _structured_sponsors(sponsors)
    sponsor_text = ""
    if isinstance(sponsors, list) and sponsors:
        primary = [s for s in sponsors if isinstance(s, dict) and s.get("sponsor_type_id") == 1]
        if primary:
            sponsor_text = primary[0].get("name", "")
            party = primary[0].get("party", "")
            if party:
                sponsor_text += f" ({party})"
        elif isinstance(sponsors[0], dict):
            sponsor_text = sponsors[0].get("name", "")

    # Last action
    last_action = bill.get("last_action", "")
    last_action_date = bill.get("last_action_date", "")

    # Source URL
    source_url = bill.get("url", "") or bill.get("state_link", "")
    legiscan_url = f"https://legiscan.com/{state.upper()}/bill/{bill_number.replace(' ', '').replace('.', '')}/{bill.get('session', {}).get('session_name', '')}"

    return {
        "billId": bill_id_str,
        "state": state.upper(),
        "billNumber": bill_number,
        "title": title,
        "status": status_label,
        "isActive": is_active,
        "billType": bill_type,
        "stance": stance,
        "category": category,
        "level": "Federal" if state.upper() == "US" else "State",
        "impact": impact,
        "summary": description[:300] if description else title,
        "sponsor": sponsor_text,
        "sponsorships": sponsorships,
        "rollCalls": _roll_call_summaries(bill),
        "session_id": (bill.get("session") or {}).get("session_id") if isinstance(bill.get("session"), dict) else None,
        "lastAction": last_action,
        "lastActionDate": last_action_date,
        "actionCount": 0,
        "stoppedWithAction": False,
        "sourceUrl": source_url or legiscan_url,
        "legiscan_bill_id": bill.get("bill_id"),
    }


# ── HTTP helpers ──────────────────────────────────────────────────────────

async def _api_call(client: httpx.AsyncClient, op: str, **params) -> dict | None:
    """Issue a rate-limited GET against the LegiScan API.

    Returns the parsed JSON body, or None on failure.
    """
    await rate_limiter.wait(LEGISCAN_BASE_URL)

    query_params = {
        "key": LEGISCAN_API_KEY,
        "op": op,
        **params,
    }

    try:
        resp = await client.get(LEGISCAN_BASE_URL, params=query_params, timeout=30.0)
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") == "ERROR":
            print(f"  LegiScan API error: {data.get('alert', {}).get('message', 'Unknown error')}")
            return None

        return data
    except httpx.HTTPStatusError as exc:
        print(f"  LegiScan API HTTP error {exc.response.status_code}")
        return None
    except httpx.RequestError as exc:
        print(f"  LegiScan request failed: {exc}")
        return None


# ── Bill search ──────────────────────────────────────────────────────────

async def search_bills(state: str, query: str, year: int = 2) -> list[dict]:
    """Search for bills in *state* matching *query*.

    *year* controls the session scope:
      1 = current session only
      2 = current + prior session (default)
      3 = all available sessions

    Returns a list of raw LegiScan search result entries.
    """
    if not LEGISCAN_API_KEY:
        return []

    async with httpx.AsyncClient() as client:
        data = await _api_call(client, "getSearch",
                               state=state.upper(),
                               query=query,
                               year=year)

        if data is None:
            return []

        searchresult = data.get("searchresult", {})
        # searchresult contains numeric keys for results + "summary"
        results = []
        for key, val in searchresult.items():
            if key == "summary":
                continue
            if isinstance(val, dict) and val.get("bill_id"):
                results.append(val)

        return results


async def get_bill_detail(bill_id: int) -> dict | None:
    """Fetch full details for a specific bill by its LegiScan bill_id."""
    if not LEGISCAN_API_KEY:
        return None

    async with httpx.AsyncClient() as client:
        data = await _api_call(client, "getBill", id=bill_id)
        if data is None:
            return None
        return data.get("bill", {})


async def fetch_all_science_bills(states: list[str] | None = None) -> list[dict]:
    """Search all priority states for science/health bills via LegiScan.

    Returns normalised bill dicts matching the SAFE Action bills.json schema.
    Deduplicates by billId. Tracks API request count to stay within budget.
    """
    if not LEGISCAN_API_KEY:
        print("  LegiScan API key not configured, skipping bill search")
        return []

    target_states = states or PRIORITY_STATES
    all_bills: dict[str, dict] = {}  # keyed by billId for dedup
    # 30k/month LegiScan quota ~= 1k/day. Split so a search overrun can
    # never starve enrichment again: 620 search + 150 enrich + the 200-cap
    # refresh_tracked_bills pass stays under 1k/day.
    search_budget = 620
    request_budget = 800  # total ceiling (search + enrich)
    requests_used = 0
    bills_enriched = 0

    async with httpx.AsyncClient() as client:
        # Phase 1: Search for bills across states and keywords.
        # Query-major on purpose: if the budget ever runs out mid-loop we
        # lose one keyword everywhere, never whole states (the old
        # state-major loop silently dropped every state after SC).
        per_state_new: dict[str, int] = {}
        for query in SEARCH_QUERIES:
            if requests_used >= search_budget:
                print(f"  ⚠ Search budget reached ({requests_used}), stopping search")
                break

            for state in target_states:
                if requests_used >= search_budget:
                    break

                data = await _api_call(client, "getSearch",
                                       state=state.upper(),
                                       query=query,
                                       year=2)  # current + prior session
                requests_used += 1

                if data is None:
                    continue

                searchresult = data.get("searchresult", {})
                for key, val in searchresult.items():
                    if key == "summary":
                        continue
                    if not isinstance(val, dict) or not val.get("bill_id"):
                        continue

                    # Quick normalize from search result (limited data)
                    bill_number = val.get("bill_number", "")
                    bill_id_str = f"{state.upper()}-{bill_number.replace(' ', '').replace('.', '')}"

                    if bill_id_str in all_bills:
                        continue  # already have this bill

                    title = val.get("title", "")
                    relevance = val.get("relevance", 0)

                    # Only include bills with reasonable relevance
                    if relevance and relevance < 50:
                        continue

                    all_bills[bill_id_str] = {
                        "_legiscan_bill_id": val.get("bill_id"),
                        "_search_state": state.upper(),
                        "billId": bill_id_str,
                        "state": state.upper(),
                        "billNumber": bill_number,
                        "title": title,
                        "lastActionDate": val.get("last_action_date", ""),
                        "lastAction": val.get("last_action", ""),
                        "sourceUrl": val.get("url", ""),
                        "relevance": relevance,
                    }
                    per_state_new[state.upper()] = per_state_new.get(state.upper(), 0) + 1

        for st in sorted(per_state_new):
            print(f"  LegiScan: {st} → {per_state_new[st]} unique bills")

        # Phase 2: Fetch full details for top bills
        # Sort by relevance (highest first) and enrich the most relevant
        candidates = sorted(
            all_bills.values(),
            key=lambda b: b.get("relevance", 0),
            reverse=True,
        )

        enriched_bills: dict[str, dict] = {}
        max_enrich = min(len(candidates), 50)  # search-result enrichment; the refresh queue below does the targeted work

        print(f"  Enriching top {max_enrich} bills with full details...")
        for entry in candidates[:max_enrich]:
            if requests_used >= request_budget:
                print(f"  ⚠ Budget reached ({requests_used}), stopping enrichment")
                break

            legiscan_id = entry.get("_legiscan_bill_id")
            if not legiscan_id:
                continue

            data = await _api_call(client, "getBill", id=legiscan_id)
            requests_used += 1

            if data is None:
                # Use search-result data as fallback
                bill_type, stance, category = _classify_bill(entry.get("title", ""))
                enriched_bills[entry["billId"]] = {
                    "billId": entry["billId"],
                    "state": entry["state"],
                    "billNumber": entry["billNumber"],
                    "title": entry["title"],
                    "status": "Introduced",
                    "isActive": "Yes",
                    "billType": bill_type,
                    "stance": stance,
                    "category": category,
                    "level": "Federal" if entry["state"] == "US" else "State",
                    "impact": "Medium",
                    "summary": entry["title"],
                    "sponsor": "",
                    "lastAction": entry.get("lastAction", ""),
                    "lastActionDate": entry.get("lastActionDate", ""),
                    "actionCount": 0,
                    "stoppedWithAction": False,
                    "sourceUrl": entry.get("sourceUrl", ""),
                }
                continue

            bill = data.get("bill", {})
            if bill:
                normalized = _normalize_bill(bill, entry["state"])
                enriched_bills[normalized["billId"]] = normalized
                bills_enriched += 1

    # Also include non-enriched search results with basic classification
    for bill_id, entry in all_bills.items():
        if bill_id not in enriched_bills:
            title = entry.get('title', '')
            bill_type, stance, category = _classify_bill(title)
            status_label = 'Introduced'
            last_action = entry.get('lastAction', '')
            la_lower = last_action.lower() if last_action else ''
            if 'signed' in la_lower or 'enacted' in la_lower:
                status_label = 'Signed into Law'
            elif 'died' in la_lower or 'failed' in la_lower or 'tabled' in la_lower:
                status_label = 'Died in Committee'
            elif 'passed' in la_lower:
                status_label = 'Passed One Chamber'
            elif 'committee' in la_lower:
                status_label = 'In Committee'
            dead_statuses = {'Vetoed', 'Died in Committee', 'Tabled', 'Withdrawn', 'Signed into Law'}
            is_active = 'No' if status_label in dead_statuses else 'Yes'
            enriched_bills[bill_id] = {
                'billId': bill_id,
                'state': entry['state'],
                'billNumber': entry['billNumber'],
                'title': title,
                'status': status_label,
                'isActive': is_active,
                'billType': bill_type,
                'stance': stance,
                'category': category,
                'level': 'Federal' if entry['state'] == 'US' else 'State',
                'impact': 'Medium',
                'summary': title,
                'sponsor': '',
                'lastAction': last_action,
                'lastActionDate': entry.get('lastActionDate', ''),
                'actionCount': 0,
                'stoppedWithAction': False,
                'sourceUrl': entry.get('sourceUrl', ''),
                'legiscan_bill_id': entry.get('_legiscan_bill_id'),
            }

    result = list(enriched_bills.values())
    print(f'  LegiScan search complete: {len(result)} bills, {bills_enriched} enriched ({requests_used} API requests)')
    return result


# ── Refresh existing tracked bills ───────────────────────────────────────

REFRESH_CAP = 240   # daily budget: ~612 search + 50 enrich + 240 refresh + 60 votes < 1,000; refresh prioritises anti/pro bills lacking sponsors


async def refresh_tracked_bills(existing_bills: list[dict]) -> list[dict]:
    """Update status/lastAction for bills that have a ``legiscan_bill_id``.

    Returns the updated list. Bills without a LegiScan ID are passed through
    unchanged.
    """
    if not LEGISCAN_API_KEY or not existing_bills:
        return existing_bills

    print(f"  Refreshing {len(existing_bills)} tracked bills via LegiScan...")
    requests_used = 0

    # Priority: the 200-call cap used to be spent on whatever bills came first
    # (alphabetically AK/AL), forever. Order so the calls go where they matter
    # and sponsorship coverage grows every run:
    #   0 anti/pro active without sponsorships   1 anti/pro active (status refresh)
    #   2 anti/pro inactive without sponsorships 3 monitor without sponsorships (recent first)
    #   4 everything else
    def _prio(b: dict):
        stance = b.get("billType") in ("anti", "pro")
        active = b.get("isActive") == "Yes"
        has_sp = bool(b.get("sponsorships"))
        if stance and active and not has_sp: tier = 0
        elif stance and active: tier = 1
        elif stance and not has_sp: tier = 2
        elif not has_sp: tier = 3
        else: tier = 4
        return (tier,)
    # Recent-first within a tier, then stable-sort by tier. The returned list
    # keeps its original order; only the choice of which bills to refresh changes.
    order = sorted(range(len(existing_bills)), key=lambda i: existing_bills[i].get("lastActionDate") or "", reverse=True)
    order.sort(key=lambda i: _prio(existing_bills[i])[0])
    refresh_set = set()
    for i in order:
        if existing_bills[i].get("legiscan_bill_id") and len(refresh_set) < REFRESH_CAP:
            refresh_set.add(i)

    updated = list(existing_bills)
    async with httpx.AsyncClient() as client:
        for i in sorted(refresh_set):
            bill = existing_bills[i]
            legiscan_id = bill.get("legiscan_bill_id")
            if not legiscan_id:
                continue

            data = await _api_call(client, "getBill", id=legiscan_id)
            requests_used += 1

            if data is None:
                continue

            fresh = data.get("bill", {})
            if not fresh:
                continue

            # Update mutable fields, keep our classification
            status_label, is_active = _determine_status(fresh)
            bill["status"] = status_label
            bill["isActive"] = is_active
            bill["lastAction"] = fresh.get("last_action", bill.get("lastAction", ""))
            bill["lastActionDate"] = fresh.get("last_action_date", bill.get("lastActionDate", ""))
            bill["sourceUrl"] = fresh.get("url", "") or bill.get("sourceUrl", "")

            # Roll-call summaries and session id ride along too; keep them.
            rcs = _roll_call_summaries(fresh)
            if rcs:
                bill["rollCalls"] = rcs
            if isinstance(fresh.get("session"), dict) and fresh["session"].get("session_id"):
                bill["session_id"] = fresh["session"]["session_id"]
            # Sponsorships ride along on every getBill; keep them.
            sp = _structured_sponsors(fresh.get("sponsors", []))
            if sp:
                bill["sponsorships"] = sp
                if not bill.get("sponsor"):
                    primary = [s for s in sp if s["type"] == "primary"] or sp
                    bill["sponsor"] = primary[0]["name"] + (f" ({primary[0]['party']})" if primary[0].get("party") else "")
            updated[i] = bill

    with_sp = sum(1 for b in updated if b.get("sponsorships"))
    print(f"  Refreshed {requests_used} bills via LegiScan ({with_sp} bills now carry sponsorships)")
    return updated
