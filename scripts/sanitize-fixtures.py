#!/usr/bin/env python3
"""Sanitize telemetry fixtures for the public repo.

Keeps exactly the fields the router (and its tests) consume; strips every
identity/account/billing field. Prints only field NAMES it removed, never values.
"""
import json, re, sys, pathlib

SRC = pathlib.Path(sys.argv[1])
DST = pathlib.Path(sys.argv[2])
DST.mkdir(parents=True, exist_ok=True)

DROP_KEYS = {
    'email', 'signedinemail', 'accountid', 'accountplan', 'orgid', 'orgname', 'userid', 'user',
    'workspaceid', 'workspace', 'openaidashboard', 'creditevents', 'dailybreakdown', 'usagebreakdown',
    'subscriptionrenewsat', 'metadata', 'disabledcredentials', 'accountswithoutusage', 'capacity',
    'credentialid', 'credential', 'cookie', 'token', 'authorization', 'apikey', 'api_key', 'key',
    'details',  # CodexBar free-text detail rows (may carry account-specific labels)
    'description', 'resetdescription',  # human-readable strings; not consumed by router
    'identity', 'plan', 'planname', 'subscription', 'workspaces', 'organization',
    # Account-scoped reset-credit state (grant/expiry bookkeeping); no router code reads it.
    'resetcredits',
}
# CodexBar `usage.details` carries the OpenRouter "Credits" balance the router reads
# (telemetry.ts balanceFromUsage). Keep ONLY that title; drop everything else.
KEEP_DETAIL_TITLES = {'credits'}
WRK = re.compile(r'wrk_[A-Za-z0-9]+')
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}')
removed = set()

def scrub(o, path=''):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k.lower() == 'details' and isinstance(v, list):
                kept = [d for d in v if str(d.get('title', '')).lower() in KEEP_DETAIL_TITLES]
                if len(kept) != len(v): removed.add(path + 'details[title!=Credits]')
                out[k] = scrub(kept, path + k + '.')
                continue
            if k.lower() in DROP_KEYS:
                removed.add(path + k); continue
            out[k] = scrub(v, path + k + '.')
        return out
    if isinstance(o, list):
        return [scrub(x, path + '[].') for x in o]
    if isinstance(o, str):
        if EMAIL.search(o): removed.add(path + '<email-in-string>'); return '<redacted>'
        if WRK.search(o): removed.add(path + '<workspace-id-in-string>'); o = WRK.sub('wrk_<redacted>', o)
        if '/Users/' in o: removed.add(path + '<home-path-in-string>'); o = re.sub(r'/Users/[^/\s"]+', '/Users/<user>', o)
        return o
    return o

def load(p):
    t = p.read_text()
    i = t.find('{') if t.lstrip().startswith('{') or '{' in t[:200] else 0
    j = t.find('[')
    start = min(x for x in (i, j) if x >= 0) if (i >= 0 or j >= 0) else 0
    return json.loads(t[start:])

for name in ('omp-usage.json', 'codexbar-usage.json', 'omp-stats.json', 'models.json',
             'live-omp-usage-2026-09-19.json', 'live-codexbar-2026-09-19.json', 'live-omp-stats-2026-09-19.json',
             'live-omp-models-2026-09-22.json', 'live-omp-usage-2026-09-22.json', 'live-codexbar-2026-09-22.json'):
    src = SRC / name
    if not src.exists(): print(f'skip {name} (absent)'); continue
    data = load(src)
    clean = scrub(data)
    # models.json: keep only routing-relevant model fields
    if name in ('models.json', 'live-omp-models-2026-09-22.json'):
        clean = {'models': [{k: m.get(k) for k in ('provider', 'id', 'selector', 'name', 'cost', 'contextWindow') if k in m} for m in clean['models']]}
    # omp-stats: byModel only (byFolder leaks local project paths)
    if name.endswith('omp-stats.json') or name.endswith('omp-stats-2026-09-19.json'):
        clean = {'overall': clean.get('overall', {}), 'byModel': clean.get('byModel', [])}
        for row in clean['byModel']:
            for k in list(row):
                if k.lower() in ('folder', 'path', 'cwd', 'session', 'sessionid'): removed.add('byModel.' + k); row.pop(k)
    body = json.dumps(clean, indent=1, sort_keys=True) + '\n'
    # history.test.ts asserts the parser tolerates the CLI's sync preamble line; keep a generic one.
    if name == 'omp-stats.json':
        body = 'Synced 0 new entries from 0 files (0 total)\n\n' + body
    (DST / name).write_text(body)
    print(f'wrote {name}: {(DST/name).stat().st_size} bytes')

print('\nremoved field paths (names only):')
for r in sorted(removed): print('  -', r)
