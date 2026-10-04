#!/usr/bin/env python3
"""Decide bill stances without a human queue: three independent signals must agree.

Signals for each candidate bill (anything the judge model or the crawler thinks is on topic):
  1. judge   - data/stance-judge.json (bulk-role judge tier, exact-quote checked)
  2. text    - a TF-IDF + logistic-regression model trained on the bills already decided in
               data/stance-overrides.json; it learns the phrasing of anti- and pro-science bills
               and gets stronger as more bills are decided (Greg, 2026-10-04)
  3. sponsor - the sponsors' record on their OTHER decided bills (one-sided: >= 2 one way, 0 the other)

Rules (a vote is pro / anti / none):
  - decide when at least two signals vote the same way and none votes the other way
    (the crawler's own label counts as a second vote only alongside the judge)
  - "watch" when the bill's own words (judge or text model) point one way and the sponsors'
    record points hard the other way (>= 3 opposite, 0 same): e.g. WV HB 4146, a staff
    vaccination mandate from sponsors with 7 anti-vaccine bills. Not counted; flagged on /live.
  - otherwise no decision. A bill the crawler labeled pro/anti that no signal confirms is set to
    monitor (not counted) instead of being shown on air unreviewed.
Hand decisions (reviewer != consensus) are never changed. Labels apply to bills, never to people.

usage: python3 scripts/stance_consensus.py [--write]
"""
import argparse, json, datetime as dt
from collections import Counter, defaultdict
from pathlib import Path

ap = argparse.ArgumentParser(); ap.add_argument('--write', action='store_true'); ap.add_argument('--repo', default='.')
a = ap.parse_args(); R = Path(a.repo)
bills = {b['billId']: b for b in json.loads((R / 'data/bills.json').read_text())['bills']}
judge = json.loads((R / 'data/stance-judge.json').read_text())['verdicts']
ovf = R / 'data/stance-overrides.json'
OV = json.loads(ovf.read_text()); ov = OV['overrides']
hand = {k: v for k, v in ov.items() if v.get('reviewer') != 'consensus'}
text_of = lambda b: f"{b.get('title', '')} {b.get('summary', '')}".strip()

# ---- signal 3: sponsor record, from hand decisions plus confident judge verdicts on other bills
known = {k: v['billType'] for k, v in hand.items() if v['billType'] in ('pro', 'anti')}
for k, v in judge.items():
    if k not in known and v.get('label') in ('pro', 'anti') and v.get('evidence_ok'):
        known[k] = v['label']
rec = defaultdict(Counter)
for k, t in known.items():
    b = bills.get(k, {})
    for s in b.get('sponsorships') or []:
        if s.get('name'):
            rec[(s['name'], b.get('state'))][t] += 1

def sponsor(bid):
    b = bills.get(bid, {}); c = Counter()
    for s in b.get('sponsorships') or []:
        if s.get('name'):
            x = rec[(s['name'], b.get('state'))].copy()
            if known.get(bid): x[known[bid]] -= 1          # leave the bill's own label out
            c += x
    return c

def sponsor_vote(c):
    if c['anti'] >= 2 and c['pro'] == 0: return 'anti'
    if c['pro'] >= 2 and c['anti'] == 0: return 'pro'
    return None

# ---- signal 2: text model trained on hand decisions (+ bills where judge and sponsor record agree)
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_predict, StratifiedKFold
import hashlib
train = {k: v['billType'] for k, v in hand.items()}
for k, v in judge.items():                       # quote-verified judge labels widen the vocabulary
    if k in train or k not in bills: continue
    lab = v.get('label')
    if lab in ('pro', 'anti') and v.get('evidence_ok'): train[k] = lab
    elif lab in ('neutral', 'irrelevant') and sum(1 for t in train.values() if t == 'monitor') < 1500 and int(hashlib.md5(k.encode()).hexdigest(), 16) % 6 == 0:
        train[k] = 'monitor'                     # a fixed sample of off-target bills
