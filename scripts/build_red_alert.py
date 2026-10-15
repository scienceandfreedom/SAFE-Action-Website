#!/usr/bin/env python3
"""Draft the weekly Red Alert from the tracker data. Never sends anything.

Picks reviewed bills SAFE supports or opposes that had a recorded action in the
window (default: last 7 days), and writes three files for a human to approve:
alert.md (social post text), alert.html (email body) and alert.json (the picks).

Rules that keep it inside the c4's adopted guardrails:
- Only bills with a review record (human or orchestrator) are eligible.
- Labels describe bills, never people; no sponsor names, no candidates, no election talk.
- Every bill links to the Take Action page and, when known, the official source.
- The email footer carries the mailing address and an unsubscribe placeholder.

If nothing moved in the window, --sample N builds a clearly marked SAMPLE from the
N most recently acted reviewed bills, for demos and template review.

Usage:
  python3 scripts/build_red_alert.py --out /tmp/red-alert [--days 7] [--as-of 2026-10-15] [--sample 3]
"""
import argparse
import datetime as dt
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://scienceandfreedom.com"
MAX_BILLS = 3
FOOTER_ADDRESS = "1119 S Mission Rd, PMB 316, Fallbrook, CA 92028"
FINISHED = re.compile(r"chaptered|signed by (the )?governor|became law|enacted|public law|published|adopted|vetoed|failed|died|withdrawn|indefinitely postponed", re.I)
STATUS_RANK = {"passed": 4, "enrolled": 4, "engrossed": 3, "floor": 3, "committee": 2, "introduced": 1}


