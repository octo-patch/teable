/* eslint-disable @typescript-eslint/naming-convention */
import { v2DataDbTokens } from '@teable/v2-adapter-db-postgres-pg';
import {
  createV2NodeTestContainer,
  type IV2NodeTestContainer,
} from '@teable/v2-container-node-test';
import {
  ActorId,
  CreateTableCommand,
  MemoryCommandBus,
  MemoryEventBus,
  MemoryUndoRedoStore,
  RECORD_REMOVAL_REASON,
  RecordsDeleted,
  RedoCommand,
  Table as TableAggregate,
  UndoCommand,
  v2CoreTokens,
  type CreateTableResult,
  type ICommandBus,
  type ICommandBusMiddleware,
  type IExecutionContext,
  type ITableRepository,
  type Table,
  type DomainError,
  type IPublicCommand,
  type TableDataSafetyLimitConfig,
} from '@teable/v2-core';
import type { V1TeableDatabase } from '@teable/v2-postgres-schema';
import { sql, type Kysely } from 'kysely';
import type { Result } from 'neverthrow';

type DynamicDb = V1TeableDatabase & Record<string, Record<string, unknown>>;

type RecordedCommandCall = {
  name: string;
  context: IExecutionContext;
  command: unknown;
};

class CommandProbeMiddleware implements ICommandBusMiddleware {
  readonly calls: RecordedCommandCall[] = [];

  async handle<TCommand, TResult>(
    context: IExecutionContext,
    command: TCommand,
    next: (context: IExecutionContext, command: TCommand) => Promise<Result<TResult, DomainError>>
  ) {
    this.calls.push({
      name: (command as { constructor?: { name?: string } })?.constructor?.name ?? 'UnknownCommand',
      context,
      command,
    });
    return next(context, command);
  }

  reset() {
    this.calls.length = 0;
  }

  names() {
    return this.calls.map((call) => call.name);
  }
}

const unwrap = <T, E extends { message: string }>(result: Result<T, E>, label: string): T => {
  if (result.isErr()) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  return result.value;
};

// The pure v2 container has no trash sink — the nestjs backend registers the
// RecordsDeleted → record_trash projection. The undo/redo replay of RestoreRecords
// consults record_trash (purge guard: rows the user purged must not resurrect), so
// the harness mimics the projection at the same seam: every published RecordsDeleted
// event writes one minimal row per deleted record. Archived removals persist their
// own write-ahead snapshots outside this container and are skipped, matching the
// backend projection.
//
// Row ids must be random, never a module-level counter: the database can outlive one
// test file (a shared testcontainers instance, or a pglite:// DIRECTORY path) while
// module state resets per file — sequential ids would collide on record_trash_pkey.
const trashSinkRowId = () => `rtrtest_${crypto.randomUUID()}`;

class TrashSinkEventBus extends MemoryEventBus {
  constructor(
    handlerResolver: ConstructorParameters<typeof MemoryEventBus>[0],
    private readonly db: () => Kysely<DynamicDb>
  ) {
    super(handlerResolver);
  }

