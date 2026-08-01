import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';

// Cold-part layout (see record-removal-cold p3 design):
//
//   record-removal/v1/{tableId}/{reason}/{yyyymm}/{dd}-p{seq}-r{runToken}.ndjson.zst  flusher day part
//   record-removal/v1/{tableId}/{reason}/{yyyymm}/m-p{seq}-r{runToken}.ndjson.zst     compactor month part
//   record-removal/v1/{tableId}/{reason}/_stats.json                                  per-(table,reason) pruning stats
//
// A part is NDJSON: one header line, N data rows, one footer line, compressed
// as a single zstd (or gzip fallback) stream. Rows inside a part are sorted by
// (removedTime DESC, id DESC) — the archive default page order, so a reader
// stops as soon as its page is full. Unlike record history there is no
// minRecordId in the key: record-id point queries prune via the per-part bloom
// in `_stats.json` instead.

export const RECORD_REMOVAL_COLD_VERSION = 'v1';

// the removal reasons are key-path segments — a frozen storage contract. They
// mirror IRecordRemovalReason (@teable/v2-core) by value, but deliberately do
// NOT derive from it: a domain-type change must never silently reshape keys.
export const COLD_REMOVAL_REASONS = ['deleted', 'archived'] as const;

export type ColdRemovalReason = (typeof COLD_REMOVAL_REASONS)[number];

export const isColdRemovalReason = (value: string): value is ColdRemovalReason =>
  (COLD_REMOVAL_REASONS as readonly string[]).includes(value);

export interface IColdRemovalRow {
  id: string;
  recordId: string;
  // record snapshot JSON text as stored in record_trash.snapshot, after
  // truncateRemovalRow — never the raw form (see the truncation section below)
  snapshot: string;
  reason: ColdRemovalReason;
  // ISO string (= record_trash.created_time, the moment of removal)
  removedTime: string;
  removedBy: string;
  operationId?: string;
  recordCreatedTime?: string;
  recordCreatedBy?: string;
  recordLastModifiedTime?: string;
  recordLastModifiedBy?: string;
}

export interface IPartBucket {
  yyyymm: string;
  kind: 'day' | 'month';
  // two digit day, only for kind=day
  dd?: string;
}

export interface IPartHeader {
  t: 'h';
  v: 1;
  tableId: string;
  reason: ColdRemovalReason;
  bucket: IPartBucket;
}

export interface IPartFooter {
  t: 'f';
  rows: number;
  sha256: string;
}

export interface IParsedPartKey extends IPartBucket {
  tableId: string;
  reason: ColdRemovalReason;
  seq: number;
  compression: 'zstd' | 'gzip';
  key: string;
}

export interface IRecordBloom {
  // bit count
  m: number;
  // hash count
  k: number;
  // base64 bit array
  b64: string;
}

export interface IPartStatsEntry {
  key: string;
  rows: number;
  sha256: string;
  minRemovedTime: string;
  maxRemovedTime: string;
  // the record-meta dims are optional on the row, so their bounds/sets cover
  // only rows that carry them — pruning on these dims only skips rows a
  // dim-equality filter could never match anyway
  minRecordCreatedTime?: string;
  maxRecordCreatedTime?: string;
  minRecordLastModifiedTime?: string;
  maxRecordLastModifiedTime?: string;
  // distinct record creators in the part; null when over the cap (must scan)
  recordCreatedBys: string[] | null;
  // distinct last modifiers in the part; null when over the cap (must scan)
  recordLastModifiedBys: string[] | null;
  // record-id bloom filter: "definitely not here" prunes the part safely
  recordBloom?: IRecordBloom;
}

export interface ITableColdStats {
  version: 1;
  tableId: string;
  reason: ColdRemovalReason;
  parts: Record<string, IPartStatsEntry>;
}

// explicit-set cap for per-part recordCreatedBys/recordLastModifiedBys in
// `_stats.json`; beyond this the set is stored as null (= must scan). 500
// matches the record-history stats cap: worst case ≈ 10KB per part entry, and
// only for parts that actually touch that many distinct actors.
export const STATS_SET_CAP = 500;

const zlibWithZstd = zlib as typeof zlib & {
  createZstdCompress?: (options?: unknown) => zlib.Gzip;
  createZstdDecompress?: (options?: unknown) => zlib.Gunzip;
};

export const hasZstd = typeof zlibWithZstd.createZstdCompress === 'function';

// Writing prefers zstd when the runtime has it (node >= 22.15). Reading always
// handles both formats, but a `.zst` KEY needs a zstd-capable reader — on a
// fleet with mixed node versions (engines allow >= 22.0), force gzip with
// BACKEND_RECORD_REMOVAL_COLD_COMPRESSION=gzip so every process can read
// freshly written parts. Checked per call: env files may load after module
// evaluation.
const writeZstd = () => hasZstd && process.env.BACKEND_RECORD_REMOVAL_COLD_COMPRESSION !== 'gzip';

