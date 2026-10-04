"""Main orchestrator — runs the full crawl and analysis pipeline."""

import json
import asyncio
import sys
from datetime import datetime, timezone

from .config import DATA_DIR, CACHE_DIR, PRIORITY_STATES, OPENSTATES_API_KEY, LEGISCAN_API_KEY
ANTHROPIC_API_KEY = ""  # never set: no Anthropic API use in CI (operator decision 2026-08-21)
from .sources.congress import crawl_congress_members
from .sources.state_legislatures import crawl_all_state_legislators
from .sources.govinfo import fetch_federal_bills
from .sources.openstates import fetch_all_priority_legislators, fetch_all_science_bills as openstates_fetch_bills
from .sources.legiscan import fetch_all_science_bills as legiscan_fetch_bills, refresh_tracked_bills as legiscan_refresh_bills
from .sources.news import crawl_news_articles
from .analysis.scoring import score_legislators_batch
from .analysis.pivotal import identify_pivotal_legislators
from .records import build_records, build_scorecard
from .sources.legiscan_votes import fetch_state_votes
from .utils.cache import (
    should_recrawl, update_cache_timestamp,
    save_cached_data, load_cached_data,
)
from .output.writer import write_json_output


async def run_full_crawl(news_only: bool = False):
    """Main entry point. Run the complete crawl and analysis pipeline."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat()
    all_legislators = []

    if not ANTHROPIC_API_KEY:
        print("WARNING: ANTHROPIC_API_KEY not set. Scoring/analysis will be skipped.")

    # ── Step 1: Federal legislators ───────────────────
    if not news_only:
        if should_recrawl("congress_members"):
            print("[1/5] Fetching federal legislators from unitedstates.io...")
            federal = await crawl_congress_members()
            save_cached_data("congress_members", federal)
            update_cache_timestamp("congress_members")
            all_legislators.extend(federal)
        else:
            print("[1/5] Federal legislators cache fresh, loading cached...")
            cached = load_cached_data("congress_members")
            if cached:
                all_legislators.extend(cached)

        # ── Step 2: State legislators (free CSV, all 50 states) ─────
        if should_recrawl("state_legislators"):
            print("[2/5] Fetching state legislators from Open States CSV (all 50 states)...")
            state_legs = await crawl_all_state_legislators()
            if state_legs:
                save_cached_data("state_legislators", state_legs)
                update_cache_timestamp("state_legislators")
            all_legislators.extend(state_legs)
        else:
            print("[2/5] State legislators cache fresh, loading cached...")
            cached = load_cached_data("state_legislators")
            if cached:
                all_legislators.extend(cached)
    else:
        # News-only mode: load cached legislators
        print("[1/5] News-only mode, loading cached legislators...")
        for key in ["congress_members", "state_legislators"]:
            cached = load_cached_data(key)
            if cached:
                all_legislators.extend(cached)
        print(f"  Loaded {len(all_legislators)} cached legislators")
        print("[2/5] Skipped (news-only mode)")

    # ── Step 2b: Bill data (LegiScan primary, Open States fallback) ──
    all_bills: list[dict] = []
    bill_source = "none"
    if not news_only:
        if should_recrawl("bills"):
            previous_bills = load_cached_data("bills") or _read_data_json("bills.json", "bills") or []
            # GovInfo: free federal bills (no API key needed)
            print("[2b/5] Fetching federal bills from GovInfo (free)...")
            all_bills = await fetch_federal_bills()
            bill_source = "govinfo"

            # Also try LegiScan for state bills if key available
            if LEGISCAN_API_KEY:
                print("[2b/5] Also fetching state bills via LegiScan...")
                state_bills = await legiscan_fetch_bills()
                all_bills.extend(state_bills)
                bill_source = "govinfo+legiscan"

            # Fall back to Open States for state bills if no LegiScan
            elif OPENSTATES_API_KEY:
                print("[2b/5] Also fetching state bills via Open States...")
                state_bills = await openstates_fetch_bills()
                all_bills.extend(state_bills)
                bill_source = "govinfo+openstates"

            if all_bills:
                carried = _carry_forward_sponsorships(all_bills, previous_bills)
                if carried:
                    print(f"  Carried forward sponsorships for {carried} bills from the previous run")
                applied = _apply_stance_overrides(all_bills)
                if applied:
                    print(f"  Applied {applied} human-reviewed stance overrides")
                save_cached_data("bills", all_bills)
                update_cache_timestamp("bills")
                print(f"  Fetched {len(all_bills)} bills via {bill_source}")
            else:
                print("[2b/5] No bills found")
        else:
            print("[2b/5] Bills cache fresh, loading cached...")
            cached = load_cached_data("bills")
            if cached:
                all_bills = cached
                bill_source = "cache"
    else:
        # News-only mode: load cached bills
        cached = load_cached_data("bills")
        if cached:
            all_bills = cached
            bill_source = "cache"
            print(f"  Loaded {len(all_bills)} cached bills")

    # ── Step 2c: Refresh tracked bills with latest status ──
    if not news_only and all_bills and LEGISCAN_API_KEY and bill_source != "cache":
        print("[2c/5] Refreshing tracked bill statuses via LegiScan...")
        all_bills = await legiscan_refresh_bills(all_bills)

    # ── Step 2d: Roll-call votes (persisted in data/rollcalls.json; immutable once fetched) ──
    rollcalls = _read_data_json("rollcalls.json") or {"rollcalls": {}, "people": {}}
    if not news_only and all_bills and bill_source != "cache":
        if LEGISCAN_API_KEY:
            print("[2d/5] Fetching state roll-call votes via LegiScan...")
            rollcalls = await fetch_state_votes(all_bills, rollcalls, budget=60)
        try:
            from .sources.federal_votes import fetch_federal_roll_calls
            pointers = []
            for b in all_bills:
                if (b.get("state") or "").upper() != "US":
                    continue
                for rc in b.get("rollCalls", []) or []:
                    if rc.get("key") and rc["key"] not in rollcalls["rollcalls"]:
                        pointers.append(dict(rc, billId=b.get("billId")))
            if pointers:
                print(f"[2d/5] Fetching {len(pointers)} federal roll calls (House Clerk / Senate LIS)...")
                fetched = await fetch_federal_roll_calls(pointers, rollcalls["rollcalls"])
                rollcalls["rollcalls"].update(fetched or {})
                if not fetched:
                    print(f"  ERROR federal votes: {len(pointers)} pointers, 0 fetched. Check federal_votes.py against the Clerk/LIS XML.")
                    rollcalls["last_federal_error"] = {"at": now, "message": f"0 of {len(pointers)} roll calls fetched"}
                else:
                    rollcalls.pop("last_federal_error", None)
        except ImportError:
            print("[2d/5] federal_votes module not available; skipping federal votes")
        except Exception as e:
            # The crawl must not die on a vote-parse failure, but the failure is
            # printed as an ERROR and persisted so it is visible in the data.
            print(f"  ERROR federal votes failed: {type(e).__name__}: {e}")
            rollcalls["last_federal_error"] = {"at": now, "message": f"{type(e).__name__}: {e}"[:300]}

    # ── Step 2d: LLM verification of bill classifications ──
    # Bill classification is NOT done here. The keyword heuristic labels obvious
    # bills; everything else in the science-relevant categories is classified by
    # a Claude Sonnet pass run from Claude Code on the Mac Mini (no API), and
    # those verdicts are carried forward above. Nothing in CI calls an LLM.
        if all_bills:
            save_cached_data("bills", all_bills)

    # ── Step 3: News crawl ────────────────────────────
    print("[3/5] Fetching news from Google News RSS...")
    legislator_names = [leg.get("name", "") for leg in all_legislators if leg.get("name")]
    news_articles = await crawl_news_articles(legislator_names)
    save_cached_data("news", news_articles)
    update_cache_timestamp("news")

    # ── Step 4: Claude analysis ───────────────────────
    if not news_only and ANTHROPIC_API_KEY and should_recrawl("analysis"):
        print(f"[4/5] Running persuadability analysis on {len(all_legislators)} legislators...")
        scores = await score_legislators_batch(all_legislators, news_articles)

        # Merge scores back into legislator data
        score_map = {s["legislator_id"]: s for s in scores}
        for leg in all_legislators:
            lid = leg.get("legislator_id", "")
            if lid in score_map:
                leg["persuadability"] = score_map[lid]

        # Update cached legislator data with scores
        federal = [l for l in all_legislators if l.get("level") == "Federal"]
        state = [l for l in all_legislators if l.get("level") == "State"]
        if federal:
            save_cached_data("congress_members", federal)
        if state:
            save_cached_data("state_legislators", state)

        update_cache_timestamp("analysis")
    else:
        reason = "no ANTHROPIC_API_KEY" if not ANTHROPIC_API_KEY else "cache fresh or news-only"  # noqa: E501
        print(f"[4/5] Skipping analysis ({reason})")

    # ── Step 5: Identify pivotal targets & write output ──
    print("[5/5] Identifying pivotal targets and writing output...")
    pivotal = identify_pivotal_legislators(all_legislators)
    analysis = _build_analysis_summary(all_legislators, now)

    output_files = {
        "news.json": {
            "generated_at": now,
            "articles": news_articles,
        },
    }

    # Only write legislator/analysis/pivotal data if we actually have legislators
    # (news-only mode on CI has no cache, so all_legislators would be empty)
    if all_legislators:
        output_files["legislators.json"] = {
            "generated_at": now,
            "legislators": [_serialize_legislator(l) for l in all_legislators],
        }
        output_files["analysis.json"] = analysis
        output_files["pivotal.json"] = {
            "generated_at": now,
            "targets": pivotal,
        }
    elif not news_only:
        print("WARNING: No legislators found during full crawl — skipping legislators.json write")
    else:
        print("INFO: News-only mode — preserving existing legislators.json")

    # Include bill data if available
    if all_bills:
        output_files["bills.json"] = {
            "generated_at": now,
            "source": bill_source,
            "total": len(all_bills),
            "bills": all_bills,
        }

    # Legislative records: who sponsored which tracked bills (public, neutral).
    # Full crawls only: a news-only run has no fresh bill data and must not
    # overwrite a good records file with cached data and a new timestamp.
    if not news_only and all_bills and all_legislators:
        seats_doc = load_cached_data("seats")
        if not seats_doc:
            try:
                with open(DATA_DIR / "seats.json", encoding="utf-8") as fh:
                    seats_doc = json.load(fh)
            except Exception:
                seats_doc = None
        seats = (seats_doc or {}).get("seats", []) if isinstance(seats_doc, dict) else (seats_doc or [])
        records, unmatched = build_records(all_bills, all_legislators, seats, rollcalls)
        records["generated_at"] = now
        output_files["records.json"] = records
        rollcalls["generated_at"] = now
        output_files["rollcalls.json"] = rollcalls
        scorecard = build_scorecard(records)
        scorecard["generated_at"] = now
        output_files["scorecard.json"] = scorecard
        output_files["records-unmatched.json"] = {"generated_at": now, "count": len(unmatched), "unmatched": unmatched}
        s = records["summary"]
        print(f"  Records: {s['with_records']} legislators with sponsorships, {s['sponsorships']} sponsorships matched, {s['unmatched']} unmatched")
    elif not news_only:
        print("INFO: records.json not rebuilt (missing bills or legislators); existing file preserved")

    write_json_output(DATA_DIR, output_files)

    bill_msg = f", {len(all_bills)} bills" if all_bills else ""
    print(f"\nDone! {len(all_legislators)} legislators, {len(news_articles)} articles{bill_msg}, {len(pivotal)} pivotal targets")
    print(f"Output: {DATA_DIR}")


def _read_data_json(name: str, key: str | None = None):
    """Read a committed data file (the only state that persists across CI runs)."""
    try:
        with open(DATA_DIR / name, encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception:
        return None
    if key and isinstance(doc, dict):
        return doc.get(key)
    return doc


def _apply_stance_overrides(bills: list[dict]) -> int:
    """Human review wins over every automated classification.

    data/stance-overrides.json is written from the review queue, never by the
    crawler: {"overrides": {"<billId>": {"billType": "pro|anti|monitor", "note": "...", "reviewed_at": "..."}}}
    """
    path = DATA_DIR / "stance-overrides.json"
    if not path.exists():
        return 0
    try:
        overrides = json.loads(path.read_text()).get("overrides", {})
    except (OSError, ValueError) as exc:
        print(f"  WARNING: could not read stance overrides: {exc}")
        return 0
    stance_for = {"pro": "Support", "anti": "Oppose", "monitor": "Monitor"}
    applied = 0
    for b in bills:
        ov = overrides.get(b.get("billId"))
        if not ov or ov.get("billType") not in stance_for:
            continue
        b["billType"] = ov["billType"]
        b["stance"] = stance_for[ov["billType"]]
        b["review"] = {k: ov[k] for k in ("note", "reviewed_at", "reviewer") if k in ov}
        applied += 1
    return applied


def _carry_forward_sponsorships(fresh: list[dict], previous: list[dict]) -> int:
    """Copy sponsorship data gathered in earlier runs onto this run's bills.

    Search results never carry sponsors; only the capped getBill calls do.
    Without this, every run threw away what the last one fetched.
    """
    prev_by_id = {b.get("billId"): b for b in previous if isinstance(b, dict) and b.get("billId")}
    carried = 0
    for b in fresh:
        if b.get("sponsorships"):
            continue
        p = prev_by_id.get(b.get("billId"))
        if not p or not p.get("sponsorships"):
            continue
        b["sponsorships"] = p["sponsorships"]
        if not b.get("sponsor") and p.get("sponsor"):
            b["sponsor"] = p["sponsor"]
        carried += 1
    # LLM verdicts are expensive and sticky: if the title is unchanged, the
    # previous run's classification (and its verification record) wins over
    # this run's keyword heuristic. Without this, every upgrade would be
    # undone the next night.
    for b in fresh:
        p = prev_by_id.get(b.get("billId"))
        if not p or not p.get("verification"):
            continue
        if (p.get("title") or "").strip() == (b.get("title") or "").strip():
            b["verification"] = p["verification"]
            b["billType"] = p.get("billType", b.get("billType"))
            b["stance"] = p.get("stance", b.get("stance"))
    # Roll-call summaries and session ids are enrichment-only too.
    for b in fresh:
        p = prev_by_id.get(b.get("billId"))
        if not p:
            continue
        if not b.get("rollCalls") and p.get("rollCalls"):
            b["rollCalls"] = p["rollCalls"]
        if not b.get("session_id") and p.get("session_id"):
            b["session_id"] = p["session_id"]
    return carried


def _serialize_legislator(leg: dict) -> dict:
    """Ensure legislator dict is JSON-serializable with all expected keys."""
    return {
        "legislator_id": leg.get("legislator_id", ""),
        "bioguide_id": leg.get("bioguide_id", ""),
        "name": leg.get("name", ""),
        "party": leg.get("party", ""),
        "state": leg.get("state", ""),
        "district": leg.get("district"),
        "chamber": leg.get("chamber", ""),
        "level": leg.get("level", ""),
        "office": leg.get("office", ""),
        "committees": leg.get("committees", []),
        "contact": leg.get("contact", {}),
        "professional_background": leg.get("professional_background"),
        "photo_url": leg.get("photo_url"),
        "bio_summary": leg.get("bio_summary"),
        "voting_record_summary": leg.get("voting_record_summary"),
        "persuadability": leg.get("persuadability"),
        "pivotal": leg.get("pivotal", {
            "is_committee_chair": False,
            "is_health_committee": False,
            "has_science_background": False,
            "background_type": None,
            "is_ranking_member": False,
            "committee_relevance": None,
        }),
        "source_urls": leg.get("source_urls", []),
        "last_crawled": leg.get("last_crawled", ""),
    }


def _build_analysis_summary(legislators: list[dict], now: str) -> dict:
    """Build the analysis summary with category counts and state breakdowns."""
    by_category = {
        "champion": 0, "likely-win": 0, "fence-sitter": 0,
        "unlikely": 0, "opposed": 0, "unscored": 0,
    }
    state_data: dict[str, dict] = {}

    for leg in legislators:
        cat = (leg.get("persuadability") or {}).get("category", "unscored")
        by_category[cat] = by_category.get(cat, 0) + 1

        state = leg.get("state", "XX")
        if state not in state_data:
            state_data[state] = {"total": 0, "fence_sitters": 0, "champions": 0, "opposed": 0}
        state_data[state]["total"] += 1
        if cat == "fence-sitter":
            state_data[state]["fence_sitters"] += 1
        elif cat == "champion":
            state_data[state]["champions"] += 1
        elif cat == "opposed":
            state_data[state]["opposed"] += 1

    # Top outreach targets: fence-sitters sorted by score descending
    fence_sitters = [
        l for l in legislators
        if (l.get("persuadability") or {}).get("category") == "fence-sitter"
    ]
    fence_sitters.sort(
        key=lambda l: (l.get("persuadability") or {}).get("score", 0),
        reverse=True,
    )
    top_targets = [l.get("legislator_id", "") for l in fence_sitters[:20]]

    return {
        "generated_at": now,
        "total_legislators": len(legislators),
        "by_category": by_category,
        "top_outreach_targets": top_targets,
        "state_summaries": state_data,
    }


def cli():
    """CLI entry point."""
    news_only = "--news-only" in sys.argv
    if news_only:
        print("Running in NEWS-ONLY mode (skipping legislator crawl and analysis)")
    asyncio.run(run_full_crawl(news_only=news_only))


if __name__ == "__main__":
    cli()
