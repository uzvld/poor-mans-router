import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, classifyModelId, tierForRole, decorateClasses, tierForSession, normalizePolicy } from '../policy.ts';

test('tierForRole maps OMP roles to workload tiers', () => {
  assert.equal(tierForRole('plan'), 'frontier');
  assert.equal(tierForRole('advisor'), 'frontier');
  assert.equal(tierForRole('default'), 'balanced');
  assert.equal(tierForRole('task'), 'balanced');
  assert.equal(tierForRole('smol'), 'small');
  assert.equal(tierForRole('tiny'), 'small');
});

test('classification follows model identity, not provider inventory', () => {
  assert.ok(classifyModelId('vendor-a/deepseek-v4.1-flash').includes('chinese-flash'));
  assert.ok(classifyModelId('vendor-b/claude-sonnet-5').includes('sonnet'));
});

test('decorates semantic classes from route economics without provider allowlists', () => {
  const tags = decorateClasses(
    classifyModelId('new-vendor/deepseek/deepseek-v4.1-flash'),
    { free: false, subscriptionLike: false },
  );
  assert.ok(tags.includes('chinese-flash-payg'));
  assert.ok(tags.includes('best-available'));

  const sub = decorateClasses(classifyModelId('future-vendor/claude-fable-5'), {
    free: false,
    subscriptionLike: true,
  });
  assert.ok(sub.includes('fable-sub'));
});

test('session agent override beats model role and unknown sessions default balanced', () => {
  assert.equal(tierForSession({ agent: 'architect', modelRole: 'smol' }, { architect: 'frontier' }), 'frontier');
  assert.equal(tierForSession({ modelRole: 'smol' }, {}), 'small');
  assert.equal(tierForSession({}, {}), 'balanced');
});

test('default policy preserves the agreed tier class order', () => {
  assert.deepEqual(DEFAULT_POLICY.tiers.frontier.classes.slice(0, 3), ['fable-sub', 'astra-sub', 'opus-sub']);
  assert.deepEqual(DEFAULT_POLICY.tiers.balanced.classes.slice(0, 3), ['sonnet-sub', 'luna-sub', 'chinese-flash-payg']);
  assert.deepEqual(DEFAULT_POLICY.tiers.small.classes, ['cheap-sub', 'cheap-flash', 'healthy-free-fast']);
});

test('normalizePolicy accepts partial user overrides without losing defaults', () => {
  const p = normalizePolicy({ agentTiers: { builder: 'frontier' } });
  assert.equal(p.agentTiers?.builder, 'frontier');
  assert.deepEqual(p.tiers.small.classes, DEFAULT_POLICY.tiers.small.classes);
});

test('free strong models enter through the free tail, not the paid strong-chinese class', () => {
  const tags = decorateClasses(classifyModelId('openrouter/z-ai/glm-5.2:free'), { free: true, subscriptionLike: false });
  assert.ok(tags.includes('best-free'));
  assert.equal(tags.includes('strong-chinese'), false);
});

test('free routes stay in explicit free tails instead of the generic paid best-available class', () => {
  const tags = decorateClasses(classifyModelId('openrouter/nvidia/nemotron-3-ultra:free'), {
    free: true,
    subscriptionLike: false,
  });
  assert.equal(tags.includes('best-available'), false);
  assert.equal(tags.includes('best-free'), true);
});

test('small tier can reuse fast subscription models such as Luna and subscription flash models', () => {
  const luna = decorateClasses(classifyModelId('openai-codex/gpt-5.6-luna'), { free: false, subscriptionLike: true });
  const flash = decorateClasses(classifyModelId('opencode-go/deepseek-v4.1-flash'), { free: false, subscriptionLike: true });
  assert.ok(luna.includes('cheap-sub'));
  assert.ok(flash.includes('cheap-sub'));
  assert.ok(flash.includes('strong-flash-sub'));
});
