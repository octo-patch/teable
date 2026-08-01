import {
  MemoryEventBus,
  RECORD_REMOVAL_REASON,
  RecordsDeleted,
  type IExecutionContext,
} from '@teable/v2-core';
import type { V1TeableDatabase } from '@teable/v2-postgres-schema';
import type { Kysely } from 'kysely';

// record_trash is not part of V1TeableDatabase; the index signature makes the insert compile.
type TrashSinkDb = V1TeableDatabase & Record<string, Record<string, unknown>>;

// The pure v2 container has no trash sink — the nestjs backend registers the
// RecordsDeleted → record_trash projection. The undo/redo replay of RestoreRecords
// consults record_trash (purge guard: rows the user purged must not resurrect), so
// the test container mimics the projection at the same seam: every published
// RecordsDeleted event writes one minimal row per deleted record. Archived removals
// persist their own write-ahead snapshots outside this container and are skipped,
// matching the backend projection. The snapshot column is a stub ('{}') — enough for
// the purge guard's existence check, useless for restore-from-snapshot tests.
//
// Row ids must be random, never a module-level counter: the database can outlive one
// test file (a shared testcontainers instance, or a pglite:// DIRECTORY path) while
// module state resets per file — sequential ids would collide on record_trash_pkey.
const trashSinkRowId = () => `rtrtest_${crypto.randomUUID()}`;

export class TrashSinkEventBus extends MemoryEventBus {
  private readonly db: Kysely<TrashSinkDb>;

  constructor(
    handlerResolver: ConstructorParameters<typeof MemoryEventBus>[0],
    db: Kysely<V1TeableDatabase>
  ) {
    super(handlerResolver);
    this.db = db as unknown as Kysely<TrashSinkDb>;
  }

  override async publish(
    context: IExecutionContext,
    event: Parameters<MemoryEventBus['publish']>[1]
  ) {
    return this.publishMany(context, [event]);
  }

  override async publishMany(
    context: IExecutionContext,
    events: Parameters<MemoryEventBus['publishMany']>[1]
  ) {
    const result = await super.publishMany(context, events);
    if (result.isOk()) {
      await this.sinkDeleted(context, events);
    }
    return result;
  }

  private async sinkDeleted(
    context: IExecutionContext,
    events: Parameters<MemoryEventBus['publishMany']>[1]
  ) {
    for (const event of events) {
      if (!(event instanceof RecordsDeleted)) continue;
      if (event.removalReason === RECORD_REMOVAL_REASON.Archived) continue;
      if (event.recordIds.length === 0) continue;
      await this.db
        .insertInto('record_trash')
        .values(
          event.recordIds.map((recordId) => ({
            id: trashSinkRowId(),
            table_id: event.tableId.toString(),
            record_id: recordId.toString(),
            snapshot: '{}',
            created_by: context.actorId.toString(),
            reason: RECORD_REMOVAL_REASON.Deleted,
          }))
        )
        .execute();
    }
  }
}
