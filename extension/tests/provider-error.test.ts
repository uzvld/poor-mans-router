import test from 'node:test';
import assert from 'node:assert/strict';
import { cooldownFromPermanentModelError, cooldownFromProviderError, evaluateRouteHealth, providerErrorMessage } from '../health.ts';

const streamError = 'Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)';
const retirement = 'Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.';


test('a failed stream retains the actual model retirement verdict from partial text', () => {
  const message = providerErrorMessage({stopReason: 'error', model: 'claude-sonnet-4-6', errorMessage: streamError, content: [{type: 'text', text: retirement}]});
  assert.ok(message.includes(retirement));
  assert.ok(cooldownFromProviderError(message, 1000, 'claude-sonnet-4-6')?.cooldownUntil! > 1000 + 60 * 60_000);
});

test('partial prose about another model does not retire the active model', () => {
  for (const partial of [retirement, 'Model example-old is no longer available. Please switch to example-new.']) {
    const message = providerErrorMessage({stopReason: 'error', model: 'claude-sonnet-5-5', errorMessage: streamError, content: [{type: 'text', text: partial}]});
    assert.equal(message, streamError);
    assert.equal(cooldownFromPermanentModelError(message, 1000), undefined);
  }
});

test('successful answers and malformed message values cannot become recovery evidence', () => {
  for (const message of [undefined, null, 'bad', {stopReason: 'stop', model: 'claude-sonnet-4-6', content: [{type: 'text', text: retirement}]}]) {
    assert.equal(providerErrorMessage(message), '');
  }
});

test('expired credentials exclude only the failed route instead of leaving it immediately eligible', () => {
  const message = '401 This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.';
  const local = cooldownFromProviderError(message, 1000);
  assert.equal(evaluateRouteHealth({provider: 'example', modelId: 'primary', free: false}, {ompReports: [], codexbar: [], reservePct: 10, now: 1001, local}).state, 'COOLDOWN');
  assert.equal(evaluateRouteHealth({provider: 'example', modelId: 'sibling', free: false}, {ompReports: [], codexbar: [], reservePct: 10, now: 1001}).state, 'AVAILABLE');
});

test('transport cooldown is temporary while protocol and request-shape failures are not blindly retried', () => {
  assert.ok(cooldownFromProviderError(streamError, 1000)?.cooldownUntil! > 1000);
  for (const message of [
    'The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running. (code=unsupported_native_inflight_message)',
    "Unknown parameter: 'input[2].internal_chat_message_metadata_passthrough.content_token_count'.",
    '400 Bad Request: messages must not be empty',
  ]) assert.equal(cooldownFromProviderError(message, 1000), undefined, message);
});
