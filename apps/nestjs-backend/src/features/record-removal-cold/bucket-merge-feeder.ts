import type { SortMemoryBudget } from './external-sort';
import { ExternalRowSorter } from './external-sort';
import type { IColdRemovalRow, IParsedPartKey, IPartStatsEntry } from './part-codec';
import { truncateRemovalRow } from './part-codec';
import type { PartWriter } from './part-writer';
import type { RecordRemovalColdStorageService } from './record-removal-cold-storage.service';

// Feeds a bucket's PartWriter with the deduplicated union of the live buffer
// rows and the bucket's EXISTING cold parts, in the canonical
// (removedTime DESC, id DESC) order.
//
// Why a full external sort instead of a streaming merge:
// - a bucket can legitimately be flushed more than once with disjoint row
//   sets (the per-reason run at the horizon boundary covers only part of a
//   day), so existing parts must be folded back in — never clobbered;
// - NO input order can be trusted: the buffer stream follows the db's
//   timestamp/collation ordering, which cannot be assumed to match the
//   comparator on ties (a streaming merge under mismatched orders silently
//   emits duplicates);
// - each existing part is read to EOF immediately (short-lived GET) — dozens
//   of half-open download streams interleaved with uploads on one HTTP
//   client deadlock it (observed on the record-history big-table e2e run).
//
// Buffer reads can keep ALL of a table's bucket feeders live at once, so
// every feeder's in-memory run must charge the one shared SortMemoryBudget —
// a per-feeder cap alone made peak memory O(#buckets x run size) and OOM'd
// the 2026-07-08 history cn drain.
export class BucketMergeFeeder {
  private readonly sorter: ExternalRowSorter;
  private initialized = false;
  // rows folded back in from existing parts (not counted as flushed buffer rows)
  mergedExistingRows = 0;

  constructor(
    private readonly writer: PartWriter,
    private readonly existingParts: IParsedPartKey[],
    private readonly coldStorage: RecordRemovalColdStorageService,
    sortBudget?: SortMemoryBudget,
    mergeFanIn?: number,
    private readonly truncateFieldUnits = 0,
    private readonly truncateRowUnits = 0
  ) {
    this.sorter = new ExternalRowSorter(undefined, sortBudget, mergeFanIn);
  }

  get bucket() {
    return this.writer.bucket;
  }

  get metrics() {
    return this.writer.metrics;
  }

  // the pre-existing part keys this feeder folded into the rewrite — the only
  // keys a heal pass may delete afterwards (a key that appeared concurrently
  // belongs to another run and must survive)
  get consumedKeys(): Set<string> {
    return new Set(this.existingParts.map((part) => part.key));
  }

  async push(row: IColdRemovalRow): Promise<void> {
    await this.ensureInitialized();
    await this.sorter.add(row);
  }

  async finish(): Promise<IPartStatsEntry[]> {
    try {
      await this.ensureInitialized();
      await this.sorter.drainTo((row) => this.writer.add(row));
      return await this.writer.finish();
    } finally {
      await this.sorter.cleanup();
    }
  }

  // release the sorter's budget charge, temp files and registry entry without
  // emitting anything — for a table flush that dies after opening feeders but
  // before their finish loop, whose feeders would otherwise stay charged
  // against the run-wide budget (and stay evictable) for the rest of the run.
  // Idempotent and safe to call whether or not finish() ran.
  async abort(): Promise<void> {
    await this.sorter.cleanup();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const part of this.existingParts) {
      for await (const item of this.coldStorage.iterateRows(part.key)) {
        if (!item.row) continue;
        // existing parts may predate the caps (or the caps may have been
        // lowered), so heal them on read-back: the rewritten part carries the
        // marker and the sorter never holds a multi-MB snapshot folded in
        // from S3
        const row =
          this.truncateFieldUnits || this.truncateRowUnits
            ? truncateRemovalRow(item.row, this.truncateFieldUnits, this.truncateRowUnits)
            : item.row;
        await this.sorter.add(row);
        this.mergedExistingRows += 1;
      }
    }
  }
}
