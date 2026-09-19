import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * context-tracer — diagnostic OMP extension for BUG C (context loss on model switch).
 *
 * Records, for every provider request and every model change:
 *   - session / branch identity (ids only)
 *   - stored-branch shape (entry counts by type, shape hash)
 *   - provider-payload shape (message counts by role, shape hash, oldest/newest role)
 *   - whether the synthetic test marker is present in stored history and in the payload
 *
 * It NEVER logs message content, prompts, headers, or keys. Marker presence is a boolean.
 * Output: JSONL at $CONTEXT_TRACE_FILE (default /tmp/adaptive-router-context-trace.log).
 */

const TRACE_FILE = process.env.CONTEXT_TRACE_FILE ?? '/tmp/adaptive-router-context-trace.log';
const MARKER = process.env.CONTEXT_TRACE_MARKER ?? 'ROUTER_CONTEXT_MARKER_71C9E4';

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function emit(record: Record<string, unknown>) {
  try {
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    appendFileSync(TRACE_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch {
    // diagnostics must never break the session
  }
}

function textOf(x: unknown): string {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(textOf).join('\n');
  if (x && typeof x === 'object') {
    const o = x as any;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    if (o.content) return textOf(o.content);
    if (o.input) return textOf(o.input);
    if (o.output) return textOf(o.output);
    return '';
  }
  return '';
}

/** Shape of the stored session branch: counts by entry type and by message role. */
function branchShape(branch: readonly any[]) {
  const byType: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  let toolCalls = 0, toolResults = 0, marker = false, compaction = false;
  const shapeParts: string[] = [];
  for (const e of branch ?? []) {
    const t = String(e?.type ?? 'unknown');
    byType[t] = (byType[t] ?? 0) + 1;
    if (t === 'compaction' || t === 'compaction_summary' || String(e?.customType ?? '').includes('compaction')) compaction = true;
    const m = e?.message;
    if (m) {
      const role = String(m.role ?? 'unknown');
      byRole[role] = (byRole[role] ?? 0) + 1;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'toolCall' || c?.type === 'tool_use') toolCalls++;
        if (c?.type === 'toolResult' || c?.type === 'tool_result') toolResults++;
      }
      if (textOf(m).includes(MARKER)) marker = true;
      shapeParts.push(`${role}:${Array.isArray(m.content) ? m.content.map((c: any) => c?.type).join(',') : 'text'}`);
    } else {
      shapeParts.push(t);
    }
  }
  return { entries: branch?.length ?? 0, byType, byRole, toolCalls, toolResults, markerPresent: marker, compactionSeen: compaction, shapeHash: sha(shapeParts.join('|')) };
}

