import { inject, injectable } from '@teable/v2-di';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';

import { domainError, isNotFoundError, type DomainError } from '../domain/shared/DomainError';
import { RecordByIdsSpec } from '../domain/table/records/specs/RecordByIdsSpec';
import { TableRecord } from '../domain/table/records/TableRecord';
import { Table } from '../domain/table/Table';
import type { IExecutionContext } from '../ports/ExecutionContext';
import * as LoggerPort from '../ports/Logger';
import * as TableRecordQueryRepositoryPort from '../ports/TableRecordQueryRepository';
import * as TableRepositoryPort from '../ports/TableRepository';
import { v2CoreTokens } from '../ports/tokens';
import { GetViewFilterLinkRecordsQuery } from './GetViewFilterLinkRecordsQuery';
import { QueryHandler, type IQueryHandler } from './QueryHandler';

export type ViewFilterLinkRecord = {
  readonly id: string;
  readonly title?: string;
};

export type ViewFilterLinkRecordGroup = {
  readonly tableId: string;
  readonly records: ReadonlyArray<ViewFilterLinkRecord>;
};

export class GetViewFilterLinkRecordsResult {
  private constructor(readonly groups: ReadonlyArray<ViewFilterLinkRecordGroup>) {}

  static create(groups: ReadonlyArray<ViewFilterLinkRecordGroup>): GetViewFilterLinkRecordsResult {
    return new GetViewFilterLinkRecordsResult(groups);
  }
}

@QueryHandler(GetViewFilterLinkRecordsQuery)
@injectable()
export class GetViewFilterLinkRecordsHandler
  implements IQueryHandler<GetViewFilterLinkRecordsQuery, GetViewFilterLinkRecordsResult>
{
  constructor(
    @inject(v2CoreTokens.tableRepository)
    private readonly tableRepository: TableRepositoryPort.ITableRepository,
    @inject(v2CoreTokens.tableRecordQueryRepository)
    private readonly tableRecordQueryRepository: TableRecordQueryRepositoryPort.ITableRecordQueryRepository,
    @inject(v2CoreTokens.logger)
    private readonly logger: LoggerPort.ILogger
  ) {}

  async handle(
    context: IExecutionContext,
    query: GetViewFilterLinkRecordsQuery
  ): Promise<Result<GetViewFilterLinkRecordsResult, DomainError>> {
    const logger = this.logger
      .scope('query', {
        name: GetViewFilterLinkRecordsHandler.name,
      })
      .child({
        tableId: query.tableId.toString(),
        viewId: query.viewId.toString(),
      });
    logger.debug('GetViewFilterLinkRecordsHandler.start', {
      actorId: context.actorId.toString(),
    });

    const sourceSpecResult = Table.specs().byId(query.tableId).withViewId(query.viewId).build();
    if (sourceSpecResult.isErr()) return err(sourceSpecResult.error);

    const sourceTableResult = await this.tableRepository.findOne(context, sourceSpecResult.value);
    if (sourceTableResult.isErr()) {
      if (isNotFoundError(sourceTableResult.error)) {
        return err(
          domainError.notFound({
            code: 'view.not_found',
            message: `View not found: ${query.viewId.toString()}`,
          })
        );
      }
      return err(sourceTableResult.error);
    }

    const referencesResult = sourceTableResult.value.viewFilterLinkReferences(query.viewId);
    if (referencesResult.isErr()) return err(referencesResult.error);

    const groups: ViewFilterLinkRecordGroup[] = [];
    for (const reference of referencesResult.value) {
      const foreignSpecResult = Table.specs().byId(reference.foreignTableId).build();
      if (foreignSpecResult.isErr()) return err(foreignSpecResult.error);

      const foreignTableResult = await this.tableRepository.findOne(
        context,
        foreignSpecResult.value
      );
      if (foreignTableResult.isErr()) return err(foreignTableResult.error);

      const lookupFieldResult = foreignTableResult.value.getField((field) =>
        field.id().equals(reference.lookupFieldId)
      );
      if (lookupFieldResult.isErr()) continue;

      if (reference.recordIds.length === 0) {
        groups.push({
          tableId: reference.foreignTableId.toString(),
          records: [],
        });
        continue;
      }

      const recordsResult = await this.tableRecordQueryRepository.find(
        context,
        foreignTableResult.value,
        RecordByIdsSpec.create(reference.recordIds),
        {
          mode: 'stored',
          orderBy: [{ column: '__auto_number', direction: 'asc' }],
          projectionFieldIds: [reference.lookupFieldId],
          includeTotal: false,
        }
      );
      if (recordsResult.isErr()) return err(recordsResult.error);

      const records: ViewFilterLinkRecord[] = [];
      for (const record of recordsResult.value.records) {
        const domainRecordResult = TableRecord.fromRawFieldValues({
          id: record.id,
          tableId: foreignTableResult.value.id(),
          fields: record.fields,
        });
        if (domainRecordResult.isErr()) return err(domainRecordResult.error);

        const titleResult = domainRecordResult.value.displayValue(
          foreignTableResult.value,
          reference.lookupFieldId
        );
        if (titleResult.isErr()) return err(titleResult.error);

        records.push({
          id: record.id,
          ...(titleResult.value ? { title: titleResult.value } : {}),
        });
      }

      groups.push({
        tableId: reference.foreignTableId.toString(),
        records,
      });
    }

    logger.debug('GetViewFilterLinkRecordsHandler.success', {
      groupCount: groups.length,
    });
    return ok(GetViewFilterLinkRecordsResult.create(groups));
  }
}
