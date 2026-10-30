import { inflateRawSync } from 'node:zlib';
import { canonicalBenchModel } from './bench-identity.ts';
import { isFiniteNumber } from './bench-util.ts';
import type { BenchObservation, BenchRow, BenchSnapshot, Facet } from './bench-types.ts';

// Epoch AI publishes its benchmark results as one zip of CSV files (CC BY 4.0, credit Epoch AI).
// `benchmark_metadata.csv` declares each benchmark's score column, scale and ceiling and marks a
// benchmark `superseded_by` its successor: only benchmarks it describes are read, so a score is
// never guessed onto a scale. The extension takes no dependency, so the archive is read here.

const ZIP_URL = 'https://epoch.ai/data/benchmark_data.zip';
const METADATA = 'benchmark_metadata.csv';
const EPOCH_CONFIDENCE = 0.8;
/** Largest CSV read from the archive: the biggest real entry is 3.9 MB. */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** Largest archive accepted: the real one is 2.4 MB. */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Which facet each benchmark file feeds. Coding and agentic work only; the rest of the archive is not read. */
const FACET_BY_FILE: Record<string, Facet> = {
  'swe_bench_verified.csv': 'coding',
  'aider_polyglot_external.csv': 'coding',
  'frontierswe_external.csv': 'coding',
  'terminalbench_external.csv': 'agentic',
  'apex_agents_external.csv': 'agentic',
  'osworld_2_external.csv': 'agentic',
};

// --- zip -----------------------------------------------------------------------------------------

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The text of every wanted entry of a zip archive. Stored and deflated entries only; zip64,
 * encrypted entries, an entry whose bytes lie outside the archive, or one larger than `maxBytes`
 * (claimed or actual) are errors: a damaged archive yields nothing rather than part of a table.
 */
export function readZipEntries(zip: Uint8Array, wanted: (name: string) => boolean, maxBytes: number): Record<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');

  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  const directorySize = view.getUint32(end + 12, true);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) throw new Error('zip64 archives are not supported');
  if (directoryOffset + directorySize > zip.length) throw new Error('truncated zip archive');

  const out: Record<string, string> = {};
  const decoder = new TextDecoder();
  let at = directoryOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL) throw new Error('damaged zip directory');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;

    if (flags & 1) throw new Error(`zip entry ${name} is encrypted`);
    if (size > maxBytes) throw new Error(`zip entry ${name} is larger than ${maxBytes} bytes`);
    if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== LOCAL) throw new Error('damaged zip entry header');
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + compressed > zip.length) throw new Error('truncated zip archive');
    const data = zip.subarray(start, start + compressed);

    if (method === 0) {
      if (data.length > maxBytes) throw new Error(`zip entry ${name} is larger than ${maxBytes} bytes`);
      out[name] = decoder.decode(data);
    } else if (method === 8) {
      out[name] = decoder.decode(inflateRawSync(data, { maxOutputLength: maxBytes }));
    } else {
      throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
    }
  }
  return out;
}

// --- csv -----------------------------------------------------------------------------------------

/** RFC 4180 records keyed by the header row; quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      table.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    table.push(row);
  }

  const [header, ...records] = table;
  if (!header) return [];
  return records
    .filter((record) => record.length > 1 || record[0] !== '')
    .map((record) => Object.fromEntries(header.map((column, index) => [column, record[index] ?? ''])));
}

// --- snapshot ------------------------------------------------------------------------------------

export function parseEpoch(files: Record<string, string>, fetchedAt: number): BenchSnapshot {
  const byModel = new Map<string, BenchObservation[]>();
  let version = '';

  for (const meta of parseCsv(files[METADATA] ?? '')) {
    const file = meta.source_file ?? '';
    const facet = FACET_BY_FILE[file];
    const csv = files[file];
    const scale = Number(meta.scale);
    const ceiling = Number(meta.score_ceiling);
    const column = meta.score_column ?? '';
    if (!facet || csv === undefined || meta.superseded_by || !isFiniteNumber(scale) || !isFiniteNumber(ceiling) || ceiling <= 0 || !column) continue;

    for (const row of parseCsv(csv)) {
      const raw = row[column]?.trim() ?? '';
      const model = row['Model version'] ?? '';
      if (raw === '' || !model) continue;
      const value = Number(raw) * scale / ceiling;
      if (!isFiniteNumber(value) || value < 0 || value > 1.0001) continue;
      const identity = canonicalBenchModel(model, row.Organization);
      if (!identity) continue;
      const observation: BenchObservation = {
        facet,
        value,
        confidence: EPOCH_CONFIDENCE,
        label: meta.benchmark ?? file,
        ...(identity.effort ? { effort: identity.effort } : {}),
      };
      byModel.set(identity.model, [...(byModel.get(identity.model) ?? []), observation]);
      const released = row['Release date'] ?? '';
      if (released > version) version = released;
    }
  }

  if (byModel.size === 0) throw new Error('Epoch: the archive held no usable row');
  const rows: BenchRow[] = [...byModel].map(([model, observations]) => ({ model, observations }));
  return { source: 'epoch', fetchedAt, sourceVersion: 'epoch', ...(version ? { publishedAt: version } : {}), rows };
}

/** Download the archive, read the benchmark files and parse them. All or nothing, like every source. */
export async function fetchEpoch(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<BenchSnapshot> {
  const response = await fetchImpl(ZIP_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Epoch: HTTP ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > MAX_ARCHIVE_BYTES) throw new Error('Epoch: the archive is larger than expected');
  const entries = readZipEntries(body, (name) => name === METADATA || name in FACET_BY_FILE, MAX_ENTRY_BYTES);
  return parseEpoch(entries, now);
}
