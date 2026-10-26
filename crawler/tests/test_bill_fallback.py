"""LegiScan quota handling, daily budget, carry-forward and the Open States refresh.

Background: the LegiScan key ran out on 2026-10-11 (10,000 queries a month,
the crawler spent ~1,000 a day). Every full crawl after that searched 612
times into a quota error, wrote bills.json with only the 87 federal bills and
crashed before the commit, so the site kept two-week-old data. No network here.
"""
import asyncio
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crawler.config import PRIORITY_STATES  # noqa: E402
from crawler.sources import legiscan, openstates  # noqa: E402
from crawler.main import _merge_previous_bills, _bill_count_floor  # noqa: E402

QUOTA_MSG = ("API key has exceeded maximum query count for October 2026 (10,022 of 10,000); "
             "limit resets November 1st")


@pytest.fixture(autouse=True)
def fresh_run(monkeypatch):
    monkeypatch.setattr(legiscan, "RUN", {"calls": 0, "errors": 0, "quota_error": None, "searched_states": []})

    async def no_wait(*a, **k):
        return None
    monkeypatch.setattr(legiscan.rate_limiter, "wait", no_wait)
    monkeypatch.setattr(legiscan, "LEGISCAN_API_KEY", "test")


class FakeResp:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self.body


class FakeClient:
    def __init__(self, body):
        self.body, self.calls = body, 0

    async def get(self, *a, **k):
        self.calls += 1
        return FakeResp(self.body)


# ── LegiScan quota and budget ────────────────────────────────────────────

def test_quota_error_stops_all_later_calls():
    client = FakeClient({"status": "ERROR", "alert": {"message": QUOTA_MSG}})
    assert asyncio.run(legiscan._api_call(client, "getSearch", state="TX", query="vaccine")) is None
    assert legiscan.quota_exhausted()
    assert "exceeded maximum query count" in legiscan.RUN["quota_error"]
    for _ in range(5):
        assert asyncio.run(legiscan._api_call(client, "getBill", id=1)) is None
    assert client.calls == 1          # no HTTP after the quota error


def test_other_api_errors_do_not_trip_the_quota_flag():
    client = FakeClient({"status": "ERROR", "alert": {"message": "Unknown bill id"}})
    asyncio.run(legiscan._api_call(client, "getBill", id=1))
    asyncio.run(legiscan._api_call(client, "getBill", id=2))
    assert not legiscan.quota_exhausted() and client.calls == 2


def test_search_under_quota_returns_nothing_and_marks_no_state_searched():
    async def quota_call(client, op, **params):
        legiscan.RUN["quota_error"] = QUOTA_MSG
        return None
    legiscan._api_call_orig = legiscan._api_call
    try:
        legiscan._api_call = quota_call
        bills = asyncio.run(legiscan.fetch_all_science_bills(["TX", "CA"]))
    finally:
        legiscan._api_call = legiscan._api_call_orig
    assert bills == []
    assert legiscan.RUN["searched_states"] == []


def test_search_slice_covers_every_state_once_a_week():
    start = date(2026, 11, 1)
    seen = []
    for d in range(legiscan.SEARCH_ROTATION_DAYS):
        seen += legiscan.search_slice(PRIORITY_STATES, start + timedelta(days=d))
    assert sorted(seen) == sorted(PRIORITY_STATES)


def test_daily_budget_fits_the_monthly_cap():
    biggest_slice = max(len(legiscan.search_slice(PRIORITY_STATES, date(2026, 11, 1) + timedelta(days=d)))
                        for d in range(legiscan.SEARCH_ROTATION_DAYS))
    per_day = (len(legiscan.SEARCH_QUERIES) * biggest_slice + legiscan.ENRICH_CAP
               + legiscan.REFRESH_CAP + legiscan.VOTES_BUDGET)
    assert per_day <= legiscan.DAILY_BUDGET <= 260
    assert legiscan.DAILY_BUDGET * 31 <= 8000      # 10,000 cap with headroom for manual runs