  override async publish(
    context: IExecutionContext,
    event: Parameters<MemoryEventBus['publish']>[1]
  ) {
    const result = await super.publish(context, event);
    if (result.isOk()) {
      await this.sinkDeleted(context, [event]);
    }
    return result;
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
      await this.db()
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

export type UndoRedoDbHarness = Awaited<ReturnType<typeof createUndoRedoDbHarness>>;

export const createUndoRedoDbHarness = async (options?: {
  tableDataSafetyLimits?: TableDataSafetyLimitConfig;
}) => {
  const testContainer = await createV2NodeTestContainer({
    tableDataSafetyLimits: options?.tableDataSafetyLimits,
  });
  const probe = new CommandProbeMiddleware();

  const trashSinkEventBus = new TrashSinkEventBus(testContainer.container, () =>
    testContainer.container.resolve<Kysely<DynamicDb>>(v2DataDbTokens.db)
  );
  testContainer.container.registerInstance(v2CoreTokens.eventBus, trashSinkEventBus);
  testContainer.eventBus = trashSinkEventBus;
  // This harness mirrors the full app: the sink above writes record_trash rows
  // on delete, so the delete-undo purge guard is sound here and stays on.
  testContainer.container.registerInstance(v2CoreTokens.undoRedoReplayConfig, {
    restorePurgeGuard: true,
  });

  testContainer.container.registerInstance(
    v2CoreTokens.commandBus,
    new MemoryCommandBus(testContainer.container, [probe])
  );
  testContainer.container.registerInstance(
    v2CoreTokens.internalCommandBus,
    testContainer.container.resolve(v2CoreTokens.commandBus)
  );
  testContainer.container.registerInstance(v2CoreTokens.undoRedoStore, new MemoryUndoRedoStore());

  const commandBus = testContainer.container.resolve<ICommandBus>(v2CoreTokens.commandBus);
  const db = testContainer.container.resolve<Kysely<DynamicDb>>(v2DataDbTokens.db);
  const actorId = ActorId.create('system')._unsafeUnwrap();

  const context: IExecutionContext = {
    actorId,
    windowId: 'window-1',
  };

  const execute = async <TCommand extends IPublicCommand, TResult>(
    command: TCommand,
    commandContext: IExecutionContext = context
  ) => unwrap(await commandBus.execute<TCommand, TResult>(commandContext, command), 'execute');

  const undo = async (tableId: string, windowId = context.windowId!) => {
    probe.reset();
    const command = UndoCommand.create({ tableId, windowId })._unsafeUnwrap();
    return execute(command, { ...context, windowId });
  };

  const redo = async (tableId: string, windowId = context.windowId!) => {
    probe.reset();
    const command = RedoCommand.create({ tableId, windowId })._unsafeUnwrap();
    return execute(command, { ...context, windowId });
  };

  return {
    testContainer,
    container: testContainer.container,
    commandBus,
    db,
    probe,
    context,
    execute,
    undo,
    redo,
    dispose: () => testContainer.dispose(),
  };
};

export const createBasicTable = async (
  harness: Pick<UndoRedoDbHarness, 'execute' | 'testContainer'>,
  name: string
) => {
  const createTableCommand = CreateTableCommand.create({
    baseId: harness.testContainer.baseId.toString(),
    name,
    fields: [
      { type: 'singleLineText', name: 'Title', isPrimary: true },
      { type: 'number', name: 'Amount' },
    ],
    views: [{ type: 'grid' }],
  })._unsafeUnwrap();

  const result = await harness.execute<CreateTableCommand, CreateTableResult>(createTableCommand);
  return result.table;
};

export const createSelectTable = async (
  harness: Pick<UndoRedoDbHarness, 'execute' | 'testContainer'>,
  name: string
) => {
  const createTableCommand = CreateTableCommand.create({
    baseId: harness.testContainer.baseId.toString(),
    name,
    fields: [
      { type: 'singleLineText', name: 'Title', isPrimary: true },
      { type: 'singleSelect', name: 'Status', options: ['Open'] },
      { type: 'multipleSelect', name: 'Tags', options: ['Tag A'] },
    ],
    views: [{ type: 'grid' }],
  })._unsafeUnwrap();

  const result = await harness.execute<CreateTableCommand, CreateTableResult>(createTableCommand);
  return result.table;
};

export const findField = (table: Table, name: string) => {
  const field = table.getFields().find((item) => item.name().toString() === name);
  if (!field) {
    throw new Error(`Missing field ${name}`);
  }
  return field;
};

export const getSelectOptionNames = (table: Table, name: string) => {
  const field = findField(table, name) as unknown as {
    selectOptions(): Array<{ name(): { toString(): string } }>;
  };
  return field.selectOptions().map((option) => option.name().toString());
};

export const loadTable = async (
  harness: Pick<UndoRedoDbHarness, 'container' | 'context'>,
  table: Table
) => {
  const tableRepository = harness.container.resolve<ITableRepository>(v2CoreTokens.tableRepository);
  const specResult = TableAggregate.specs().byId(table.id()).build();
  const spec = unwrap(specResult, 'loadTable.spec');
  return unwrap(await tableRepository.findOne(harness.context, spec), 'loadTable.findOne');
};

export const getTableDbName = (table: Table) =>
  table.dbTableName()._unsafeUnwrap().value()._unsafeUnwrap();

export const getFieldDbName = (table: Table, name: string) =>
  findField(table, name).dbFieldName()._unsafeUnwrap().value()._unsafeUnwrap();

export const fetchRowById = async (
  db: Kysely<DynamicDb>,
  table: Table,
  recordId: string
): Promise<Record<string, unknown> | undefined> => {
  const rows = await db
    .selectFrom(getTableDbName(table))
    .selectAll()
    .where('__id', '=', recordId)
    .execute();
  return rows[0] as Record<string, unknown> | undefined;
};

export const listRows = async (
  db: Kysely<DynamicDb>,
  table: Table
): Promise<Array<Record<string, unknown>>> => {
  const rows = await db.selectFrom(getTableDbName(table)).selectAll().execute();
  return rows as Array<Record<string, unknown>>;
};

export const getViewId = (table: Table) => {
  const view = table.views()[0];
  if (!view) {
    throw new Error('Missing default view');
  }
  return view.id().toString();
};

export const listFieldIdsByViewOrder = (table: Table, viewId: string): string[] =>
  table
    .getOrderedVisibleFieldIds(viewId)
    ._unsafeUnwrap()
    .map((fieldId) => fieldId.toString());

export const listRowsByViewOrder = async (
  db: Kysely<DynamicDb>,
  table: Table,
  viewId: string
): Promise<Array<{ __id: string; order_value: number | null }>> => {
  const fullTableName = `${table.baseId().toString()}.${table.id().toString()}`;
  const result = await sql<{ __id: string; order_value: number | null }>`
    SELECT __id, ${sql.ref(`__row_${viewId}`)} as order_value
    FROM ${sql.table(fullTableName)}
    ORDER BY ${sql.ref(`__row_${viewId}`)} ASC
  `.execute(db);

  return result.rows;
};

export const disposeHarness = async (
  harness: { dispose: IV2NodeTestContainer['dispose'] } | undefined
) => {
  if (harness) {
    await harness.dispose();
  }
};
