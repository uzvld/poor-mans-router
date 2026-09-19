import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRTUAL_PROVIDER,
  VIRTUAL_MODELS,
  PLACEHOLDER_API_KEY,
  virtualModeForModelKey,
  resolveModeTransition,
  registerVirtualRouterProvider,
} from '../virtual-model.ts';

test('virtual selector keys map to their routing modes', () => {
  assert.equal(virtualModeForModelKey('pmr/frontier'), 'frontier');
  assert.equal(virtualModeForModelKey('pmr/balanced'), 'balanced');
  assert.equal(virtualModeForModelKey('pmr/small'), 'small');
  assert.equal(virtualModeForModelKey('anthropic/claude-sonnet-5'), undefined);
  assert.equal(virtualModeForModelKey(undefined), undefined);
  assert.equal(virtualModeForModelKey('router/friendly'), undefined);
});

test('a router/* selection enters managed mode from any state', () => {
  assert.equal(resolveModeTransition('manual', 'pmr/balanced', undefined), 'balanced');
  assert.equal(resolveModeTransition('balanced', 'pmr/frontier', 'kilo/m1'), 'frontier');
});

test('our own router switch keeps managed mode', () => {
  assert.equal(resolveModeTransition('balanced', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5'), 'balanced');
  assert.equal(resolveModeTransition('small', 'kilo/deepseek:free', 'kilo/deepseek:free'), 'small');
});

test('any other concrete model flips managed mode to manual', () => {
  assert.equal(resolveModeTransition('balanced', 'anthropic/claude-sonnet-5', 'kilo/m1'), 'manual');
  assert.equal(resolveModeTransition('frontier', 'kilo/m1', undefined), 'manual');
});

test('manual mode never re-activates except through a router/* selection', () => {
  assert.equal(resolveModeTransition('manual', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5'), 'manual');
  assert.equal(resolveModeTransition('manual', 'anthropic/claude-sonnet-5', undefined), 'manual');
});

test('provider registration passes the fail-closed config and all four models', () => {
  const calls: Array<{ name: string; config: Record<string, unknown>; sourceId: string }> = [];
  const pi = {
    registerProvider(name: string, config: Record<string, unknown>, sourceId: string) {
      calls.push({ name, config, sourceId });
    },
  };
  registerVirtualRouterProvider(pi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, VIRTUAL_PROVIDER);
  assert.equal(calls[0].sourceId, 'adaptive-router');
  assert.equal(calls[0].config.baseUrl, 'http://127.0.0.1:9');
  assert.equal(calls[0].config.apiKey, PLACEHOLDER_API_KEY);
  assert.equal(PLACEHOLDER_API_KEY.includes('sk-'), false, 'placeholder must never look like a credential');
  const models = calls[0].config.models as Array<{ id: string; api: string; supportsTools: boolean }>;
  assert.deepEqual(models.map((m) => m.id), ['frontier', 'balanced', 'small', 'free']);
  for (const m of models) {
    assert.equal(m.api, 'openai-completions');
    assert.equal(m.supportsTools, true);
  }
  assert.deepEqual(VIRTUAL_MODELS.map((m) => m.id), ['frontier', 'balanced', 'small', 'free']);
});