keys = list(train)
X = [text_of(bills[k]) for k in keys]; y = [('other' if train[k] == 'monitor' else train[k]) for k in keys]
vec = TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True, stop_words='english')
M = vec.fit_transform(X)
clf = LogisticRegression(max_iter=3000, class_weight='balanced', C=4)
# out-of-fold probabilities: a bill in the training set is scored by a model that never saw it,
# so the text vote stays a separate signal from the judge label it was trained on
oof = cross_val_predict(clf, M, y, cv=StratifiedKFold(5, shuffle=True, random_state=0), method='predict_proba')
clf.fit(M, y)
OOF = {k: dict(zip(clf.classes_, p)) for k, p in zip(keys, oof)}
hy = [(train[k], max(OOF[k], key=OOF[k].get)) for k in keys if k in hand and train[k] in ('pro', 'anti')]
cv = [sum(1 for t, pr in zip(y, oof) if t == clf.classes_[pr.argmax()]) / len(y)]
print(f'text model: {len(y)} training bills {dict(Counter(y))}, out-of-fold accuracy {cv[0]:.2f}; on hand-decided pro/anti: {sum(1 for t, p in hy if t == p)}/{len(hy)} correct')

def text_vote(bid):
    p = OOF.get(bid) or dict(zip(clf.classes_, clf.predict_proba(vec.transform([text_of(bills[bid])]))[0]))
    lab = max(p, key=p.get)
    return (lab if lab in ('pro', 'anti') and p[lab] >= 0.75 else None), float(p[lab])

# ---- decide
cands = {k for k, v in judge.items() if v.get('label') in ('pro', 'anti', 'UNSURE')} | \
        {k for k, b in bills.items() if b.get('billType') in ('pro', 'anti')}
now = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
new, stats = {}, Counter()
for k in sorted(cands):
    if k in hand or k not in bills: continue
    j = judge.get(k, {}); jv = j.get('label') if j.get('label') in ('pro', 'anti') and j.get('evidence_ok') else None
    tv, tp = text_vote(k); sc = sponsor(k); sv = sponsor_vote(sc)
    votes = [v for v in (jv, tv, sv) if v]
    own = jv or tv
    if own and ((own == 'pro' and sc['anti'] >= 3 and sc['pro'] == 0) or (own == 'anti' and sc['pro'] >= 3 and sc['anti'] == 0)):
        new[k] = {'billType': 'monitor', 'watch': True, 'basis': 'consensus',
                  'note': f"One to watch: text reads {own}, sponsors' other bills are {sc['anti']} anti / {sc['pro']} pro"}
        stats['watch'] += 1; continue
    top = Counter(votes).most_common(1)
    if top and top[0][1] >= 2 and len(set(votes)) == 1:
        t = top[0][0]
        new[k] = {'billType': t, 'basis': 'consensus',
                  'note': f"judge={jv or '-'} text={tv or '-'}({tp:.2f}) sponsors={sc['anti']}a/{sc['pro']}p" + (f"; {j.get('reason')}" if j.get('reason') else '')}
        stats[f'decided {t}'] += 1
    elif jv and jv == bills[k].get('billType') and not (tv and tv != jv) and not (sv and sv != jv):
        new[k] = {'billType': jv, 'basis': 'consensus',
                  'note': f"judge and crawler agree ({jv}); text={tv or '-'} sponsors={sc['anti']}a/{sc['pro']}p" + (f"; {j.get('reason')}" if j.get('reason') else '')}
        stats[f'kept {jv} (judge + crawler)'] += 1
    elif bills[k].get('billType') in ('pro', 'anti'):
        new[k] = {'billType': 'monitor', 'basis': 'consensus',
                  'note': f"Crawler said {bills[k]['billType']}; not confirmed (judge={jv or '-'} text={tv or '-'} sponsors={sc['anti']}a/{sc['pro']}p)"}
        stats['unconfirmed crawler label -> monitor'] += 1
    else:
        stats['left undecided (not counted)'] += 1
for v in new.values(): v.update(reviewer='consensus', reviewed_at=now)
print(dict(stats))
if a.write:
    OV['overrides'] = {**{k: v for k, v in ov.items() if v.get('reviewer') != 'consensus'}, **new}
    ovf.write_text(json.dumps(OV, indent=1))
    print('wrote', ovf, len(OV['overrides']), 'overrides')