/** Shape of an outgoing provider payload. Handles Anthropic (messages+system) and OpenAI (messages/input) bodies. */
function payloadShape(payload: any) {
  const body = payload?.body ?? payload;
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const byRole: Record<string, number> = {};
  let toolCalls = 0, toolResults = 0, marker = false, chars = 0;
  const shapeParts: string[] = [];
  for (const m of msgs) {
    const role = String(m?.role ?? m?.type ?? 'unknown');
    byRole[role] = (byRole[role] ?? 0) + 1;
    const content = Array.isArray(m?.content) ? m.content : [m?.content ?? m];
    for (const c of content) {
      const ct = String(c?.type ?? 'text');
      if (ct === 'tool_use' || ct === 'function_call' || ct === 'toolCall') toolCalls++;
      if (ct === 'tool_result' || ct === 'function_call_output' || ct === 'toolResult') toolResults++;
    }
    const t = textOf(m); chars += t.length;
    if (t.includes(MARKER)) marker = true;
    shapeParts.push(`${role}:${content.map((c: any) => c?.type ?? 'text').join(',')}`);
  }
  const system = typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? textOf(body.system) : (body?.instructions ?? '');
  const compactionSummary = msgs.some((m) => /\[compaction|conversation summary|summary of (the )?(prior|previous) conversation/i.test(textOf(m)));
  return {
    model: body?.model ?? payload?.model,
    messages: msgs.length,
    byRole, toolCalls, toolResults,
    approxChars: chars,
    oldestRole: msgs[0]?.role ?? null,
    newestRole: msgs[msgs.length - 1]?.role ?? null,
    markerPresent: marker,
    compactionSummaryPresent: compactionSummary,
    systemPromptHash: sha(String(system)),
    systemPromptChars: String(system).length,
    shapeHash: sha(shapeParts.join('|')),
  };
}

function identity(ctx: any) {
  const sm = ctx?.sessionManager;
  return {
    sessionId: sm?.getSessionId?.() ?? null,
    leafId: sm?.getLeafId?.() ?? null,
    sessionFile: sm?.getSessionFile?.() ? sha(String(sm.getSessionFile())) : null, // hashed path, not the path
    pid: process.pid,
  };
}

export default function contextTracer(pi: ExtensionAPI) {
  pi.setLabel('Context Tracer (diagnostic)');
  let requestSeq = 0;
  let lastModel: string | undefined;

  const snapshot = (ctx: any, event: string, extra: Record<string, unknown> = {}) => {
    const model = ctx?.models?.current?.();
    const modelKey = model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
    emit({
      event,
      ...identity(ctx),
      model: modelKey,
      stored: branchShape(ctx?.sessionManager?.getBranch?.() ?? []),
      ...extra,
    });
    return modelKey;
  };

  pi.on('session_start', async (_e: any, ctx: any) => { lastModel = snapshot(ctx, 'session_start'); });
  pi.on('before_agent_start', async (_e: any, ctx: any) => { snapshot(ctx, 'before_agent_start'); });
  pi.on('agent_end', async (_e: any, ctx: any) => { snapshot(ctx, 'agent_end'); });

  (pi as any).on('model_changed', async (_e: any, ctx: any) => {
    const from = lastModel;
    lastModel = snapshot(ctx, 'model_changed', { from });
  });

  (pi as any).on('retry_fallback_applied', async (e: any, ctx: any) => {
    snapshot(ctx, 'retry_fallback_applied', { from: e?.from, to: e?.to });
  });
  (pi as any).on('auto_retry_start', async (e: any, ctx: any) => {
    snapshot(ctx, 'auto_retry_start', { attempt: e?.attempt, delayMs: e?.delayMs, rateOrQuota: /429|rate|quota/i.test(String(e?.errorMessage ?? '')) });
  });

  (pi as any).on('session_compact', async (e: any, ctx: any) => {
    snapshot(ctx, 'session_compact', { entriesBefore: e?.entriesBefore ?? e?.before, entriesAfter: e?.entriesAfter ?? e?.after });
  });

  (pi as any).on('before_provider_request', async (e: any, ctx: any) => {
    requestSeq += 1;
    const shape = payloadShape(e?.payload);
    emit({
      event: 'provider_request',
      seq: requestSeq,
      ...identity(ctx),
      provider: shape.model ? String(shape.model) : undefined,
      currentModel: (() => { const m = ctx?.models?.current?.(); return m ? `${m.provider}/${m.id}` : undefined; })(),
      payload: shape,
      stored: branchShape(ctx?.sessionManager?.getBranch?.() ?? []),
    });
    return undefined; // never modify the payload
  });

  (pi as any).on('after_provider_response', async (e: any, ctx: any) => {
    emit({ event: 'provider_response', seq: requestSeq, ...identity(ctx), status: e?.status, requestId: e?.requestId ? sha(String(e.requestId)) : undefined });
  });

  // /ctx-switch <provider/model> — switch via the SAME API the router uses (pi.setModel),
  // so the trace shows exactly what a router-driven switch does to session/branch/payload.
  pi.registerCommand('ctx-switch', {
    description: 'Diagnostic: switch model via pi.setModel and record the trace',
    handler: async (args: string, ctx: any) => {
      const selector = String(args ?? '').trim();
      const before = branchShape(ctx?.sessionManager?.getBranch?.() ?? []);
      const from = (() => { const m = ctx?.models?.current?.(); return m ? `${m.provider}/${m.id}` : undefined; })();
      const target = ctx?.models?.resolve?.(selector);
      const ok = target ? await pi.setModel(target) : false;
      const after = branchShape(ctx?.sessionManager?.getBranch?.() ?? []);
      emit({ event: 'ctx_switch', ...identity(ctx), from, to: selector, resolved: !!target, setModelResult: ok, storedBefore: before, storedAfter: after });
      ctx?.ui?.notify?.(`ctx-switch ${from} -> ${selector}: resolved=${!!target} setModel=${ok} entries ${before.entries}->${after.entries} marker ${before.markerPresent}->${after.markerPresent}`, ok ? 'info' : 'error');
    },
  });
}
