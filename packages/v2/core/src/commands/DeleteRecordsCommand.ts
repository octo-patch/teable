import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import { domainError, type DomainError } from '../domain/shared/DomainError';
import type { IRecordRemovalReason } from '../domain/table/events/RecordsDeleted';
import { RecordId } from '../domain/table/records/RecordId';
import { TableId } from '../domain/table/TableId';
import type { UndoRedoArchiveTrashRow } from '../ports/UndoRedoStore';

export const deleteRecordsInputSchema = z.object({
  tableId: z.string(),
  recordIds: z.array(z.string()).min(1, 'At least one recordId is required'),
});

export type IDeleteRecordsCommandInput = z.input<typeof deleteRecordsInputSchema>;

export type { IRecordRemovalReason };

export interface IDeleteRecordsCommandOptions {
  /**
   * Why the records are removed. 'archived' suppresses the trash snapshot projection and
   * the delete undo capture: the archive orchestrator persists its own snapshot before
   * deleting. Never accepted from the HTTP contract — internal callers only.
   */
  removalReason?: IRecordRemovalReason;
  /**
   * Pre-built archive snapshot rows (removalReason 'archived' only). On the original
   * archive they feed the undo entry's redo command; on a redo replay the handler
   * re-persists them (write-ahead, same transaction) before deleting — an undo removed
   * them. Never accepted from the HTTP contract — internal callers only.
   */
  archiveRows?: ReadonlyArray<UndoRedoArchiveTrashRow>;
  /**
   * Undo-stack group id (removalReason 'archived' only): a streamed archive spans
   * several delete commands, one shared id pops them as a single undo/redo step.
   * Never accepted from the HTTP contract — internal callers only.
   */
  archiveGroupId?: string;
}

export class DeleteRecordsCommand {
  readonly removalReason?: IRecordRemovalReason;
  readonly archiveRows?: ReadonlyArray<UndoRedoArchiveTrashRow>;
  readonly archiveGroupId?: string;

  private constructor(
    readonly tableId: TableId,
    readonly recordIds: ReadonlyArray<RecordId>,
    options?: IDeleteRecordsCommandOptions
  ) {
    this.removalReason = options?.removalReason;
    this.archiveRows = options?.archiveRows;
    this.archiveGroupId = options?.archiveGroupId;
  }

  static create(
    raw: unknown,
    options?: IDeleteRecordsCommandOptions
  ): Result<DeleteRecordsCommand, DomainError> {
    const parsed = deleteRecordsInputSchema.safeParse(raw);
    if (!parsed.success) {
      return err(
        domainError.validation({
          message: 'Invalid DeleteRecordsCommand input',
          details: z.formatError(parsed.error),
        })
      );
    }

    return TableId.create(parsed.data.tableId).andThen((tableId) =>
      parseRecordIds(parsed.data.recordIds).map(
        (recordIds) => new DeleteRecordsCommand(tableId, recordIds, options)
      )
    );
  }
}

const parseRecordIds = (
  recordIds: ReadonlyArray<string>
): Result<ReadonlyArray<RecordId>, DomainError> => {
  const parsed: RecordId[] = [];

  for (const rawId of recordIds) {
    const idResult = RecordId.create(rawId);
    if (idResult.isErr()) {
      return err(
        domainError.validation({
          message: 'Invalid recordId in DeleteRecordsCommand',
          details: { recordId: rawId },
        })
      );
    }
    parsed.push(idResult.value);
  }

  return parsed.length === 0
    ? err(domainError.validation({ message: 'At least one recordId is required' }))
    : (ok(parsed) as Result<ReadonlyArray<RecordId>, DomainError>);
};
