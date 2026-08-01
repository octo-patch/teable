/* eslint-disable @typescript-eslint/naming-convention */
import {
  CreateRecordsCommand,
  DeleteRecordsCommand,
  RECORD_REMOVAL_REASON,
  v2CoreTokens,
  type CreateRecordsResult,
  type DeleteRecordsResult,
  type IUndoRedoStore,
} from '@teable/v2-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBasicTable,
  createUndoRedoDbHarness,
  disposeHarness,
  fetchRowById,
  findField,
  type UndoRedoDbHarness,
} from '../../shared/undoRedoDbTestKit';

describe('undo-redo/deleteRecords (db)', () => {
  let harness: UndoRedoDbHarness | undefined;

  beforeEach(async () => {
    harness = await createUndoRedoDbHarness();
  });

  afterEach(async () => {
    await disposeHarness(harness);
    harness = undefined;
  });

  it('replays restore on undo and delete on redo', async () => {
    if (!harness) throw new Error('Missing harness');

    const table = await createBasicTable(harness, 'Undo Delete Records');
    const titleField = findField(table, 'Title');
    const amountField = findField(table, 'Amount');
    const store = harness.container.resolve<IUndoRedoStore>(v2CoreTokens.undoRedoStore);

    const createResult = await harness.execute<CreateRecordsCommand, CreateRecordsResult>(
      CreateRecordsCommand.create({
        tableId: table.id().toString(),
        records: [
          {
            fields: {
              [titleField.id().toString()]: 'Alpha',
              [amountField.id().toString()]: 1,
            },
          },
          {
            fields: {
              [titleField.id().toString()]: 'Beta',
              [amountField.id().toString()]: 2,
            },
          },
        ],
      })._unsafeUnwrap()
    );

    const deletedId = createResult.records[0]!.id().toString();

    await harness.execute<DeleteRecordsCommand, DeleteRecordsResult>(
      DeleteRecordsCommand.create({
        tableId: table.id().toString(),
        recordIds: [deletedId],
      })._unsafeUnwrap()
    );

    const entry = (
      await store.list({
        actorId: harness.context.actorId,
        tableId: table.id(),
        windowId: harness.context.windowId!,
      })
    )
      ._unsafeUnwrap()
      .at(-1);

    expect(entry?.undoCommand.type).toBe('RestoreRecords');
    expect(entry?.redoCommand.type).toBe('DeleteRecords');
    expect(await fetchRowById(harness.db, table, deletedId)).toBeUndefined();

    await harness.undo(table.id().toString());
    expect(harness.probe.names()).toEqual(['UndoCommand', 'RestoreRecordsCommand']);
    expect(await fetchRowById(harness.db, table, deletedId)).toBeDefined();

    await harness.redo(table.id().toString());
    expect(harness.probe.names()).toEqual(['RedoCommand', 'DeleteRecordsCommand']);
    expect(await fetchRowById(harness.db, table, deletedId)).toBeUndefined();
  });

  // The undo entry embeds full snapshots; the replay must consult record_trash so
  // records the user purged after the delete (emptied recycle bin, permanently
  // deleted items) stay gone instead of resurrecting from the stack payload.
  it('restores only records whose trash rows survived a partial purge', async () => {
    if (!harness) throw new Error('Missing harness');

    const table = await createBasicTable(harness, 'Undo Partially Purged');
    const titleField = findField(table, 'Title');

    const createResult = await harness.execute<CreateRecordsCommand, CreateRecordsResult>(
      CreateRecordsCommand.create({
        tableId: table.id().toString(),
        records: [
          { fields: { [titleField.id().toString()]: 'Survivor' } },
          { fields: { [titleField.id().toString()]: 'Purged' } },
        ],
      })._unsafeUnwrap()
    );
    const survivorId = createResult.records[0]!.id().toString();
    const purgedId = createResult.records[1]!.id().toString();

    await harness.execute<DeleteRecordsCommand, DeleteRecordsResult>(
      DeleteRecordsCommand.create({
        tableId: table.id().toString(),
        recordIds: [survivorId, purgedId],
      })._unsafeUnwrap()
    );

    await harness.db
      .deleteFrom('record_trash')
      .where('table_id', '=', table.id().toString())
      .where('record_id', '=', purgedId)
      .execute();

    await harness.undo(table.id().toString());
    expect(await fetchRowById(harness.db, table, survivorId)).toBeDefined();
    expect(await fetchRowById(harness.db, table, purgedId)).toBeUndefined();
  });

  // Archive redo replays the carried write-ahead rows. It must (a) skip rows whose
  // archive snapshot the user purged between undo and redo — resurrecting them would
  // override an explicit permanent delete — and (b) stamp the replayed rows with the
  // replay time: the undo wrote a restore tombstone, and a row keeping its original
  // (older) archive time would be suppressed by that tombstone once it reaches cold
  // storage, then physically dropped by compaction.
  it('archive redo re-persists only surviving rows and stamps them with the replay time', async () => {
    if (!harness) throw new Error('Missing harness');

    const table = await createBasicTable(harness, 'Redo Archived Partial Purge');
    const titleField = findField(table, 'Title');
    const tableId = table.id().toString();

    const createResult = await harness.execute<CreateRecordsCommand, CreateRecordsResult>(
      CreateRecordsCommand.create({
        tableId,
        records: [
          { fields: { [titleField.id().toString()]: 'Survivor' } },
          { fields: { [titleField.id().toString()]: 'Purged' } },
        ],
      })._unsafeUnwrap()
    );
    const survivorId = createResult.records[0]!.id().toString();
    const purgedId = createResult.records[1]!.id().toString();

    // mimic the archive orchestrator's write-ahead snapshots at an old archive time
    const originalArchiveTime = new Date('2026-01-01T00:00:00.000Z');
    const archiveRow = (recordId: string) => ({
      recordId,
      snapshot: JSON.stringify({ id: recordId, fields: {} }),
      createdBy: harness!.context.actorId.toString(),
      createdTime: originalArchiveTime.toISOString(),
      operationId: 'oprredoarchivetest1',
    });
    await harness.db
      .insertInto('record_trash')
      .values(
        [survivorId, purgedId].map((recordId) => ({
          id: `rtrtest_${crypto.randomUUID()}`,
          table_id: tableId,
          record_id: recordId,
          snapshot: JSON.stringify({ id: recordId, fields: {} }),
          created_by: harness!.context.actorId.toString(),
          created_time: originalArchiveTime,
          reason: RECORD_REMOVAL_REASON.Archived,
          operation_id: 'oprredoarchivetest1',
        }))
      )
      .execute();

    await harness.execute<DeleteRecordsCommand, DeleteRecordsResult>(
      DeleteRecordsCommand.create(
        { tableId, recordIds: [survivorId, purgedId] },
        {
          removalReason: RECORD_REMOVAL_REASON.Archived,
          archiveRows: [archiveRow(survivorId), archiveRow(purgedId)],
        }
      )._unsafeUnwrap()
    );

    // permanently delete one archived record while both sit in the archive
    await harness.db
      .deleteFrom('record_trash')
      .where('table_id', '=', tableId)
      .where('record_id', '=', purgedId)
      .execute();

    await harness.undo(tableId);
    expect(await fetchRowById(harness.db, table, survivorId)).toBeDefined();
    expect(await fetchRowById(harness.db, table, purgedId)).toBeUndefined();

    await harness.redo(tableId);
    expect(await fetchRowById(harness.db, table, survivorId)).toBeUndefined();
    expect(await fetchRowById(harness.db, table, purgedId)).toBeUndefined();

    const archiveRowsAfterRedo = await harness.db
      .selectFrom('record_trash')
      .select(['record_id', 'created_time'])
      .where('table_id', '=', tableId)
      .where('reason', '=', RECORD_REMOVAL_REASON.Archived)
      .execute();
    expect(archiveRowsAfterRedo.map((row) => row.record_id)).toEqual([survivorId]);
    expect(new Date(archiveRowsAfterRedo[0]!.created_time as Date).getTime()).toBeGreaterThan(
      originalArchiveTime.getTime()
    );
  });

  it('undo is a successful no-op after every trash row was purged', async () => {
    if (!harness) throw new Error('Missing harness');

    const table = await createBasicTable(harness, 'Undo Fully Purged');
    const titleField = findField(table, 'Title');

    const createResult = await harness.execute<CreateRecordsCommand, CreateRecordsResult>(
      CreateRecordsCommand.create({
        tableId: table.id().toString(),
        records: [{ fields: { [titleField.id().toString()]: 'Gone' } }],
      })._unsafeUnwrap()
    );
    const recordId = createResult.records[0]!.id().toString();

    await harness.execute<DeleteRecordsCommand, DeleteRecordsResult>(
      DeleteRecordsCommand.create({
        tableId: table.id().toString(),
        recordIds: [recordId],
      })._unsafeUnwrap()
    );

    await harness.db
      .deleteFrom('record_trash')
      .where('table_id', '=', table.id().toString())
      .execute();

    await harness.undo(table.id().toString());
    expect(harness.probe.names()).toEqual(['UndoCommand', 'RestoreRecordsCommand']);
    expect(await fetchRowById(harness.db, table, recordId)).toBeUndefined();
  });
});
