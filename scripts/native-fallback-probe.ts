// Run with native-fallback-probe.sh, never install as a production extension.
// Uses OMP's actual resolver and Settings implementation; exits before inference.
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import {
  findRetryFallbackCandidates,
  getRetryFallbackChains,
  resolveRetryFallbackChainKey,
} from '@oh-my-pi/pi-coding-agent/session/retry-fallback-chains';

const fable = 'anthropic/claude-fable-5-1';
const astra = 'openai-codex/gpt-6-astra';
const sonnet = 'anthropic/claude-sonnet-5';
const models = [fable, astra, sonnet].map((selector) => {
  const slash = selector.indexOf('/');
  return { provider: selector.slice(0, slash), id: selector.slice(slash + 1) };
});
const modelLookup = {
  find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
  hasProvider: (provider: string) => models.some((m) => m.provider === provider),
};

function nextModel(settings: Settings): string | null {
  const context = {
    chains: getRetryFallbackChains(settings),
    getModelRole: (role: string) => settings.getModelRole(role),
    modelLookup,
  };
  const key = resolveRetryFallbackChainKey(context, fable, models[0], 'default');
  return key ? findRetryFallbackCandidates(context, key, fable, models[0])[0]?.raw ?? null : null;
}

export default function nativeFallbackProbe(pi: ExtensionAPI): void {
  let providerRequests = 0;
  pi.registerProvider('pmr-probe', {
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'not-a-real-credential',
    models: [{ id: 'test', name: 'Native fallback probe', api: 'openai-completions', supportsTools: true }],
  }, 'pmr-probe');
  pi.on('session_start', async () => {
    try {
      // set() affects only this in-memory Settings instance, not user config.
      const settings = Settings.isolated();
      settings.set('retry.fallbackChains', { 'anthropic/*': [sonnet] });
      const nativeNext = nextModel(settings);
      settings.override('retry.fallbackChains', { [fable]: [astra] });
      const managedNext = nextModel(settings);
      const wildcardSurvives = Object.hasOwn(settings.get('retry.fallbackChains'), 'anthropic/*');
      const child = await settings.cloneForCwd(process.cwd());
      const childNext = nextModel(child);
      settings.clearOverride('retry.fallbackChains');
      const parentNextAfterRelease = nextModel(settings);
      const childNextAfterParentRelease = nextModel(child);

      // Clearing PMR's replacement cannot recover another owner's prior override.
      const preexisting = Settings.isolated({ 'retry.fallbackChains': { 'anthropic/*': [sonnet] } });
      preexisting.override('retry.fallbackChains', { [fable]: [astra] });
      preexisting.clearOverride('retry.fallbackChains');
      const previousOverrideRecovered = nextModel(preexisting) === sonnet;
      console.log(JSON.stringify({
        nativeNext, managedNext, wildcardSurvives, childNext,
        parentNextAfterRelease, childNextAfterParentRelease, previousOverrideRecovered,
        providerRequests,
      }, null, 2));
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
  pi.on('before_provider_request', (_event, ctx) => {
    providerRequests++;
    ctx.abort();
    throw new Error('native fallback probe must never reach a provider request');
  });
}