# ── Carry-forward ────────────────────────────────────────────────────────

def _b(bid, state, **kw):
    return dict({"billId": bid, "state": state, "billNumber": bid.split("-", 1)[1], "title": "t"}, **kw)


def test_merge_keeps_unsearched_states_and_drops_searched_ones():
    fresh = [_b("US-HR1", "US"), _b("TX-HB1", "TX", status="Passed One Chamber")]
    previous = [_b("US-HR1", "US"), _b("TX-HB1", "TX"), _b("TX-HB2", "TX"), _b("CA-AB5", "CA"), _b("MN-SF694", "MN")]
    kept = _merge_previous_bills(fresh, previous, {"US", "TX"})
    ids = [b["billId"] for b in fresh]
    assert kept == 2 and "CA-AB5" in ids and "MN-SF694" in ids
    assert "TX-HB2" not in ids                                         # TX was fully searched
    assert next(b for b in fresh if b["billId"] == "TX-HB1")["status"] == "Passed One Chamber"  # fresh wins


def test_merge_under_quota_keeps_every_state_bill():
    fresh = [_b("US-HR1", "US")]
    previous = [_b("US-HR1", "US")] + [_b(f"TX-HB{i}", "TX") for i in range(50)]
    assert _merge_previous_bills(fresh, previous, {"US"}) == 50
    assert len(fresh) == 51


def test_count_floor_restores_previous_bills():
    previous = [_b(f"TX-HB{i}", "TX") for i in range(100)]
    fresh = previous[:10]
    assert _bill_count_floor(fresh, previous) == 90 and len(fresh) == 100
    assert _bill_count_floor(previous[:60], previous) == 0


# ── Open States refresh ──────────────────────────────────────────────────

def test_identifier_formats():
    assert openstates.os_query_ident("HB4535") == "HB 4535"
    assert openstates.os_query_ident("SF 0694") == "SF 694"
    assert openstates.os_query_ident("B26-0414") == "B26-0414"
    assert openstates.os_ident_key("HB 0123") == openstates.os_ident_key("hb123")
    assert openstates.os_jurisdiction("mn") == "ocd-jurisdiction/country:us/state:mn/government"
    assert openstates.os_jurisdiction("DC") == "District of Columbia"


MN_BILL = {"billId": "MN-HF3239", "state": "MN", "billNumber": "HF3239", "level": "State",
           "title": "Use of an exemption to immunization due to conscientiously held beliefs prohibited.",
           "status": "In Committee", "isActive": "Yes", "billType": "pro",
           "lastAction": "Referred", "lastActionDate": "2026-02-01", "sponsorships": []}

OS_CURRENT = {"identifier": "HF 3239", "session": "2025-2026", "latest_action_date": "2026-03-23",
              "latest_action_description": "Author added Lee, F.",
              "title": "Use of an exemption to immunization due to conscientiously held beliefs for immunization against measles, mumps, and rubella prohibited.",
              "openstates_url": "https://openstates.org/mn/bills/2025-2026/HF3239/",
              "sponsorships": [{"name": "Lee", "entity_type": "person", "primary": True,
                                "person": {"id": "ocd-person/x", "name": "Fue Lee", "party": "Democratic-Farmer-Labor",
                                           "current_role": {"org_classification": "lower", "district": "59A"}}}]}
OS_OLD_SESSION = {"identifier": "HF 3239", "session": "2023-2024", "latest_action_date": "2026-04-01",
                  "latest_action_description": "Introduction", "title": "Mabel; emergency services facility funding provided"}


def test_pick_rejects_same_number_from_another_session():
    assert openstates.os_pick([OS_OLD_SESSION, OS_CURRENT], MN_BILL) is OS_CURRENT
    assert openstates.os_pick([OS_OLD_SESSION], MN_BILL) is None


