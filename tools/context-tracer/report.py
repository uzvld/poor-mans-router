#!/usr/bin/env python3
"""Render a BUG C case trace as the CONTEXT_SESSION_TRACE / PROVIDER_CONTEXT_TRACE evidence table.
usage: report.py <case-id> [<case-id> ...]
Reads /tmp/bug-c/<case>/trace.jsonl and tui.log. Prints only shapes, ids, booleans — never content.
"""
import json, re, sys, pathlib

def load(case):
    d = pathlib.Path('/tmp/bug-c') / case
    rows = [json.loads(l) for l in (d / 'trace.jsonl').read_text().splitlines() if l.strip()]
    tui = (d / 'tui.log').read_bytes().decode('utf-8', 'replace')
    tui = re.sub(r'\x1b\[[0-9;?<>]*[A-Za-z]', '', tui); tui = re.sub(r'\x1b\][^\x07]*\x07', '', tui)
    return rows, tui

def answers(tui):
    pre = re.findall(r'animal=([a-z]+)\s+number=(\d+)', tui)
    post = re.findall(r'marker=([A-Za-z0-9_<>]+)\s+animal=([a-z<>]+)\s+number=([0-9<>]+)', tui)
    lost = bool(re.search(r"(don't|do not|cannot|can't|no record|not able|unable|didn't|did not)\s+(have|recall|see|remember|access|find)", tui, re.I))
    return pre, post, lost

def main(cases):
    for case in cases:
        rows, tui = load(case)
        reqs = [r for r in rows if r['event'] == 'provider_request']
        switches = [r for r in rows if r['event'] in ('model_changed', 'ctx_switch', 'retry_fallback_applied', 'auto_retry_start', 'session_compact')]
        sessions = {r.get('sessionId') for r in rows if r.get('sessionId')}
        print(f"\n=== {case} ===")
        print(f"session ids seen: {len(sessions)}  ->  {', '.join(s[:8] for s in sessions)}")
        print(f"provider requests: {len(reqs)}   switch/fallback/compaction events: {len(switches)}")
        print(f"{'seq':>3} {'model (payload)':34s} {'leaf':9s} {'stored':>6} {'st.mk':>5} {'pl.msgs':>7} {'pl.mk':>5} {'sys.hash':17s} {'shape.hash':17s} {'compact':>7}")
        for r in reqs:
            p = r['payload']; s = r['stored']
            print(f"{r['seq']:>3} {str(p.get('model'))[:34]:34s} {(r.get('leafId') or '')[:8]:9s} {s['entries']:>6} {str(s['markerPresent'])[:5]:>5} {p['messages']:>7} {str(p['markerPresent'])[:5]:>5} {p['systemPromptHash']:17s} {p['shapeHash']:17s} {str(p['compactionSummaryPresent'])[:5]:>7}")
        for r in switches:
            if r['event'] == 'ctx_switch':
                b, a = r['storedBefore'], r['storedAfter']
                print(f"    [ctx_switch] {r.get('from')} -> {r.get('to')} resolved={r.get('resolved')} setModel={r.get('setModelResult')} leaf={(r.get('leafId') or '')[:8]} stored {b['entries']}->{a['entries']} marker {b['markerPresent']}->{a['markerPresent']} shape {b['shapeHash']}->{a['shapeHash']}")
            else:
                print(f"    [{r['event']}] from={r.get('from')} to={r.get('to') or r.get('model')} leaf={(r.get('leafId') or '')[:8]} stored={r.get('stored',{}).get('entries')} marker_in_stored={r.get('stored',{}).get('markerPresent')}")
        pre, post, lost = answers(tui)
        print(f"TUI pre-switch answer : {pre[-1] if pre else 'NONE'}")
        print(f"TUI post-switch answer: {post[-1] if post else 'NONE'}   loss-language={lost}")
        if reqs:
            last = reqs[-1]['payload']
            verdict = 'CONTINUITY OK' if last['markerPresent'] else 'MARKER ABSENT FROM FINAL PROVIDER REQUEST'
            print(f"VERDICT: {verdict}  (final request: {last['messages']} msgs, model={last.get('model')})")

if __name__ == '__main__':
    main(sys.argv[1:])
