import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLmarena, parseLmarena } from '../bench-lmarena.ts';
import { fixtureJson } from './bench-fixtures.ts';

type Rows = { rows: unknown[] };
const input = {
  text: {
    overall: fixtureJson<Rows>('lmarena-text-overall.json').rows,
    coding: fixtureJson<Rows>('lmarena-text-coding.json').rows,
    hard_prompts: [] as unknown[],
  },
  agent: fixtureJson<Rows>('lmarena-agent.json').rows,
};
const snapshot = parseLmarena(input, 7);
const sonnet55 = snapshot.rows.find((r) => r.model === 'anthropic/claude-sonnet-5.5');
const observed = (facet: string) => sonnet55?.observations.find((o) => o.facet === facet);

test('sonnet-5.5 is measured on all three facets, the agent board as the most trusted one', () => {
  assert.deepEqual(sonnet55?.observations.map((o) => o.facet).sort(), ['agentic', 'coding', 'general']);
  const agentic = observed('agentic');
  assert.equal(agentic?.label, 'LMArena agent');
  assert.equal(agentic?.effort, 'max');
  assert.ok(Math.abs((agentic?.value ?? 0) - 0.13837) < 1e-4);
  assert.ok(Math.abs((agentic?.ci ?? 0) - 0.026508) < 1e-5, 'ci is the half-width of the published interval');
  assert.ok((agentic?.confidence ?? 0) > (observed('coding')?.confidence ?? 1), 'human preference counts less than agent outcomes');
});

test('the text boards keep the rating on LMArena scale and the effort from the display name', () => {
  assert.equal(observed('coding')?.effort, 'xhigh');
  assert.ok(Math.abs((observed('coding')?.value ?? 0) - 1511.91) < 0.01);
  assert.equal(observed('general')?.label, 'LMArena text overall');
});

test('the leaderboard publish date is shown as the data date and never becomes the version that decides re-baselines', () => {
  assert.equal(snapshot.source, 'lmarena');
  assert.equal(snapshot.fetchedAt, 7);
  assert.equal(snapshot.sourceVersion, 'lmarena');
  assert.equal(snapshot.publishedAt, '2026-10-28');
});

test('hard prompts feed the general facet and lowercase organizations map to vendors', () => {
  const parsed = parseLmarena({
    text: { overall: [], coding: [], hard_prompts: [{ model_name: 'GLM 5.3 (High)', organization: 'zai', rating: 1400, rating_lower: 1390, rating_upper: 1410, leaderboard_publish_date: '2026-10-28' }] },
    agent: [],
  }, 1);
  assert.deepEqual(parsed.rows.map((r) => [r.model, r.observations[0]?.facet, r.observations[0]?.label]), [['z-ai/glm-5.3', 'general', 'LMArena hard prompts']]);
});

test('rows with a non-finite score, or a vendor nobody can name, are dropped instead of guessed', () => {
  const parsed = parseLmarena({
    text: {
      overall: [
        { model_name: 'Claude Sonnet 5 (High)', organization: 'anthropic', rating: Number.NaN, leaderboard_publish_date: '2026-10-28' },
        { model_name: 'Mystery 9', organization: 'nobody-labs', rating: 1500, leaderboard_publish_date: '2026-10-28' },
        { model_name: 'Claude Opus 5.5 (High)', organization: 'anthropic', rating: 1515, leaderboard_publish_date: '2026-10-28' },
      ],
      coding: [],
      hard_prompts: [],
    },
    agent: [],
  }, 1);
  assert.deepEqual(parsed.rows.map((r) => r.model), ['anthropic/claude-opus-5.5']);
});

test('a body with no usable rows is an error, so no empty snapshot replaces a good one', () => {
  assert.throws(() => parseLmarena({ text: { overall: [], coding: [], hard_prompts: [] }, agent: [] }, 1));
  assert.throws(() => parseLmarena({ text: { overall: [{ unexpected: 'schema' }], coding: [], hard_prompts: [] }, agent: [{ also: 'wrong' }] }, 1));
});

// --- fetch: the Hugging Face datasets-server pages at 100 rows, and answers slowly ------------------------
function datasetsServer(failFirst = 0) {
  const boards: Record<string, unknown[]> = {
    'text/overall': input.text.overall,
    'text/coding': input.text.coding,
    'text/hard_prompts': input.text.overall.slice(0, 120),
    'agent/overall': input.agent,
  };
  const calls: string[] = [];
  let failures = failFirst;
  const fake = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    calls.push(parsed.search);
    if (failures > 0) { failures -= 1; return new Response('slow down', { status: 429 }); }
    const config = parsed.searchParams.get('config');
    const category = parsed.searchParams.get('where')?.match(/'([^']+)'/)?.[1];
    const all = boards[`${config}/${category}`] ?? [];
    const offset = Number(parsed.searchParams.get('offset'));
    const length = Number(parsed.searchParams.get('length'));
    return Response.json({ rows: all.slice(offset, offset + length).map((row) => ({ row })), num_rows_total: all.length });
  }) as typeof fetch;
  return { fake, calls };
}

test('fetch pages every board to its published total and yields the same snapshot as parsing the full boards', async () => {
  const { fake, calls } = datasetsServer();
  const fetched = await fetchLmarena(fake, 7, 0);
  assert.ok(fetched.rows.length > 50, 'boards of 400 rows reduce to the models the router can name');
  assert.equal(fetched.publishedAt, '2026-10-28');
  // 419 + 414 + 120 + 57 rows at 100 per page.
  assert.equal(calls.length, 5 + 5 + 2 + 1);
  const parsed = parseLmarena({
    text: { overall: input.text.overall, coding: input.text.coding, hard_prompts: input.text.overall.slice(0, 120) },
    agent: input.agent,
  }, 7);
  assert.deepEqual(fetched, parsed);
});

test('one throttled page is retried once; a second failure is an error', async () => {
  assert.ok((await fetchLmarena(datasetsServer(1).fake, 1, 0)).rows.length > 0);
  await assert.rejects(fetchLmarena(datasetsServer(2).fake, 1, 0));
});

test('a server that answers 200 with nothing is an error, not an empty snapshot', async () => {
  const empty = (async () => Response.json({ rows: [], num_rows_total: 0 })) as unknown as typeof fetch;
  await assert.rejects(fetchLmarena(empty, 1, 0));
});

test('a throttled or failing server is retried once; a network error is not, since the next refresh is 15 minutes away anyway', async () => {
  let calls = 0;
  const offline = (async () => { calls += 1; throw new Error('network down'); }) as typeof fetch;
  await assert.rejects(fetchLmarena(offline, 1, 0));
  assert.equal(calls, 1, 'no second attempt after a thrown network error');

  const statuses: number[] = [];
  const flaky = (async () => { const status = statuses.length === 0 ? 502 : 404; statuses.push(status); return new Response('x', { status }); }) as typeof fetch;
  await assert.rejects(fetchLmarena(flaky, 1, 0));
  assert.deepEqual(statuses, [502, 404], 'a 5xx is retried once, and a 4xx that is not throttling ends it');
});