def day(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def stance(b):
    s = (b.get("stance") or "").lower()
    return "oppose" if s in ("oppose", "anti") else "support" if s in ("support", "pro") else None


def progress(b):
    text = f"{b.get('status', '')} {b.get('lastAction', '')}".lower()
    return max((v for k, v in STATUS_RANK.items() if k in text), default=0)


def what_it_does(b, headlines):
    h = headlines.get(b["billId"], {}).get("headline")
    summary = (b.get("summary") or "").strip()
    note = re.sub(r"\s*\(sponsors:[^)]*\)", "", ((b.get("review") or {}).get("note") or "")).strip()
    note = re.sub(r"^(?:\w+=\S+\s*)+;\s*", "", note)  # drop internal scoring prefix like "judge=pro text=pro(0.87) sponsors=0a/2p;"
    detail = summary if summary and summary.lower() != (b.get("title") or "").lower() else note
    return h or b.get("title") or b["billNumber"], detail


def pick(bills, as_of, days, sample):
    eligible = [b for b in bills if stance(b) and b.get("review") and str(b.get("isActive", "Yes")).lower() != "no"]
    def recent(b):
        d = day(b.get("lastActionDate"))
        return d is not None and 0 <= (as_of - d).days <= days
    moved = [b for b in eligible if recent(b)]
    is_sample = False
    if not moved and sample:
        live = [b for b in eligible if day(b.get("lastActionDate")) and not FINISHED.search(f"{b.get('status', '')} {b.get('lastAction', '')}")]
        live.sort(key=lambda b: (stance(b) != "oppose", -day(b["lastActionDate"]).toordinal()))
        moved = live[:sample]
        is_sample = True
    moved.sort(key=lambda b: (stance(b) != "oppose", -progress(b), -(day(b.get("lastActionDate")).toordinal())))
    done = lambda b: bool(FINISHED.search(f"{b.get('status', '')} {b.get('lastAction', '')}"))
    return [b for b in moved if not done(b)][:MAX_BILLS], [b for b in moved if done(b)], is_sample


def build(picks, finished, is_sample, headlines, as_of, days):
    items = []
    for b in picks:
        head, detail = what_it_does(b, headlines)
        verb = "opposes" if stance(b) == "oppose" else "supports"
        ask = "Ask your legislators to vote no." if stance(b) == "oppose" else "Ask your legislators to vote yes."
        where = "Congress" if b.get("state") == "US" else b.get("state")
        items.append({
            "billId": b["billId"], "label": f"{where} {b['billNumber']}", "headline": head, "detail": detail,
            "stance": verb, "ask": ask, "status": b.get("status") or "", "lastAction": b.get("lastAction") or "",
            "lastActionDate": str(b.get("lastActionDate"))[:10], "committee": b.get("committee") or "",
            "action_url": f"{SITE}/action?bill={b['billId']}", "source_url": b.get("url") or "",
        })
    tag = "SAMPLE (built from older activity for template review)" if is_sample else f"Activity {as_of - dt.timedelta(days=days)} to {as_of}"
    also = []
    for b in finished:
        head, _ = what_it_does(b, headlines)
        where = "Congress" if b.get("state") == "US" else b.get("state")
        also.append(f"{where} {b['billNumber']} ({head}), a bill SAFE Action {'opposed' if stance(b) == 'oppose' else 'supported'}: {b.get('lastAction')} ({str(b.get('lastActionDate'))[:10]}).")
    subject = f"Red Alert: {items[0]['label']}, {items[0]['headline']}" if items else "Red Alert: nothing moved this week"

    md = [f"DRAFT, needs approval before posting. {tag}", "", f"**{subject}**", ""]
    for i in items:
        md += [f"**{i['label']}: {i['headline']}**", f"SAFE Action {i['stance']} this bill.",
               *( [i["detail"]] if i["detail"] else [] ),
               f"Latest: {i['lastAction']} ({i['lastActionDate']}).",
               *( [f"Who decides next: {i['committee']}."] if i["committee"] else [] ),
               f"{i['ask']} Find yours and send a message: {i['action_url']}", ""]
    if also:
        md += ["Also recently:" if is_sample else "Also this week:", *[f"- {x}" for x in also], ""]
    md += ["Published by SAFE Action, a 501(c)(4) social welfare organization. We track bills, not people."]

    e = html.escape
    cards = "".join(
        f"""<tr><td style="padding:16px 0;border-top:1px solid #dad7cc">
<p style="margin:0;font:600 13px Arial,sans-serif;letter-spacing:1px;color:#b23a3a;text-transform:uppercase">{e(i['label'])} · SAFE Action {e(i['stance'])} this bill</p>
<p style="margin:6px 0;font:700 20px Arial,sans-serif;color:#14213d">{e(i['headline'])}</p>
{f'<p style="margin:6px 0;font:15px Arial,sans-serif;color:#33415c">{e(i["detail"])}</p>' if i['detail'] else ''}
<p style="margin:6px 0;font:15px Arial,sans-serif;color:#33415c">Latest: {e(i['lastAction'])} ({e(i['lastActionDate'])}){f'. Who decides next: {e(i["committee"])}' if i['committee'] else ''}.</p>
<p style="margin:12px 0 0"><a href="{e(i['action_url'])}" style="display:inline-block;background:#b23a3a;color:#fbf4f2;font:700 15px Arial,sans-serif;padding:10px 18px;border-radius:6px;text-decoration:none">{e(i['ask'])} Take action</a>
{f' &nbsp;<a href="{e(i["source_url"])}" style="font:14px Arial,sans-serif;color:#2f5d9f">Official bill page</a>' if i['source_url'] else ''}</p>
</td></tr>""" for i in items)
    body = f"""<!doctype html><html><body style="margin:0;background:#f7f6f1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f1"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fbfbf8;border:1px solid #dad7cc">
<tr><td style="background:#ffe9a8;padding:8px 24px;font:600 13px Arial,sans-serif;color:#14213d">DRAFT, needs approval before sending. {e(tag)}</td></tr>
<tr><td style="background:#14213d;padding:20px 24px"><p style="margin:0;font:700 26px Arial,sans-serif;color:#f7f6f1;letter-spacing:1px">RED ALERT</p>
<p style="margin:4px 0 0;font:15px Arial,sans-serif;color:#c9d3e6">Science bills that moved this week, and who to contact</p></td></tr>
<tr><td style="padding:8px 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{cards or '<tr><td style="padding:16px 0;font:15px Arial,sans-serif">Nothing we track moved this week.</td></tr>'}</table></td></tr>
{''.join(f'<tr><td style="padding:0 24px 12px;font:14px Arial,sans-serif;color:#33415c">{"Also recently" if is_sample else "Also this week"}: {e(x)}</td></tr>' for x in also)}
<tr><td style="padding:16px 24px;background:#eceae2;font:12px Arial,sans-serif;color:#4a5568;line-height:1.5">
Published by SAFE Action (Science and Freedom for Everyone Action Fund), a 501(c)(4) social welfare organization. We label bills, never people, and we do not support or oppose candidates.<br>
{e(FOOTER_ADDRESS)}<br>You are getting this because you joined the SAFE Action list. <a href="{{{{unsubscribe_url}}}}" style="color:#2f5d9f">Unsubscribe</a>
</td></tr></table></td></tr></table></body></html>"""
    return subject, "\n".join(md), body, items, also


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--as-of", default=dt.date.today().isoformat())
    ap.add_argument("--sample", type=int, default=0)
    a = ap.parse_args()
    as_of = dt.date.fromisoformat(a.as_of)
    bills = json.loads((ROOT / "data/bills.json").read_text())["bills"]
    hl_path = ROOT / "data/bill-headlines.json"
    headlines = json.loads(hl_path.read_text()).get("headlines", {}) if hl_path.exists() else {}
    picks, finished, is_sample = pick(bills, as_of, a.days, a.sample)
    subject, md, body, items, also = build(picks, finished, is_sample, headlines, as_of, a.days)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "alert.md").write_text(md + "\n")
    (out / "alert.html").write_text(body)
    (out / "alert.json").write_text(json.dumps({"subject": subject, "sample": is_sample, "as_of": a.as_of, "items": items, "also": also}, indent=2))
    print(f"{'SAMPLE' if is_sample else 'LIVE'} draft: {len(items)} bill(s) -> {out}  subject: {subject}")


if __name__ == "__main__":
    main()