def test_apply_update_moves_forward_only_and_fills_missing_sponsors():
    b = dict(MN_BILL, sponsorships=[])
    assert openstates.apply_os_update(b, OS_CURRENT, "2026-10-25T00:00:00+00:00")
    assert b["lastActionDate"] == "2026-03-23" and b["lastAction"] == "Author added Lee, F."
    assert b["status"] == "In Committee"              # no status words: never downgraded to Introduced
    assert b["sponsorships"][0]["name"] == "Fue Lee" and b["sponsorships"][0]["role"] == "Rep"
    assert b["sponsorships"][0]["district"] == "59A" and b["statusSource"] == "openstates"

    newer = dict(MN_BILL, lastActionDate="2026-05-01", lastAction="Signed by governor",
                 sponsorships=[{"name": "X", "people_id": 1}])
    openstates.apply_os_update(newer, OS_CURRENT, "2026-10-25T00:00:00+00:00")
    assert newer["lastActionDate"] == "2026-05-01"    # older Open States action ignored
    assert newer["sponsorships"] == [{"name": "X", "people_id": 1}]   # LegiScan sponsors kept


def test_plan_batches_caps_groups_and_prioritises():
    bills = [_b(f"TX-HB{i}", "TX", billType="monitor", isActive="Yes", level="State") for i in range(45)]
    bills += [_b("TX-SB1", "TX", billType="anti", isActive="Yes", level="State"),
              _b("US-HR1", "US", level="Federal"), _b("CA-AB1", "CA", billType="monitor", isActive="No", level="State")]
    batches = openstates.plan_os_batches(bills, skip_ids={"TX-HB0"}, cap=10)
    assert all(len(b) <= openstates.OS_IDS_PER_CALL for _, b in batches)
    flat = [x["billId"] for _, b in batches for x in b]
    assert "US-HR1" not in flat and "TX-HB0" not in flat
    assert batches[0][1][0]["billId"] == "TX-SB1"      # stance bill first
    assert len(flat) == 46                            # 45 TX (minus skipped) + SB1 + CA
    assert len(openstates.plan_os_batches(bills, set(), cap=1)) == 1


def _run_refresh(bills, responses, cap=10):
    calls = []

    async def fetch(params):
        calls.append(params)
        r = responses[min(len(calls) - 1, len(responses) - 1)]
        return r

    async def no_sleep(*a, **k):
        return None
    orig = asyncio.sleep
    asyncio.sleep = no_sleep
    try:
        stats = asyncio.run(openstates.refresh_bills_from_openstates(bills, cap=cap, fetch=fetch))
    finally:
        asyncio.sleep = orig
    return stats, calls


def test_refresh_updates_bills_and_reports_ok():
    bills = [dict(MN_BILL, sponsorships=[])]
    stats, calls = _run_refresh(bills, [(200, {"results": [OS_CURRENT], "pagination": {"max_page": 1}}, {})])
    assert stats["status"] == "ok" and stats["updated"] == 1 and stats["calls"] == 1
    params = dict(p for p in calls[0] if p[0] != "identifier")
    assert ("identifier", "HF 3239") in calls[0] and params["action_since"] == "2026-01-25"
    assert bills[0]["lastActionDate"] == "2026-03-23"


def test_refresh_stops_on_rate_limit_and_says_so():
    bills = [_b(f"{st}-HB1", st, level="State") for st in ("TX", "CA", "MN", "WA")]
    stats, calls = _run_refresh(bills, [(429, None, {})])
    assert stats["status"] == "failed" and "429" in stats["error"] and len(calls) == 1


def test_refresh_breaker_after_repeated_errors():
    bills = [_b(f"{st}-HB1", st, level="State") for st in ("TX", "CA", "MN", "WA", "OR")]
    stats, calls = _run_refresh(bills, [(500, None, {})])
    assert stats["status"] == "failed" and len(calls) == openstates.OS_BREAKER


def test_refresh_without_key_is_reported(monkeypatch):
    monkeypatch.setattr(openstates, "OPENSTATES_API_KEY", "")
    stats = asyncio.run(openstates.refresh_bills_from_openstates([dict(MN_BILL)]))
    assert stats["status"] == "no_key" and stats["calls"] == 0
