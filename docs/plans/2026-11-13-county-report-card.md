# County report card: what was built and what comes next

Date: 2026-11-13. Branch: `claude/county-report-card-ce00f9`. Nothing here is pushed or deployed.

## Phase 1 (built): county report card on the Take Action page

A visitor enters an address on `outreach.html`. Below the existing call to action, a card shows:

1. Recent public health data for their county, taken from What's In My County (published by Priori Intelligence): the three headline questions, recent environment readings, and a separate State context block.
2. Active state and federal bills on which the tracker carries a reviewed SAFE Action position (Support or Oppose).
3. The visitor's officials, with a button to the existing contact actions.
4. A link to the full county page and the credit line "Data: What's In My County, published by Priori Intelligence".

### How it works

| Piece | File | Notes |
| --- | --- | --- |
| Data proxy | `functions/county-report.js` | `GET /api/county-report?fips=` or `?state=&kind=&name=`. Reads the data site's static JSON server side, because that site sends no cross-origin headers and this site's Content Security Policy only allows same-origin requests. Returns about 6 KB per county. Cached at the edge for 1 hour on success, never on an outage. |
| County from address | `js/my-reps.js`, `functions/districts.js` | First choice: the county division the Google Civic lookup already returns, matched by state, type and name to exactly one county. Fallback: the Census geocoder behind `/api/districts`, which now also returns the county FIPS code. |
| Card | `js/county-report.js`, `outreach.html` | Built with `textContent` only. Any failure hides or downgrades the card; the representative list never depends on it. |
| Local run | `dev-server.js` | Serves `/api/districts` and `/api/county-report` from the function files. |
| Checks | `scripts/check-county-report.js` | `node scripts/check-county-report.js` (offline) or `--live`. |

### Rules the card keeps

- Sentences and values are shown as the data site wrote them. No grade, score, color alarm or advice.
- A figure the data site tags "state level" is shown only in the State context block, labeled as not a county value. A regional figure carries a "Regional, not this county alone" label.
- A county is shown only when identified exactly. A name that matches zero or two counties shows "could not be matched" instead of a guess.
- Bills: active, with a review record, state equal to the county's state or federal, position Support or Oppose. Labels describe bills, never people; no sponsor names. Bills marked Monitor are counted, not listed.
- The data site's address lives in one constant, `COUNTY_SITE_BASE` in `functions/county-report.js`. A check fails if it appears anywhere else.

### What a deploy would change

A merge to `main` runs `firebase-deploy.yml`, which deploys hosting, Firestore rules and functions. This branch would:

- create one new Cloud Function, `countyReport`, and one new hosting rewrite, `/api/county-report`;
- redeploy the `districts` function with one added response field, `county`;
- publish `js/county-report.js`, the changed `js/my-reps.js`, `js/my-reps-page.js`, `outreach.html` and `sw.js` (cache name `safe-action-v102`).

No Firestore rules, indexes, secrets or Content Security Policy changes. No new third-party browser requests.

Order matters on the first deploy. The workflow deploys hosting (with the new rewrite) before functions, so the rewrite is published before `countyReport` exists. This has not been tested. The card is fail-soft either way, but it may read "County data is unavailable right now" until the function is live and hosting has been deployed once more. The safe sequence is two merges: the function first, then the page and the rewrite.

### Open items for phase 1

- The address sentence on the Take Action page now names the lookup services and says the address is not stored. `privacy.html` still says browser-saved data is "never transmitted to us" and does not list the Census Bureau or OpenStreetMap geocoders; it was left unchanged.
- When `whatsinmycounty.com` is pointed, change `COUNTY_SITE_BASE`.
- Puerto Rico and other territories have no county file; the card says so.

## Phase 2 (not built): counties with elevated outbreak signals

Naming: "Red Alert" already means the weekly bill alert draft (`scripts/build_red_alert.py`, branch `feat/red-alert`). This view needs its own name, for example "Outbreak watch counties", so the two are not confused.

Proposed rule, stated on the page, using only measures the data site already publishes for every county. A county is listed when at least one of these is true:

1. `measles_cases_4wk` is 1 or more (confirmed measles cases in the last 4 weeks).
2. `ww_measles_detected_recent` is detected (measles virus in wastewater, last 2 samples).
3. Any of `ww_covid_trend_4wk`, `ww_flu_a_trend_4wk`, `ww_rsv_trend_4wk` is rising. The data site defines rising as at least a 50 percent increase over 4 weeks.

Each listed county shows which condition it met and the date. No composite score, no ranking across conditions. Counties with no wastewater site are shown as "no wastewater data", not as clear.

Build: extend the proxy with a `list` mode that reads the five `metric/<key>.json` files (about 30 KB each) and returns the matching counties, cached for 1 hour. A new section on `tracker.html` or its own page lists them as a table, each row linking to the county page and to the Take Action lookup. The rule and the name need sign-off before building.

## Phase 3 (not built): admin opportunities view and shared contact log

Held until ownership of the shared log is decided. The design constraint is already fixed: one shared contact record with a cool-off window, not a new log beside the existing ones. This site's per-visitor log (`safe_contact_log` in `js/my-reps-page.js`, which suggests calling after 2 emails in a day) stays as it is.