export const partFileSuffix = () => (writeZstd() ? '.ndjson.zst' : '.ndjson.gz');

export const createPartCompressor = () => {
  if (writeZstd()) {
    return zlibWithZstd.createZstdCompress!({
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: 3,
      },
    });
  }
  return zlib.createGzip({ level: 6 });
};

export const createPartDecompressor = (key: string) => {
  if (key.endsWith('.zst')) {
    if (!hasZstd) {
      throw new Error(`cannot decompress ${key}: node runtime lacks zstd support`);
    }
    return zlibWithZstd.createZstdDecompress!();
  }
  return zlib.createGunzip();
};

export const coldRootDir = (rootDir: string) => `${rootDir}/${RECORD_REMOVAL_COLD_VERSION}`;

export const tablePrefix = (rootDir: string, tableId: string) =>
  `${coldRootDir(rootDir)}/${tableId}/`;

export const reasonPrefix = (rootDir: string, tableId: string, reason: ColdRemovalReason) =>
  `${tablePrefix(rootDir, tableId)}${reason}/`;

export const monthPrefix = (
  rootDir: string,
  tableId: string,
  reason: ColdRemovalReason,
  yyyymm: string
) => `${reasonPrefix(rootDir, tableId, reason)}${yyyymm}/`;

export const statsKey = (rootDir: string, tableId: string, reason: ColdRemovalReason) =>
  `${reasonPrefix(rootDir, tableId, reason)}_stats.json`;

const padSeq = (seq: number) => String(seq).padStart(4, '0');

export const buildPartKey = (
  rootDir: string,
  tableId: string,
  reason: ColdRemovalReason,
  bucket: IPartBucket,
  seq: number,
  runToken: string
) => {
  const base = monthPrefix(rootDir, tableId, reason, bucket.yyyymm);
  const lead = bucket.kind === 'month' ? 'm' : bucket.dd!;
  // the run token makes concurrent rewrites of the same bucket collision-free:
  // two runs computing the same startSeq from the same listing still produce
  // distinct keys, so neither can overwrite (or verification-cleanup-delete)
  // the other's part; read-side id-dedup absorbs the duplication
  return `${base}${lead}-p${padSeq(seq)}-r${runToken}${partFileSuffix()}`;
};

// filename: {m|dd}-p{seq}-r{runToken}.ndjson.{zst|gz}
const PART_FILE_RE = /^(m|\d{2})-p(\d+)-r[a-z0-9]+\.ndjson\.(zst|gz)$/;

export const parsePartKey = (rootDir: string, key: string): IParsedPartKey | undefined => {
  const root = coldRootDir(rootDir);
  if (!key.startsWith(`${root}/`)) return undefined;
  const rest = key.slice(root.length + 1);
  const segments = rest.split('/');
  if (segments.length !== 4) return undefined;
  const [tableId, reason, yyyymm, fileName] = segments;
  if (!isColdRemovalReason(reason)) return undefined;
  if (!/^\d{6}$/.test(yyyymm)) return undefined;
  const match = PART_FILE_RE.exec(fileName);
  if (!match) return undefined;
  const [, lead, seq, compression] = match;
  return {
    tableId,
    reason,
    yyyymm,
    kind: lead === 'm' ? 'month' : 'day',
    dd: lead === 'm' ? undefined : lead,
    seq: Number(seq),
    compression: compression === 'zst' ? 'zstd' : 'gzip',
    key,
  };
};

export const bucketOfDate = (date: Date, kind: 'day' | 'month'): IPartBucket => {
  const yyyymm = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  if (kind === 'month') return { yyyymm, kind };
  return { yyyymm, kind, dd: String(date.getUTCDate()).padStart(2, '0') };
};

export const bucketId = (bucket: IPartBucket) =>
  bucket.kind === 'month' ? `${bucket.yyyymm}/m` : `${bucket.yyyymm}/${bucket.dd}`;

export const serializeHeader = (
  tableId: string,
  reason: ColdRemovalReason,
  bucket: IPartBucket
): string => JSON.stringify({ t: 'h', v: 1, tableId, reason, bucket } satisfies IPartHeader);

export const serializeRow = (row: IColdRemovalRow): string => JSON.stringify(row);

