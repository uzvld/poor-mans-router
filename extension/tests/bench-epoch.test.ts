import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { fetchEpoch, parseCsv, parseEpoch, readZipEntries } from '../bench-epoch.ts';
import { fixtureText } from './bench-fixtures.ts';

const csvNames = readdirSync(new URL('../../fixtures/bench-2026-10-30/epoch/', import.meta.url)).filter((n) => n.endsWith('.csv') && !n.startsWith('._'));
const files: Record<string, string> = Object.fromEntries(csvNames.map((name) => [name, fixtureText(`epoch/${name}`)]));

// A minimal zip writer: enough to put the reader through stored and deflated entries, and to lie
// about sizes the way a hostile or damaged archive would.
function buildZip(entries: Record<string, string>, options: { stored?: boolean; claimedSize?: number } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = options.stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(options.stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(options.claimedSize ?? raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const MB = 1024 * 1024;

test('the zip reader returns only the wanted entries, deflated or stored', () => {
  const entries = { 'a.csv': 'x,y\n1,2\n', 'skip.csv': 'no\n', 'b.csv': 'p\nq\n' };
  for (const stored of [false, true]) {
    const read = readZipEntries(buildZip(entries, { stored }), (name) => name !== 'skip.csv', MB);
    assert.deepEqual(read, { 'a.csv': 'x,y\n1,2\n', 'b.csv': 'p\nq\n' });
  }
});

test('a truncated archive, a non-zip body and an entry larger than its bound are errors, never partial data', () => {
  const zip = buildZip({ 'a.csv': 'x,y\n1,2\n'.repeat(500) });
  assert.throws(() => readZipEntries(zip.slice(0, Math.floor(zip.length / 2)), () => true, MB));
  assert.throws(() => readZipEntries(new TextEncoder().encode('<html>rate limited</html>'), () => true, MB));
  assert.throws(() => readZipEntries(buildZip({ 'a.csv': 'x\n' }, { claimedSize: 20 * MB }), () => true, MB), /larger than/);
  assert.throws(() => readZipEntries(buildZip({ 'a.csv': 'x'.repeat(2 * MB) }), () => true, MB));
});

test('csv fields may be quoted, hold commas, doubled quotes and line breaks', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n'), [
    { a: 'x, y', b: 'say "hi"' },
    { a: 'two\nlines', b: 'z' },
  ]);
});

const snapshot = parseEpoch(files, 5);
const rowOf = (model: string) => snapshot.rows.find((r) => r.model === model);
const labels = (model: string, facet: string) => rowOf(model)?.observations.filter((o) => o.facet === facet).map((o) => `${o.label}:${o.effort ?? '-'}`).sort();

test('sonnet-5.5 shows up in the benchmarks Epoch ran it on, with the effort of each row', () => {
  assert.deepEqual(labels('anthropic/claude-sonnet-5.5', 'coding'), ['FrontierSWE:max']);
  assert.ok(labels('anthropic/claude-sonnet-5.5', 'agentic')?.includes('APEX-Agents:max'));
  const apex = rowOf('anthropic/claude-sonnet-5.5')?.observations.find((o) => o.label === 'APEX-Agents' && o.effort === 'max');
  assert.equal(apex?.value, 0.755);
});

test('percent-scaled benchmarks are brought onto 0..1 through the declared scale', () => {
  const all = snapshot.rows.flatMap((r) => r.observations).filter((o) => o.label === 'Aider polyglot');
  assert.ok(all.length > 10);
  assert.ok(all.every((o) => o.value >= 0 && o.value <= 1), 'a 0.01-scaled percent must not stay 0..100');
});

test('the newest release date in the data is the data date; the version is constant so a daily change is no re-baseline', () => {
  assert.equal(snapshot.source, 'epoch');
  assert.equal(snapshot.fetchedAt, 5);
  assert.equal(snapshot.sourceVersion, 'epoch');
  assert.match(snapshot.publishedAt ?? '', /^2026-\d\d-\d\d$/);
});

test('a benchmark the metadata marks superseded, or one it does not describe at all, is not read', () => {
  const metadata = files['benchmark_metadata.csv']!.replace(/(FrontierSWE,.*),$/m, '$1,APEX-Agents');
  const parsed = parseEpoch({ ...files, 'benchmark_metadata.csv': metadata, 'cursorbench_external.csv': 'Model version,Score\nclaude-opus-5_max,0.466\n' }, 1);
  assert.equal(parsed.rows.some((r) => r.observations.some((o) => o.label === 'FrontierSWE')), false);
  assert.equal(parsed.rows.some((r) => r.observations.some((o) => /cursor/i.test(o.label))), false);
});

test('an archive with no usable row is an error, so an empty snapshot never replaces a good one', () => {
  assert.throws(() => parseEpoch({ 'benchmark_metadata.csv': files['benchmark_metadata.csv']! }, 1));
  assert.throws(() => parseEpoch({}, 1));
});

test('fetch reads the archive and yields the snapshot parsing its files yields', async () => {
  const body = buildZip(files);
  const ok = (async () => new Response(body)) as unknown as typeof fetch;
  assert.deepEqual(await fetchEpoch(ok, 5), parseEpoch(files, 5));
  const throttled = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(fetchEpoch(throttled, 5));
  const html = (async () => new Response('<html>maintenance</html>')) as unknown as typeof fetch;
  await assert.rejects(fetchEpoch(html, 5));
});

test('an oversized streamed archive is cancelled before the rest is consumed, with or without Content-Length', async () => {
  const maxArchiveBytes = 32 * 1024 * 1024;
  const atLimit = new Uint8Array(maxArchiveBytes);
  for (const headers of [undefined, { 'content-length': '1' }]) {
    let pulls = 0;
    let cancelled = false;
    const chunks = [atLimit, new Uint8Array([1]), new Uint8Array([2])];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const index = pulls++;
        if (index < chunks.length) controller.enqueue(chunks[index]!);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers });
    const oversized = (async () => response) as typeof fetch;

    await assert.rejects(fetchEpoch(oversized, 5), /larger than expected/);
    assert.equal(pulls, 2, 'the first chunk beyond the bound is enough to reject');
    assert.equal(cancelled, true, 'the unread remainder of the response is cancelled');
  }
});
