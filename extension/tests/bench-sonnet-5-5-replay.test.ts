import test from 'node:test';
import assert from 'node:assert/strict';
import { blendIntel } from '../bench-blend.ts';
import { selectForTier } from '../ranking.ts';
import { DEFAULT_POLICY, DEFAULT_WEIGHTS } from '../policy.ts';
import { AA_INTEL, liveHistory, routesWith } from './bench-fixtures.ts';

// Live 2026-10-30: `balanced` kept selecting claude-sonnet-5 over claude-sonnet-5-5. The AA Intelligence
// Index was re-baselined between 2026-10-11 and today: sonnet-5 and opus-5 lost `intelligence`, so the
// sonnet lineage had no reference left and sonnet-5.5 fell back to neutral priors (0.7534 against 0.7913).
// Independent sources rank sonnet-5.5 third on the LMArena agent board against sixteenth for sonnet-5.
const balanced = (intel: typeof AA_INTEL) =>
  selectForTier(
    routesWith(intel, { weights: DEFAULT_WEIGHTS.balanced }),
    DEFAULT_POLICY.tiers.balanced.classes,
    { allowDraining: true, preference: 'quality' },
  )?.route.key;

test('AA alone, after its re-baseline, still picks the predecessor: the data AA kept cannot tell the two apart', () => {
  assert.equal(balanced(AA_INTEL), 'anthropic/claude-sonnet-5');
});

test('with the other sources blended in, balanced selects sonnet-5-5', () => {
  assert.equal(balanced(blendIntel(AA_INTEL, liveHistory()).intel), 'anthropic/claude-sonnet-5-5');
});