// A snapshot value over the caps is a legacy anomaly: values this large (up to
// 15MB observed on the ai fleet history data) make the cold flush/merge OOM no
// matter how the memory is bounded, so they are replaced with a compact marker
// at every point a row enters the sorter (flusher hot-window read, feeder
// fold-back, compactor) — the pipeline never holds a multi-MB value. Rows
// still inside the PG hot window are untouched, so restores from PG stay full
// fidelity; only the S3 copy is capped.
//
// Both caps are measured in UTF-16 units (O(1), the proxy for the V8 heap
// cost that OOMs): `fieldUnits` against each field VALUE's serialized JSON
// inside the snapshot's `fields` map (the default sits ~16x above the product
// cell-value maximum, so a legitimately max-size cell is never truncated), and
// `rowUnits` against the whole snapshot as a fallback (many capped-but-large
// fields, or an unparseable snapshot). A truncated field restores as empty.
export interface IColdTruncationMarker {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  _truncated: true;
  units: number;
}

// marker replacing an oversized field value (object form) or a whole
// oversized snapshot (its JSON text form); `units` is the size of the
// replaced JSON
export const coldTruncationMarker = (units: number): IColdTruncationMarker => ({
  _truncated: true,
  units,
});

// replace field values over fieldCap inside the snapshot's `fields` map;
// returns undefined when nothing changed — the caller then keeps the ORIGINAL
// string, so an untouched snapshot stays byte-exact (a re-serialize could
// normalize it and break fidelity)
const truncateSnapshotFields = (snapshot: string, fieldCap: number): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    // unparseable snapshot: skip the field pass, the row cap still applies
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const fields = (parsed as { fields?: unknown }).fields;
  if (typeof fields !== 'object' || fields === null) return undefined;
  const fieldMap = fields as Record<string, unknown>;
  let changed = false;
  for (const [fieldId, value] of Object.entries(fieldMap)) {
    if (value === undefined) continue;
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serialized.length > fieldCap) {
      fieldMap[fieldId] = coldTruncationMarker(serialized.length);
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : undefined;
};

// truncate a row's snapshot in place-free fashion; returns the same ref when
// nothing changed (incl. both caps <= 0 = disabled). The parse only runs for
// rows already over a cap — the fast path skips every normal-sized row.
export const truncateRemovalRow = (
  row: IColdRemovalRow,
  fieldUnits: number,
  rowUnits: number
): IColdRemovalRow => {
  const fieldCap = fieldUnits > 0 ? fieldUnits : Infinity;
  const rowCap = rowUnits > 0 ? rowUnits : Infinity;
  if (row.snapshot.length <= Math.min(fieldCap, rowCap)) return row;
  let snapshot = row.snapshot;
  if (snapshot.length > fieldCap) {
    snapshot = truncateSnapshotFields(snapshot, fieldCap) ?? snapshot;
  }
  if (snapshot.length > rowCap) {
    // whole-snapshot fallback: keep an empty record shell around the marker — the
    // restore paths parse the snapshot itself (v2 reads record.id, v1 iterates
    // record.fields), so a bare marker would fail the whole restore batch
    snapshot = JSON.stringify({
      id: row.recordId,
      fields: {},
      ...coldTruncationMarker(snapshot.length),
    });
  }
  return snapshot === row.snapshot ? row : { ...row, snapshot };
};

export const serializeFooter = (rows: number, sha256: string): string =>
  JSON.stringify({ t: 'f', rows, sha256 } satisfies IPartFooter);

export const createRowHasher = () => {
  const hash = createHash('sha256');
  return {
    update(rowLine: string) {
      hash.update(rowLine);
      hash.update('\n');
    },
    digest() {
      return hash.digest('hex');
    },
  };
};

export interface IParsedPartLine {
  header?: IPartHeader;
  footer?: IPartFooter;
  row?: IColdRemovalRow;
  raw: string;
}

export const parsePartLine = (line: string): IParsedPartLine | undefined => {
  if (!line) return undefined;
  const value = JSON.parse(line) as { t?: string };
  if (value.t === 'h') return { header: value as IPartHeader, raw: line };
  if (value.t === 'f') return { footer: value as IPartFooter, raw: line };
  return { row: value as unknown as IColdRemovalRow, raw: line };
};

const NEWLINE = 0x0a;

