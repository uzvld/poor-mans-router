import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { createAssistantMessageEventStream } from '@oh-my-pi/pi-ai';
import type { AssistantMessage } from '@oh-my-pi/pi-ai';

// Loaded only by the isolated OMP integration probe. No credential or external transport.
export default async function providerErrorProbe(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.PMR_PROBE_URL;
  if (!baseUrl?.startsWith('http://127.0.0.1:')) throw new Error('probe requires a localhost transport');
  for (const [index, lane] of ['primary', 'backup', 'third'].entries()) {
    const provider = `pmr-recovery-${lane}`;
    pi.registerProvider(provider, {
      api: 'pmr-recovery-local', baseUrl: `${baseUrl}/${lane}`, apiKey: 'probe',
      models: [{id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', api: 'pmr-recovery-local',
        supportsTools: true, contextWindow: 128000, maxTokens: 1024,
        cost: {input: index + 1, output: index + 1, cacheRead: 0, cacheWrite: 0}}],
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [], stopReason: 'stop',
          usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        };
        void (async () => {
          try {
            const response = await fetch(model.baseUrl, {method: 'POST', body: JSON.stringify({messages: context.messages})});
            const outcome: unknown = await response.json();
            if (!outcome || typeof outcome !== 'object' || !('text' in outcome) || typeof outcome.text !== 'string'
              || ('error' in outcome && typeof outcome.error !== 'string')) throw new Error('invalid local probe response');
            message.content = outcome.text ? [{type: 'text', text: outcome.text}] : [];
            if ('error' in outcome) {
              message.stopReason = 'error';
              message.errorMessage = String(outcome.error);
            }
            stream.push({type: 'start', partial: message});
            if (outcome.text) {
              stream.push({type: 'text_start', contentIndex: 0, partial: message});
              stream.push({type: 'text_delta', contentIndex: 0, delta: outcome.text, partial: message});
              stream.push({type: 'text_end', contentIndex: 0, content: outcome.text, partial: message});
            }
          } catch (error) {
            message.stopReason = 'error';
            message.errorMessage = String(error);
          }
          if (message.stopReason === 'error') stream.push({type: 'error', reason: 'error', error: message});
          else stream.push({type: 'done', reason: 'stop', message});
          stream.end();
        })();
        return stream;
      },
    }, provider);
  }
  const implementation = process.env.PMR_PROBE_ROUTER ?? new URL('../extension/index.ts', import.meta.url).href;
  // The probe can load the installed baseline or the candidate at runtime.
  const { default: router } = await import(implementation);
  router(pi);
}
