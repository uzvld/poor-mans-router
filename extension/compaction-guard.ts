/**
 * Guard for the loss proven in `docs/investigations/bug-c-context-loss-root-cause.md`.
 *
 * On a Responses-API provider, OMP can compact remotely: the conversation stays
 * server-side and the session entry keeps only `preserveData.openaiRemoteCompaction
 * .replacementHistory` plus a ~933-character placeholder `summary`. OMP replays that
 * history only for a model that can consume it — same provider AND a Responses API.
 * Switch anywhere else and the new model sees the placeholder: in the real session
 * that produced this investigation, 1,832 messages collapsed into one sentence.
 *
 * The repair belongs to OMP (config `compaction.methodOrder` without `remote`, or a
 * portable summary generated at switch time). This is only a guard: the router holds
 * its own switch instead of walking the session off a cliff it cannot rebuild.
 */

/** OMP's own predicate (`bL()` in 18.2.6) for "this API can replay provider-native items". */
const RESPONSES_APIS: Record<string, true> = {
  'openai-responses': true,
  'azure-openai-responses': true,
  'openai-codex-responses': true,
};

function readString(value: unknown, key: string): string | undefined {
  if (value && typeof value === 'object' && key in value) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}

/** Exported: the same question is asked of the current model and of the switch target. */
export function isResponsesApi(model: unknown): boolean {
  return RESPONSES_APIS[readString(model, 'api') ?? ''] === true;
}

/**
 * Method of the NEWEST compaction in the branch, or undefined when the branch has none.
 * Only the newest matters: a later `snapcompact` produces a portable summary, which is
 * what any provider replays, so an older `remote` entry is no longer load-bearing.
 */
export function newestCompactionMethod(branch: readonly unknown[] | undefined): string | undefined {
  let method: string | undefined;
  for (const entry of branch ?? []) {
    if (readString(entry, 'type') !== 'compaction') continue;
    method = readString(entry, 'method');
  }
  return method;
}

export interface HoldDecision {
  hold: boolean;
  reason?: string;
}

/**
 * Whether a switch from `current` to `target` would strand a remote compaction.
 * Fail-open by design: anything unknown (no branch, no api field, no compaction) routes
 * normally — a guard that blocks on missing metadata would be worse than the bug.
 */
export function holdForRemoteCompaction(
  branch: readonly unknown[] | undefined,
  current: unknown,
  target: unknown,
): HoldDecision {
  if (newestCompactionMethod(branch) !== 'remote') return { hold: false };
  if (!isResponsesApi(current)) return { hold: false };
  const currentProvider = readString(current, 'provider');
  const replayable = currentProvider !== undefined
    && currentProvider === readString(target, 'provider')
    && isResponsesApi(target);
  if (replayable) return { hold: false };
  return {
    hold: true,
    reason: "remote compaction replays only on this provider's Responses API",
  };
}