// Split a byte stream into NDJSON line strings WITHOUT node:readline.
//
// readline flattens its growing internal ConsString and runs a line-ending
// regex on every chunk, so a single multi-megabyte line (a removal row whose
// snapshot JSON is tens of MB — real on the ai fleet, up to 15MB observed on
// history data) becomes an O(n^2) rope-flatten storm that OOM'd the
// 2026-07-08 history cold drain (RegExpImpl::IrregexpExec /
// String::SlowFlatten at the top of the abort stack). Here partial-line
// chunks accumulate in an array and concatenate exactly once, when the
// newline arrives — O(total bytes), one allocation per line, no regex.
export async function* iterateNdjsonLines(stream: Readable): AsyncGenerator<string> {
  const pending: Buffer[] = [];
  let pendingLen = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      let nl = chunk.indexOf(NEWLINE, start);
      while (nl !== -1) {
        const slice = chunk.subarray(start, nl);
        let line: Buffer;
        if (pendingLen > 0) {
          pending.push(slice);
          line = Buffer.concat(pending, pendingLen + slice.length);
          pending.length = 0;
          pendingLen = 0;
        } else {
          line = slice;
        }
        if (line.length > 0) yield line.toString('utf8');
        start = nl + 1;
        nl = chunk.indexOf(NEWLINE, start);
      }
      if (start < chunk.length) {
        // copy: the source buffer may be recycled before the next iteration
        const rest = Buffer.from(chunk.subarray(start));
        pending.push(rest);
        pendingLen += rest.length;
      }
    }
    if (pendingLen > 0) {
      const line = Buffer.concat(pending, pendingLen).toString('utf8');
      if (line.length > 0) yield line;
    }
  } finally {
    stream.destroy();
  }
}

// Stream-decode a compressed part into rows. Memory stays O(line): download
// stream → decompressor → NDJSON line splitter. The caller may stop early by
// breaking out of the async iterator.
export async function* iteratePartRows(
  key: string,
  compressed: Readable
): AsyncGenerator<{ row?: IColdRemovalRow; footer?: IPartFooter; rowLine?: string }> {
  const decompressor = createPartDecompressor(key);
  // decode failures must name the part; a bare zlib error is undebuggable
  decompressor.on('error', (error: Error & { partKey?: string }) => {
    error.partKey = key;
    error.message = `${error.message} (part ${key})`;
  });
  try {
    for await (const line of iterateNdjsonLines(compressed.pipe(decompressor))) {
      const parsed = parsePartLine(line);
      if (!parsed) continue;
      if (parsed.header) continue;
      if (parsed.footer) {
        yield { footer: parsed.footer };
        continue;
      }
      yield { row: parsed.row, rowLine: parsed.raw };
    }
  } finally {
    compressed.destroy();
  }
}

// descending (removedTime, id) — the one canonical order: rows are written
// into parts this way AND merged reads page this way. The id tiebreak is a
// raw UTF-16 code-unit comparison (byte order for these ASCII ids); ordering
// must never cross into a db collation — PG-side reads sort with COLLATE "C"
// so both sides agree on the same total order.
export const compareRemovalRowDesc = (
  a: Pick<IColdRemovalRow, 'removedTime' | 'id'>,
  b: Pick<IColdRemovalRow, 'removedTime' | 'id'>
) => {
  if (a.removedTime !== b.removedTime) return a.removedTime < b.removedTime ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
};

/* ------------------------------------------------------------------ *
 * record-id bloom filter (double hashing, ~1% target false positives) *
 * ------------------------------------------------------------------ */

const BLOOM_BITS_PER_ELEMENT = 10; // ≈0.8% fpr with k=7
const BLOOM_HASHES = 7;
const BLOOM_MIN_BITS = 64;

const fnv1a = (value: string, seed: number): number => {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const bloomBitPositions = (value: string, m: number, k: number): number[] => {
  const h1 = fnv1a(value, 0);
  // odd step so all bits stay reachable; `| 1` alone would coerce to a SIGNED
  // 32-bit int (negative for hashes ≥ 2^31), making the modulo negative and
  // the buffer write a silent out-of-range no-op — a false-negative factory
  const h2 = (fnv1a(value, 0x9e3779b9) | 1) >>> 0;
  const positions: number[] = [];
  for (let i = 0; i < k; i++) {
    // both operands are non-negative and well under 2^53, so % stays in [0, m)
    positions.push((h1 + i * h2) % m);
  }
  return positions;
};

// build a bloom over the part's distinct record ids
export const buildRecordBloom = (recordIds: Iterable<string>, count: number): IRecordBloom => {
  const m = Math.max(BLOOM_MIN_BITS, Math.ceil(count * BLOOM_BITS_PER_ELEMENT));
  const bytes = Buffer.alloc(Math.ceil(m / 8));
  for (const recordId of recordIds) {
    for (const position of bloomBitPositions(recordId, m, BLOOM_HASHES)) {
      bytes[position >> 3] |= 1 << (position & 7);
    }
  }
  return { m, k: BLOOM_HASHES, b64: bytes.toString('base64') };
};

// false only when the record is DEFINITELY absent — safe to prune on false
export const bloomMightContain = (bloom: IRecordBloom, recordId: string): boolean => {
  const bytes = Buffer.from(bloom.b64, 'base64');
  for (const position of bloomBitPositions(recordId, bloom.m, bloom.k)) {
    if ((bytes[position >> 3] & (1 << (position & 7))) === 0) return false;
  }
  return true;
};
