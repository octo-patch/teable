import { inject, injectable } from '@teable/v2-di';
import { err, ok, safeTry } from 'neverthrow';
import type { Result } from 'neverthrow';

import { FieldKeyResolverService } from '../application/services/FieldKeyResolverService';
import {
  mergeOrderBy,
  resolveGroupByToOrderBy,
  resolveOrderBy as resolveQueryOrderBy,
} from '../commands/shared/orderBy';
import { domainError, isNotFoundError, type DomainError } from '../domain/shared/DomainError';
import { composeAndSpecsOrUndefined } from '../domain/shared/specification/composeAndSpecs';
import { type ISpecification } from '../domain/shared/specification/ISpecification';
import { FieldId } from '../domain/table/fields/FieldId';
import { FieldKeyType } from '../domain/table/fields/FieldKeyType';
import { FieldCondition } from '../domain/table/fields/types/FieldCondition';
import type { LinkField } from '../domain/table/fields/types/LinkField';
import { RecordId } from '../domain/table/records/RecordId';
import { IncomingLinkCandidateSpec } from '../domain/table/records/specs/IncomingLinkCandidateSpec';
import { IncomingLinkSelectedSpec } from '../domain/table/records/specs/IncomingLinkSelectedSpec';
import type { ITableRecordConditionSpecVisitor } from '../domain/table/records/specs/ITableRecordConditionSpecVisitor';
import { RecordByIdsSpec } from '../domain/table/records/specs/RecordByIdsSpec';
import { RecordConditionSpecBuilder } from '../domain/table/records/specs/RecordConditionSpecBuilder';
import { TableRecord } from '../domain/table/records/TableRecord';
import { TableByIdSpec } from '../domain/table/specs/TableByIdSpec';
import { TableByIncomingReferenceToTableSpec } from '../domain/table/specs/TableByIncomingReferenceToTableSpec';
import type { Table } from '../domain/table/Table';
import type { ViewQueryGroupItem } from '../domain/table/views/ViewQueryDefaults';
import { NoopTableQueryObservability } from '../ports/defaults/NoopTableQueryObservability';
import type { IExecutionContext } from '../ports/ExecutionContext';
import * as LoggerPort from '../ports/Logger';
import type { RecordQueryFieldMask } from '../ports/RecordQueryPlugin';
import { ITableQueryObservability } from '../ports/TableQueryObservability';
import type { TableQueryObservabilityEvent } from '../ports/TableQueryObservability';
import {
  createSearchTraceAttributes,
  createTableQueryTraceAttributes,
  type TableSearchAccessPath,
  type TableSearchMode,
  type TableSearchScope,
} from '../ports/TableQueryTraceAttributes';
import * as TableRecordQueryRepositoryPort from '../ports/TableRecordQueryRepository';
import type { ITableRecordGroup } from '../ports/TableRecordQueryRepository';
import type { TableRecordReadModel } from '../ports/TableRecordReadModel';
import * as TableRepositoryPort from '../ports/TableRepository';
import { v2CoreTokens } from '../ports/tokens';
import { ListTableRecordsQuery, type RecordSortValue } from './ListTableRecordsQuery';
import { QueryHandler, type IQueryHandler } from './QueryHandler';
import {
  isRecordFilterCondition,
  isRecordFilterFieldReferenceValue,
  isRecordFilterGroup,
  isRecordFilterNot,
  type RecordFilter,
  type RecordFilterCondition,
  type RecordFilterNode,
} from './RecordFilterDto';
import {
  buildRecordConditionSpec,
  replaceCurrentUserTagInFilter,
  sanitizeRecordFilter,
} from './RecordFilterMapper';
import { RecordSearch, resolveVisibleRowSearch } from './RecordSearch';

export class ListTableRecordsResult {
  private constructor(
    readonly records: ReadonlyArray<TableRecordReadModel>,
    readonly total: number,
    readonly offset: number,
    readonly limit: number,
    readonly groups?: ReadonlyArray<ITableRecordGroup>,
    readonly searchMatches?: ReadonlyArray<TableRecordQueryRepositoryPort.ITableRecordSearchMatch>
  ) {}

  static create(
    records: ReadonlyArray<TableRecordReadModel>,
    total: number,
    offset: number,
    limit: number,
    groups?: ReadonlyArray<ITableRecordGroup>,
    searchMatches?: ReadonlyArray<TableRecordQueryRepositoryPort.ITableRecordSearchMatch>
  ): ListTableRecordsResult {
    return new ListTableRecordsResult(records, total, offset, limit, groups, searchMatches);
  }
}

/**
 * Resolve field keys in filter to field IDs
 * Recursively walks the filter tree and resolves fieldId keys
 */
function resolveFilterFieldKeys(
  table: Table,
  filter: RecordFilter,
  fieldKeyType: FieldKeyType
): Result<RecordFilter, DomainError> {
  if (!filter) {
    return ok(null);
  }

  return resolveFilterNodeFieldKeys(table, filter, fieldKeyType);
}

function resolveFilterNodeFieldKeys(
  table: Table,
  node: RecordFilterNode,
  fieldKeyType: FieldKeyType
): Result<RecordFilterNode, DomainError> {
  // If already using field IDs, no resolution needed
  if (fieldKeyType === FieldKeyType.Id) {
    return ok(node);
  }

  if (isRecordFilterCondition(node)) {
    // Resolve the condition's fieldId
    const fieldIdResult = FieldKeyResolverService.resolveFieldKey(
      table,
      node.fieldId,
      fieldKeyType
    );
    if (fieldIdResult.isErr()) {
      return err(fieldIdResult.error);
    }

    const resolvedCondition: RecordFilterCondition = {
      ...node,
      fieldId: fieldIdResult.value,
    };

    // Also resolve field reference in value if present
    if (
      node.value &&
      typeof node.value === 'object' &&
      isRecordFilterFieldReferenceValue(node.value)
    ) {
      const valueFieldIdResult = FieldKeyResolverService.resolveFieldKey(
        table,
        node.value.fieldId,
        fieldKeyType
      );
      if (valueFieldIdResult.isErr()) {
        return err(valueFieldIdResult.error);
      }

      return ok({
        ...resolvedCondition,
        value: {
          ...node.value,
          fieldId: valueFieldIdResult.value,
        },
      });
    }

    return ok(resolvedCondition);
  }

  if (isRecordFilterGroup(node)) {
    // Resolve all items in the group
    const resolvedItems: RecordFilterNode[] = [];
    for (const item of node.items) {
      const resolved = resolveFilterNodeFieldKeys(table, item, fieldKeyType);
      if (resolved.isErr()) {
        return resolved;
      }
      resolvedItems.push(resolved.value);
    }

    return ok({
      conjunction: node.conjunction,
      items: resolvedItems,
    });
  }

  if (isRecordFilterNot(node)) {
    // Resolve the not node
    return resolveFilterNodeFieldKeys(table, node.not, fieldKeyType).map((resolvedNot) => ({
      not: resolvedNot,
    }));
  }

  return ok(node);
}

const getEnabledFieldIdSet = (query: ListTableRecordsQuery): ReadonlySet<string> | undefined => {
  // Prefer pure-V2 query scope field allow-list over legacy CTE enabledFieldIds.
  if (query.queryScope?.readableFieldIds != null) {
    return query.queryScope.readableFieldIds;
  }
  const enabledFieldIds = query.recordReadQuerySource?.enabledFieldIds;
  return enabledFieldIds ? new Set(enabledFieldIds) : undefined;
};

/**
 * Collect field ids referenced by a condition specification tree
 * (left/right field of conditions + field-reference values).
 * Used so mask evaluation can load dependency columns that are not returned.
 */
const collectFieldIdsFromSpec = (spec: unknown): ReadonlySet<string> => {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    const candidate = node as {
      leftSpec?: () => unknown;
      rightSpec?: () => unknown;
      innerSpec?: () => unknown;
      field?: () => { id: () => { toString: () => string } };
      value?: () => unknown;
    };
    if (typeof candidate.leftSpec === 'function' && typeof candidate.rightSpec === 'function') {
      walk(candidate.leftSpec());
      walk(candidate.rightSpec());
      return;
    }
    if (typeof candidate.innerSpec === 'function') {
      walk(candidate.innerSpec());
      return;
    }
    if (typeof candidate.field === 'function') {
      try {
        ids.add(candidate.field().id().toString());
      } catch {
        // ignore non-field specs
      }
    }
    if (typeof candidate.value === 'function') {
      const value = candidate.value();
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as { field?: unknown }).field === 'function'
      ) {
        try {
          ids.add(
            (value as { field: () => { id: () => { toString: () => string } } })
              .field()
              .id()
              .toString()
          );
        } catch {
          // ignore
        }
      }
    }
  };
  walk(spec);
  return ids;
};

const collectMaskDependencyFieldIds = (
  fieldMasks: ReadonlyArray<RecordQueryFieldMask> | undefined
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const mask of fieldMasks ?? []) {
    for (const fieldId of collectFieldIdsFromSpec(mask.visibleWhen)) {
      ids.add(fieldId);
    }
  }
  return ids;
};

/**
 * Apply conditional field masks (visibleWhen) after read.
 * Fields that fail the mask are omitted from the result payload (null-out).
 *
 * Fail-closed: if a mask dependency field was not loaded into the evaluation
 * projection, the masked field is stripped (never fail-open on missing deps).
 */
const applyFieldMasksToRecords = (
  table: Table,
  records: ReadonlyArray<TableRecordReadModel>,
  fieldMasks: ReadonlyArray<RecordQueryFieldMask> | undefined,
  evaluationFieldIds?: ReadonlySet<string>
): ReadonlyArray<TableRecordReadModel> => {
  if (!fieldMasks?.length || !records.length) {
    return records;
  }

  const maskDepsByFieldId = new Map(
    fieldMasks.map((mask) => [mask.fieldId, collectFieldIdsFromSpec(mask.visibleWhen)] as const)
  );

  return records.map((record) => {
    const domainRecordResult = TableRecord.fromRawFieldValues({
      id: record.id,
      tableId: table.id(),
      fields: record.fields,
    });
    // Fail-closed: if we cannot evaluate masks, strip all masked fields.
    if (domainRecordResult.isErr()) {
      const nextFields = { ...record.fields };
      for (const mask of fieldMasks) {
        delete nextFields[mask.fieldId];
      }
      return { ...record, fields: nextFields };
    }
    const domainRecord = domainRecordResult.value;
    let changed = false;
    const nextFields = { ...record.fields };
    for (const mask of fieldMasks) {
      if (!Object.prototype.hasOwnProperty.call(nextFields, mask.fieldId)) {
        continue;
      }
      const deps = maskDepsByFieldId.get(mask.fieldId);
      // Fail-closed when a dependency was never loaded into the evaluation
      // projection. (isEmpty/isNot on undefined fail-open — do not evaluate.)
      // Null values that were projected still evaluate normally.
      const missingFromProjection =
        evaluationFieldIds != null &&
        deps != null &&
        [...deps].some((depId) => !evaluationFieldIds.has(depId));
      if (missingFromProjection) {
        delete nextFields[mask.fieldId];
        changed = true;
        continue;
      }
      if (!mask.visibleWhen.isSatisfiedBy(domainRecord)) {
        delete nextFields[mask.fieldId];
        changed = true;
      }
    }
    return changed ? { ...record, fields: nextFields } : record;
  });
};

type UnreadableFilterFieldPolicy = 'reject' | 'strip';

/**
 * Apply the static readable-field allow-list to a filter.
 *
 * Explicit client filters reject unreadable fields so the query cannot silently
 * broaden. Persisted view defaults strip stale unreadable fields so permission
 * changes do not make the view unusable.
 */
const sanitizeFilterByEnabledFieldIds = (
  filter: RecordFilter | undefined,
  enabledFieldIds: ReadonlySet<string> | undefined,
  maskedFieldIds: ReadonlySet<string> | undefined,
  unreadableFieldPolicy: UnreadableFilterFieldPolicy
): Result<RecordFilter | undefined, DomainError> => {
  if (!filter || (enabledFieldIds == null && maskedFieldIds == null)) {
    return ok(filter);
  }

  const unreadableFieldResult = (): Result<undefined, DomainError> =>
    unreadableFieldPolicy === 'reject'
      ? err(
          domainError.validation({
            code: 'record.filter.unreadable_field',
            message: 'Filter references a field that is not readable',
          })
        )
      : ok(undefined);

  const sanitizeNode = (
    node: RecordFilterNode
  ): Result<RecordFilterNode | undefined, DomainError> => {
    if (isRecordFilterCondition(node)) {
      if (enabledFieldIds != null && !enabledFieldIds.has(node.fieldId)) {
        return unreadableFieldResult();
      }
      if (isRecordFilterFieldReferenceValue(node.value)) {
        if (enabledFieldIds != null && !enabledFieldIds.has(node.value.fieldId)) {
          return unreadableFieldResult();
        }
        if (maskedFieldIds?.has(node.value.fieldId)) {
          return err(
            domainError.validation({
              code: 'record.filter.masked_field_reference',
              message:
                'Filter field reference to a conditionally masked field is not allowed until mask-aware SQL is available',
            })
          );
        }
        // LHS masked + field-ref RHS: NULL truth is row-dependent — fail closed.
        if (maskedFieldIds?.has(node.fieldId)) {
          return err(
            domainError.validation({
              code: 'record.filter.masked_field_reference_lhs',
              message:
                'Filter comparing a conditionally masked field to another field is not allowed until mask-aware SQL CASE WHEN is available',
            })
          );
        }
      }
      return ok(node);
    }

    if (isRecordFilterGroup(node)) {
      const items: RecordFilterNode[] = [];
      for (const item of node.items) {
        const next = sanitizeNode(item);
        if (next.isErr()) return err(next.error);
        if (next.value != null) items.push(next.value);
      }
      return ok(
        items.length
          ? {
              conjunction: node.conjunction,
              items,
            }
          : undefined
      );
    }

    if (isRecordFilterNot(node)) {
      return sanitizeNode(node.not).map((nextNode) => (nextNode ? { not: nextNode } : undefined));
    }

    return ok(node);
  };

  return sanitizeNode(filter);
};

/** Static allow-list for server-owned view defaults only. */
const filterSortByEnabledFieldIds = (
  sort: ReadonlyArray<RecordSortValue> | undefined,
  enabledFieldIds: ReadonlySet<string> | undefined
): ReadonlyArray<RecordSortValue> | undefined => {
  if (!sort?.length || enabledFieldIds == null) {
    return sort;
  }
  const filtered = sort.filter((item) => enabledFieldIds.has(item.fieldId));
  return filtered.length ? filtered : undefined;
};

const filterGroupByEnabledFieldIds = (
  group: ReadonlyArray<ViewQueryGroupItem> | undefined,
  enabledFieldIds: ReadonlySet<string> | undefined
): ReadonlyArray<ViewQueryGroupItem> | undefined => {
  if (!group?.length || enabledFieldIds == null) {
    return group;
  }
  const filtered = group.filter((item) => enabledFieldIds.has(item.fieldId));
  return filtered.length ? filtered : undefined;
};

const rejectUnreadableSortOrGroup = (
  kind: 'sort' | 'group',
  items: ReadonlyArray<{ fieldId: string }> | undefined,
  enabledFieldIds: ReadonlySet<string> | undefined
): Result<void, DomainError> => {
  if (!items?.length || enabledFieldIds == null) {
    return ok(undefined);
  }
  if (!items.some((item) => !enabledFieldIds.has(item.fieldId))) {
    return ok(undefined);
  }
  return err(
    domainError.validation({
      code: `record.${kind}.unreadable_field`,
      message: `${kind === 'sort' ? 'Sort' : 'Group'} references a field that is not readable`,
    })
  );
};

const rejectMaskedSortOrGroup = (
  kind: 'sort' | 'group',
  items: ReadonlyArray<{ fieldId: string }> | undefined,
  maskedFieldIds: ReadonlySet<string> | undefined
): Result<void, DomainError> => {
  if (!items?.length || !maskedFieldIds?.size) {
    return ok(undefined);
  }
  const masked = items.find((item) => maskedFieldIds.has(item.fieldId));
  if (!masked) {
    return ok(undefined);
  }
  return err(
    domainError.validation({
      code: `record.${kind}.masked_field`,
      message: `${kind === 'sort' ? 'Sort' : 'Group'} on a conditionally masked field is not allowed until mask-aware SQL CASE WHEN is available`,
    })
  );
};

const nowMs = () => Date.now();

const resolveSearchAccessPath = (
  query: ListTableRecordsQuery,
  visibleRowSearch: ReturnType<typeof resolveVisibleRowSearch>,
  resolution?: TableRecordQueryRepositoryPort.IRecordSearchAccessPathResolution
): {
  accessPath: TableSearchAccessPath;
  searchMode: TableSearchMode;
  searchScope: TableSearchScope;
  fallbackReason?: string;
  languageConfig?: string;
  generatedColumnName?: string;
  indexProvider?: 'pg_trgm' | 'pg_bigm';
} => {
  if (!visibleRowSearch) {
    return {
      accessPath: 'none',
      searchMode: 'none',
      searchScope: 'none',
      ...(query.recordSearchAccessPath?.kind === 'generated_tsvector' ||
      query.recordSearchAccessPath?.kind === 'generated_text'
        ? { fallbackReason: 'no_visible_row_search' }
        : {}),
    };
  }

  const searchScope = visibleRowSearch.search.searchesAllFields()
    ? 'all_fields'
    : 'selected_fields';
  if (query.recordSearchAccessPath?.kind === 'generated_text') {
    if (resolution?.used === 'default') {
      return {
        accessPath: 'fallback',
        searchMode: 'ilike',
        searchScope,
        fallbackReason: resolution.fallbackReason ?? 'generated_text_unavailable',
      };
    }
    if (resolution?.used !== 'generated_text') {
      return { accessPath: 'none', searchMode: 'none', searchScope };
    }
    return {
      accessPath:
        query.recordSearchAccessPath.provider === 'pg_bigm'
          ? 'generated_text_bigram'
          : 'generated_text_trigram',
      searchMode: 'substring',
      searchScope,
      generatedColumnName: query.recordSearchAccessPath.generatedColumnName,
      indexProvider: query.recordSearchAccessPath.provider,
    };
  }
  if (query.recordSearchAccessPath?.kind === 'generated_tsvector') {
    if (resolution?.used === 'default') {
      return {
        accessPath: 'fallback',
        searchMode: 'ilike',
        searchScope,
        fallbackReason: resolution.fallbackReason ?? 'generated_tsvector_unavailable',
      };
    }
    if (resolution?.used !== 'generated_tsvector') {
      return { accessPath: 'none', searchMode: 'none', searchScope };
    }
    return {
      accessPath: 'generated_tsvector',
      searchMode: 'full_text',
      searchScope,
      languageConfig: query.recordSearchAccessPath.languageConfig,
      generatedColumnName: query.recordSearchAccessPath.generatedColumnName,
    };
  }

  return {
    accessPath: 'default_ilike',
    searchMode: 'ilike',
    searchScope,
  };
};

const createListRecordsObservabilityEvent = (
  query: ListTableRecordsQuery,
  input?: {
    readonly hasFilter?: boolean;
    readonly hasSort?: boolean;
    readonly hasGroup?: boolean;
    readonly visibleRowSearch?: ReturnType<typeof resolveVisibleRowSearch>;
    readonly searchAccessPath?: TableRecordQueryRepositoryPort.IRecordSearchAccessPathResolution;
    readonly resultCount?: number;
    readonly errorKind?: string;
    readonly durationMs?: number;
  }
): TableQueryObservabilityEvent => {
  const visibleRowSearch = input?.visibleRowSearch;
  const searchPath = resolveSearchAccessPath(query, visibleRowSearch, input?.searchAccessPath);

  return {
    tableId: query.tableId.toString(),
    viewId: query.viewId,
    queryKind: visibleRowSearch ? 'search' : 'record_list',
    querySource: 'v2.list_records',
    hasFilter: input?.hasFilter ?? Boolean(query.filter),
    hasSort: input?.hasSort ?? Boolean(query.sort?.length),
    hasGroup: input?.hasGroup ?? Boolean(query.groupBy?.length),
    includeTotal: query.includeTotal !== false,
    searchValue: visibleRowSearch?.search.value,
    fieldCount: visibleRowSearch?.visibleFieldIds?.length,
    allFields: visibleRowSearch?.search.searchesAllFields(),
    accessPath: searchPath.accessPath,
    searchMode: searchPath.searchMode,
    searchScope: searchPath.searchScope,
    languageConfig: searchPath.languageConfig,
    fallbackReason: searchPath.fallbackReason,
    generatedColumnName: searchPath.generatedColumnName,
    indexProvider: searchPath.indexProvider,
    resultCount: input?.resultCount,
    errorKind: input?.errorKind,
    durationMs: input?.durationMs,
  };
};

type ListRecordsQueryPlan = {
  readonly spec?: ISpecification<TableRecord, ITableRecordConditionSpecVisitor>;
  readonly recordIdsOrder?: ReadonlyArray<RecordId>;
};

const mergeFilterWithViewDefaults = (
  defaultFilter: RecordFilter | null | undefined,
  queryFilter: RecordFilter | undefined
): RecordFilter | undefined => {
  if (!defaultFilter && !queryFilter) {
    return undefined;
  }

  if (queryFilter) {
    return defaultFilter
      ? {
          conjunction: 'and',
          items: [defaultFilter, queryFilter],
        }
      : queryFilter;
  }

  return defaultFilter ?? undefined;
};

const resolveSortValues = (
  table: Table,
  sort: ReadonlyArray<RecordSortValue> | undefined,
  fieldKeyType: FieldKeyType,
  enabledFieldIds?: ReadonlySet<string>
): Result<ReadonlyArray<RecordSortValue> | undefined, DomainError> => {
  const resolvedSort: RecordSortValue[] = [];
  const seen = new Set<string>();

  for (const item of sort ?? []) {
    const resolvedFieldId = FieldKeyResolverService.resolveFieldKey(
      table,
      item.fieldId,
      fieldKeyType
    );
    if (resolvedFieldId.isErr()) {
      return err(resolvedFieldId.error);
    }

    const fieldId = FieldId.create(resolvedFieldId.value);
    if (fieldId.isErr()) {
      return err(fieldId.error);
    }

    const normalizedFieldId = fieldId.value.toString();
    if (enabledFieldIds && !enabledFieldIds.has(normalizedFieldId)) {
      continue;
    }

    const key = `field:${normalizedFieldId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resolvedSort.push({
      fieldId: normalizedFieldId,
      order: item.order,
    });
  }

  return ok(resolvedSort.length ? resolvedSort : undefined);
};

const mergeSortWithViewDefaults = (
  defaultSort: ReadonlyArray<RecordSortValue> | undefined,
  manualSort: boolean | undefined,
  querySort: ReadonlyArray<RecordSortValue> | undefined
): ReadonlyArray<RecordSortValue> | undefined => {
  if (!defaultSort && !querySort) {
    return undefined;
  }

  if (manualSort && !querySort?.length) {
    return [];
  }

  if (!defaultSort?.length) {
    return querySort ? [...querySort] : undefined;
  }

  if (!querySort?.length) {
    return [...defaultSort];
  }

  const map = new Map(querySort.map((item) => [item.fieldId, item]));
  defaultSort.forEach((item) => {
    if (!map.has(item.fieldId)) {
      map.set(item.fieldId, item);
    }
  });
  return Array.from(map.values());
};

const filterFieldIdsByEnabledFieldIds = (
  fieldIds: ReadonlyArray<FieldId>,
  enabledFieldIds: ReadonlySet<string> | undefined
): ReadonlyArray<FieldId> => {
  if (enabledFieldIds == null) {
    return fieldIds;
  }

  return fieldIds.filter((fieldId) => enabledFieldIds.has(fieldId.toString()));
};

const resolveProjectionFieldIds = (
  table: Table,
  projection: ReadonlyArray<string> | undefined,
  fieldKeyType: FieldKeyType,
  enabledFieldIds?: ReadonlySet<string>
): Result<ReadonlyArray<FieldId> | undefined, DomainError> => {
  // undefined projection + unrestricted → all columns (repo default).
  // undefined projection + allow-list → only allow-list (empty set → []).
  // Never treat empty allow-list as unrestricted.
  if (projection === undefined) {
    if (enabledFieldIds == null) {
      return ok(undefined);
    }
    const fieldIds: FieldId[] = [];
    for (const fieldIdText of enabledFieldIds) {
      const fieldId = FieldId.create(fieldIdText);
      if (fieldId.isOk()) {
        fieldIds.push(fieldId.value);
      }
    }
    return ok(fieldIds);
  }

  const fieldIds: FieldId[] = [];
  const seen = new Set<string>();
  for (const fieldKey of projection) {
    const resolvedFieldId = FieldKeyResolverService.resolveFieldKey(table, fieldKey, fieldKeyType);
    if (resolvedFieldId.isErr()) {
      return err(resolvedFieldId.error);
    }
    if (enabledFieldIds != null && !enabledFieldIds.has(resolvedFieldId.value)) {
      continue;
    }
    if (seen.has(resolvedFieldId.value)) {
      continue;
    }
    const fieldId = FieldId.create(resolvedFieldId.value);
    if (fieldId.isErr()) {
      return err(fieldId.error);
    }
    seen.add(resolvedFieldId.value);
    fieldIds.push(fieldId.value);
  }

  return ok(fieldIds);
};

@QueryHandler(ListTableRecordsQuery)
@injectable()
export class ListTableRecordsHandler
  implements IQueryHandler<ListTableRecordsQuery, ListTableRecordsResult>
{
  constructor(
    @inject(v2CoreTokens.tableRepository)
    private readonly tableRepository: TableRepositoryPort.ITableRepository,
    @inject(v2CoreTokens.tableRecordQueryRepository)
    private readonly tableRecordQueryRepository: TableRecordQueryRepositoryPort.ITableRecordQueryRepository,
    @inject(v2CoreTokens.logger)
    private readonly logger: LoggerPort.ILogger,
    @inject(v2CoreTokens.tableQueryObservability)
    private readonly tableQueryObservability: ITableQueryObservability = new NoopTableQueryObservability()
  ) {}

  async handle(
    context: IExecutionContext,
    query: ListTableRecordsQuery
  ): Promise<Result<ListTableRecordsResult, DomainError>> {
    const logger = this.logger.scope('query', { name: ListTableRecordsHandler.name }).child({
      tableId: query.tableId.toString(),
    });
    logger.debug('ListTableRecordsHandler.start', { actorId: context.actorId.toString() });

    const startedAt = nowMs();
    let observabilityEvent = createListRecordsObservabilityEvent(query);
    const span = context.tracer?.startSpan('teable.table.query.list_records', {
      ...createTableQueryTraceAttributes(observabilityEvent),
      ...createSearchTraceAttributes(observabilityEvent),
    });

    try {
      const result = await safeTry<ListTableRecordsResult, DomainError>(
        async function* (this: ListTableRecordsHandler) {
          // 1. Load main table (tableId is globally unique)
          const loadTableSpan = context.tracer?.startSpan(
            'teable.ListTableRecordsHandler.loadTable'
          );
          const tableSpec = TableByIdSpec.create(query.tableId);
          const table = yield* (await this.tableRepository.findOne(context, tableSpec)).mapErr(
            (error: DomainError) =>
              isNotFoundError(error)
                ? domainError.notFound({ code: 'table.not_found', message: 'Table not found' })
                : error
          );
          loadTableSpan?.end();

          // 2. Resolve effective filter/sort/search inputs with view defaults and permission-aware fields.
          const enabledFieldIds = getEnabledFieldIdSet(query);
          let effectiveFilter: RecordFilter | undefined;
          let effectiveSort: ReadonlyArray<RecordSortValue> | undefined;
          let effectiveGroup: ReadonlyArray<ViewQueryGroupItem> | undefined;
          let orderBy: ReturnType<typeof mergeOrderBy> | undefined;
          let queryPlan: ListRecordsQueryPlan | undefined;
          let projectionFieldIds: ReadonlyArray<FieldId> | undefined;
          const resolveShapeSpan = context.tracer?.startSpan('teable.table.query.resolve_shape', {
            ...createTableQueryTraceAttributes(observabilityEvent),
            ...createSearchTraceAttributes(observabilityEvent),
          });
          try {
            const resolvedFilter = query.filter
              ? yield* resolveFilterFieldKeys(table, query.filter, query.fieldKeyType)
              : undefined;
            const actorResolvedFilter = replaceCurrentUserTagInFilter(
              table,
              resolvedFilter,
              context.actorId.toString()
            );

            // Pre-resolve link candidate plan so filterByViewId can inform effectiveView.
            const linkCandidatePlan = query.filterLinkCellCandidate
              ? yield* await this.buildLinkCandidatePlan(
                  context,
                  table,
                  query.filterLinkCellCandidate
                )
              : undefined;

            // query.viewId takes priority; fall back to the link field's filterByViewId.
            let effectiveView =
              query.viewId && !query.ignoreViewQuery
                ? yield* table.getViewById(query.viewId)
                : undefined;
            if (!effectiveView && linkCandidatePlan?.filterByViewId && !query.ignoreViewQuery) {
              const fallbackViewResult = table.getViewById(linkCandidatePlan.filterByViewId);
              if (fallbackViewResult.isOk()) {
                effectiveView = fallbackViewResult.value;
              }
              // silently ignore if the view no longer exists
            }
            const resolvedSort = yield* resolveSortValues(table, query.sort, query.fieldKeyType);
            const effectiveQueryDefaults = effectiveView
              ? yield* effectiveView.queryDefaults()
              : undefined;
            const defaultFilter = replaceCurrentUserTagInFilter(
              table,
              effectiveQueryDefaults?.filter(),
              context.actorId.toString()
            );
            const sanitizedDefaultFilter = yield* sanitizeRecordFilter(table, defaultFilter);
            // Conditionally masked fields: reject sort/group/search + RHS filter
            // refs until SQL CASE WHEN (never silent drop). LHS filter uses
            // three-valued mask rewrite in buildRecordConditionSpec.
            const maskedFieldIds = query.queryScope?.fieldMasks?.length
              ? new Set(query.queryScope.fieldMasks.map((mask) => mask.fieldId))
              : undefined;
            const permissionSanitizedDefaultFilter = yield* sanitizeFilterByEnabledFieldIds(
              sanitizedDefaultFilter,
              enabledFieldIds,
              maskedFieldIds,
              'strip'
            );
            const permissionValidatedClientFilter = yield* sanitizeFilterByEnabledFieldIds(
              actorResolvedFilter,
              enabledFieldIds,
              maskedFieldIds,
              'reject'
            );
            effectiveFilter = mergeFilterWithViewDefaults(
              permissionSanitizedDefaultFilter,
              permissionValidatedClientFilter
            );
            // Resolve groupBy to field IDs (same path as sort) before masked
            // reject / subtraction — raw keys may be name/dbFieldName.
            const resolvedGroupFieldIds: string[] = [];
            for (const groupKey of query.groupBy ?? []) {
              const groupFieldId = yield* FieldKeyResolverService.resolveFieldKey(
                table,
                groupKey,
                query.fieldKeyType
              );
              resolvedGroupFieldIds.push(groupFieldId);
            }
            const clientGroupFieldIds = new Set(resolvedGroupFieldIds);
            // Group first so pure groupBy is not mislabeled as sort (OpenAPI
            // merges groupBy into sort before calling list).
            yield* rejectUnreadableSortOrGroup(
              'group',
              resolvedGroupFieldIds.map((fieldId) => ({ fieldId })),
              enabledFieldIds
            );
            yield* rejectMaskedSortOrGroup(
              'group',
              resolvedGroupFieldIds.map((fieldId) => ({ fieldId })),
              maskedFieldIds
            );
            // Sort-only keys: exclude groupBy fields that were folded into sort.
            const clientSortOnly = resolvedSort?.filter(
              (item) => !clientGroupFieldIds.has(item.fieldId)
            );
            yield* rejectUnreadableSortOrGroup('sort', clientSortOnly, enabledFieldIds);
            yield* rejectMaskedSortOrGroup('sort', clientSortOnly, maskedFieldIds);
            // View-default sort/group may still mention masked fields — strip only
            // those defaults (not client-provided keys, which were rejected above).
            const viewDefaultSort = mergeSortWithViewDefaults(
              effectiveQueryDefaults?.sort(),
              effectiveQueryDefaults?.manualSort(),
              undefined
            )?.filter((item) => !maskedFieldIds?.has(item.fieldId));
            effectiveSort = filterSortByEnabledFieldIds(
              mergeSortWithViewDefaults(viewDefaultSort, undefined, resolvedSort),
              enabledFieldIds
            );
            effectiveGroup = filterGroupByEnabledFieldIds(
              query.groupBy?.length
                ? resolvedGroupFieldIds.map((fieldId) => ({
                    fieldId,
                    order:
                      resolvedSort?.find((item) => item.fieldId === fieldId)?.order ??
                      ('asc' as const),
                  }))
                : effectiveQueryDefaults
                    ?.group()
                    ?.filter((item) => !maskedFieldIds?.has(item.fieldId)),
              enabledFieldIds
            );
            orderBy = mergeOrderBy(
              yield* resolveGroupByToOrderBy(effectiveGroup),
              yield* resolveQueryOrderBy(effectiveSort),
              query.viewId
            );
            const builtQueryPlan = yield* await this.buildQueryPlan(
              context,
              table,
              query,
              effectiveFilter,
              linkCandidatePlan
            );
            // AND pure-V2 permission row scope into the condition tree
            // (unless link-selected keepPrimary / skipRecordSpec).
            const rowScopeSpec =
              query.queryScope?.skipRecordSpec || !query.queryScope?.recordSpec
                ? undefined
                : query.queryScope.recordSpec;
            queryPlan = {
              ...builtQueryPlan,
              spec: composeAndSpecsOrUndefined(
                [builtQueryPlan.spec, rowScopeSpec].filter(
                  (spec): spec is ISpecification<TableRecord, ITableRecordConditionSpecVisitor> =>
                    spec != null
                )
              ),
            };
            projectionFieldIds = yield* resolveProjectionFieldIds(
              table,
              query.projection,
              query.fieldKeyType,
              enabledFieldIds
            );
            // Expand projection with static readable fields + mask dependency
            // fields so visibleWhen evaluation is not fail-open on missing columns.
            // Dependencies are never returned — stripped after mask apply.
            if (query.queryScope?.fieldMasks?.length) {
              const maskDeps = collectMaskDependencyFieldIds(query.queryScope.fieldMasks);
              // No projection + no allow-list means "all columns" — seed with
              // every table field so expansion cannot collapse to mask deps.
              const baseFieldIds =
                projectionFieldIds == null && enabledFieldIds == null
                  ? table.fieldIds().map((id) => id.toString())
                  : [
                      ...(projectionFieldIds?.map((id) => id.toString()) ?? []),
                      ...(enabledFieldIds ?? []),
                    ];
              const expanded = new Set([...baseFieldIds, ...maskDeps]);
              const expandedIds: FieldId[] = [];
              for (const fieldIdText of expanded) {
                const fieldId = FieldId.create(fieldIdText);
                if (fieldId.isOk()) {
                  expandedIds.push(fieldId.value);
                }
              }
              projectionFieldIds = expandedIds;
            }
            observabilityEvent = createListRecordsObservabilityEvent(query, {
              hasFilter: Boolean(effectiveFilter),
              hasSort: Boolean(effectiveSort?.length),
              hasGroup: Boolean(effectiveGroup?.length),
            });
            span?.setAttributes({
              ...createTableQueryTraceAttributes(observabilityEvent),
              ...createSearchTraceAttributes(observabilityEvent),
            });
            resolveShapeSpan?.setAttributes({
              ...createTableQueryTraceAttributes(observabilityEvent),
              ...createSearchTraceAttributes(observabilityEvent),
            });
          } finally {
            resolveShapeSpan?.end();
          }

          // 3. Resolve visible-row search through the repository.
          // Conditionally masked fields: reject when the client targets them
          // explicitly (id / name / dbFieldName via RecordSearch resolver);
          // for all-fields search, exclude them from the search set.
          const searchMaskedFieldIds = query.queryScope?.fieldMasks?.length
            ? new Set(query.queryScope.fieldMasks.map((mask) => mask.fieldId))
            : undefined;
          const requestedSearch = RecordSearch.fromOptionalTuple(query.search);
          if (
            requestedSearch &&
            searchMaskedFieldIds?.size &&
            !requestedSearch.searchesAllFields()
          ) {
            for (const key of requestedSearch.fieldKeys() ?? []) {
              const resolved = RecordSearch.resolveFieldKey(table, key);
              if (resolved.isOk() && searchMaskedFieldIds.has(resolved.value.id().toString())) {
                yield* err(
                  domainError.validation({
                    code: 'record.search.masked_field',
                    message:
                      'Search on a conditionally masked field is not allowed until mask-aware SQL is available',
                  })
                );
              }
            }
          }
          const searchVisibleFieldIds = filterFieldIdsByEnabledFieldIds(
            query.viewId && !query.ignoreViewQuery
              ? yield* table.getOrderedVisibleFieldIds(query.viewId)
              : table.fieldIds(),
            enabledFieldIds
          ).filter((fieldId) => !searchMaskedFieldIds?.has(fieldId.toString()));
          const projectedSearchVisibleFieldIds =
            query.includeSearchFieldMatches && projectionFieldIds
              ? searchVisibleFieldIds.filter((fieldId) =>
                  projectionFieldIds.some((projectedFieldId) => projectedFieldId.equals(fieldId))
                )
              : searchVisibleFieldIds;
          const visibleRowSearch = resolveVisibleRowSearch(
            requestedSearch,
            projectedSearchVisibleFieldIds
          );
          const searchAccessEvent = createListRecordsObservabilityEvent(query, {
            hasFilter: Boolean(effectiveFilter),
            hasSort: Boolean(effectiveSort?.length),
            hasGroup: Boolean(effectiveGroup?.length),
            visibleRowSearch,
          });
          observabilityEvent = searchAccessEvent;

          // 4. Query records with pagination
          const queryRecordsSpan = context.tracer?.startSpan('teable.table.query.records.find', {
            ...createTableQueryTraceAttributes(searchAccessEvent),
            ...createSearchTraceAttributes(searchAccessEvent),
          });
          let queryRecordsResult: Result<
            TableRecordQueryRepositoryPort.ITableRecordQueryResult,
            DomainError
          >;
          try {
            queryRecordsResult = await this.tableRecordQueryRepository.find(
              context,
              table,
              queryPlan?.spec,
              {
                pagination: query.pagination,
                orderBy: queryPlan?.recordIdsOrder?.length ? undefined : orderBy,
                recordIdsOrder: queryPlan?.recordIdsOrder,
                search: visibleRowSearch,
                // !!!IMPORTANT: List table records are always using stored values
                // never change this to 'computed'
                mode: 'stored',
                projectionFieldIds,
                includeTotal: query.includeTotal,
                recordReadQuerySource: query.recordReadQuerySource,
                searchAccessPath: query.recordSearchAccessPath,
                includeSearchFieldMatches: query.includeSearchFieldMatches,
                searchIndexMode: query.searchIndexMode,
                ...(query.includeGroupMetadata && effectiveGroup?.length
                  ? {
                      groupBy: ((yield* resolveGroupByToOrderBy(effectiveGroup!)) ?? []).filter(
                        TableRecordQueryRepositoryPort.isFieldOrderBy
                      ),
                      groupLimit: query.groupLimit,
                    }
                  : {}),
              }
            );
            if (queryRecordsResult.isOk()) {
              const appliedSearchEvent = createListRecordsObservabilityEvent(query, {
                hasFilter: Boolean(effectiveFilter),
                hasSort: Boolean(effectiveSort?.length),
                hasGroup: Boolean(effectiveGroup?.length),
                visibleRowSearch,
                searchAccessPath: queryRecordsResult.value.searchAccessPath,
              });
              queryRecordsSpan?.setAttributes({
                ...createTableQueryTraceAttributes(appliedSearchEvent),
                ...createSearchTraceAttributes(appliedSearchEvent),
              });
            }
          } finally {
            queryRecordsSpan?.end();
          }
          const queryResult = yield* queryRecordsResult;

          // 5. Apply field masks, strip to requested projection, then remap keys
          const requestedProjection =
            query.projection === undefined
              ? undefined
              : new Set(
                  (yield* resolveProjectionFieldIds(
                    table,
                    query.projection,
                    query.fieldKeyType,
                    enabledFieldIds
                  ))?.map((id) => id.toString()) ?? []
                );
          // Field ids available for mask evaluation (readable + deps). Used for
          // fail-closed checks when a dependency was not projected.
          const evaluationFieldIds = projectionFieldIds
            ? new Set(projectionFieldIds.map((id) => id.toString()))
            : enabledFieldIds
              ? new Set(enabledFieldIds)
              : undefined;
          let maskedRecords = applyFieldMasksToRecords(
            table,
            queryResult.records,
            query.queryScope?.fieldMasks,
            evaluationFieldIds
          );
          // Strip mask dependency fields that were only loaded for evaluation.
          if (requestedProjection) {
            maskedRecords = maskedRecords.map((record) => {
              const nextFields: Record<string, unknown> = {};
              for (const [fieldId, value] of Object.entries(record.fields)) {
                if (requestedProjection.has(fieldId)) {
                  nextFields[fieldId] = value;
                }
              }
              return { ...record, fields: nextFields };
            });
          } else if (enabledFieldIds != null) {
            // No explicit client projection: return only allow-listed fields
            // (never leak internal mask dependency columns).
            maskedRecords = maskedRecords.map((record) => {
              const nextFields: Record<string, unknown> = {};
              for (const [fieldId, value] of Object.entries(record.fields)) {
                if (enabledFieldIds.has(fieldId)) {
                  nextFields[fieldId] = value;
                }
              }
              return { ...record, fields: nextFields };
            });
          }
          const transformedRecords =
            query.fieldKeyType !== FieldKeyType.Id
              ? maskedRecords.map((record) => ({
                  ...record,
                  fields: FieldKeyResolverService.transformResponseKeys(
                    table,
                    record.fields,
                    query.fieldKeyType
                  ),
                }))
              : maskedRecords;

          logger.debug('ListTableRecordsHandler.success', {
            count: queryResult.records.length,
            total: queryResult.total,
          });
          observabilityEvent = createListRecordsObservabilityEvent(query, {
            hasFilter: Boolean(effectiveFilter),
            hasSort: Boolean(effectiveSort?.length),
            hasGroup: Boolean(effectiveGroup?.length),
            visibleRowSearch,
            resultCount: queryResult.records.length,
            searchAccessPath: queryResult.searchAccessPath,
          });
          const searchAccessPathSpan = context.tracer?.startSpan(
            'teable.table.search.resolve_access_path',
            {
              ...createTableQueryTraceAttributes(observabilityEvent),
              ...createSearchTraceAttributes(observabilityEvent),
            }
          );
          searchAccessPathSpan?.end();
          if (observabilityEvent.fallbackReason) {
            this.tableQueryObservability.recordSearchFallback(observabilityEvent);
          }

          return ok(
            ListTableRecordsResult.create(
              transformedRecords,
              queryResult.total,
              query.pagination.offset().toNumber(),
              query.pagination.limit().toNumber(),
              queryResult.groups,
              queryResult.searchMatches
            )
          );
        }.bind(this)
      );

      if (result.isErr()) {
        const errorKind = result.error.code ?? 'domain_error';
        observabilityEvent = { ...observabilityEvent, errorKind };
        span?.recordError(result.error.message ?? errorKind);
        this.tableQueryObservability.recordError(observabilityEvent);
      }

      return result;
    } catch (error) {
      const errorKind = error instanceof Error ? error.name : 'unknown_error';
      observabilityEvent = { ...observabilityEvent, errorKind };
      span?.recordError(error instanceof Error ? error.message : String(error));
      this.tableQueryObservability.recordError(observabilityEvent);
      throw error;
    } finally {
      const durationMs = nowMs() - startedAt;
      this.tableQueryObservability.recordRequest({
        ...observabilityEvent,
        durationMs,
      });
      span?.setAttributes({
        ...createTableQueryTraceAttributes(observabilityEvent),
        ...createSearchTraceAttributes(observabilityEvent),
      });
      span?.end();
    }
  }

  private async buildQueryPlan(
    context: IExecutionContext,
    table: Table,
    query: ListTableRecordsQuery,
    resolvedFilter: RecordFilter | undefined,
    linkCandidatePlan?: {
      candidateSpec?: IncomingLinkCandidateSpec;
      linkFilterSpec?: ISpecification<TableRecord, ITableRecordConditionSpecVisitor> | null;
      filterByViewId?: string;
    }
  ): Promise<
    Result<
      {
        spec?: ISpecification<TableRecord, ITableRecordConditionSpecVisitor>;
        recordIdsOrder?: ReadonlyArray<RecordId>;
      },
      DomainError
    >
  > {
    return safeTry(
      async function* (this: ListTableRecordsHandler) {
        const builder = RecordConditionSpecBuilder.create();
        let hasSpec = false;
        let recordIdsOrder: ReadonlyArray<RecordId> | undefined;

        if (resolvedFilter) {
          builder.addConditionSpec(
            yield* buildRecordConditionSpec(table, resolvedFilter, query.queryScope?.fieldMasks)
          );
          hasSpec = true;
        }

        if (query.filterLinkCellSelected) {
          const selectedPlan = yield* await this.buildIncomingLinkSelectedPlan(
            context,
            table,
            query.filterLinkCellSelected
          );
          builder.addConditionSpec(selectedPlan.spec);
          recordIdsOrder = selectedPlan.recordIdsOrder;
          hasSpec = true;
        }

        if (query.filterLinkCellCandidate) {
          // Use pre-resolved plan from handle() to avoid double DB lookup.
          const plan =
            linkCandidatePlan ??
            (yield* await this.buildLinkCandidatePlan(
              context,
              table,
              query.filterLinkCellCandidate
            ));

          if (plan.candidateSpec) {
            builder.addConditionSpec(plan.candidateSpec);
            hasSpec = true;
          }

          // Apply the link field's custom filter (equivalent to v1 getFormLinkRecords).
          if (plan.linkFilterSpec) {
            builder.addConditionSpec(plan.linkFilterSpec);
            hasSpec = true;
          }
        }

        if (query.selectedRecordIds?.length) {
          const selectedRecordIds = query.selectedRecordIds.map((recordId) =>
            RecordId.create(recordId)
          );
          const invalidSelectedRecordId = selectedRecordIds.find((result) => result.isErr());
          if (invalidSelectedRecordId?.isErr()) {
            return err(invalidSelectedRecordId.error);
          }

          const selectedIdsSpec = RecordByIdsSpec.create(
            selectedRecordIds.map((result) => result._unsafeUnwrap())
          );
          if (query.filterLinkCellCandidate) {
            builder.not((notBuilder) => {
              notBuilder.addConditionSpec(selectedIdsSpec);
              return notBuilder;
            });
          } else {
            builder.addConditionSpec(selectedIdsSpec);
          }
          hasSpec = true;
        }

        return ok({
          spec: hasSpec ? yield* builder.build() : undefined,
          recordIdsOrder,
        });
      }.bind(this)
    );
  }

  private async buildIncomingLinkSelectedPlan(
    context: IExecutionContext,
    table: Table,
    filterLinkCellSelected: string | [string, string]
  ): Promise<
    Result<
      {
        spec: ISpecification<TableRecord, ITableRecordConditionSpecVisitor>;
        recordIdsOrder?: ReadonlyArray<RecordId>;
      },
      DomainError
    >
  > {
    return safeTry(
      async function* (this: ListTableRecordsHandler) {
        const fieldId = Array.isArray(filterLinkCellSelected)
          ? filterLinkCellSelected[0]
          : filterLinkCellSelected;
        const hostRecordId = Array.isArray(filterLinkCellSelected)
          ? yield* RecordId.create(filterLinkCellSelected[1])
          : undefined;
        const linkFieldResult = yield* await this.resolveIncomingLinkField(context, table, fieldId);
        const currentTableDbName = yield* table
          .dbTableName()
          .andThen((dbTableName) => dbTableName.value());
        const hostTableDbName = yield* linkFieldResult.hostTable
          .dbTableName()
          .andThen((dbTableName) => dbTableName.value());
        const selfKeyName = yield* linkFieldResult.linkField.selfKeyNameString();
        const fkHostTableName = yield* linkFieldResult.linkField.fkHostTableNameString();
        const foreignKeyName = yield* linkFieldResult.linkField.foreignKeyNameString();

        if (hostRecordId) {
          const hostRecord = yield* await this.tableRecordQueryRepository.findOne(
            context,
            linkFieldResult.hostTable,
            hostRecordId,
            { mode: 'stored' }
          );
          const recordIds = yield* this.extractLinkedRecordIds(
            hostRecord.fields[linkFieldResult.linkField.id().toString()]
          );

          return ok({
            spec: RecordByIdsSpec.create(recordIds),
            recordIdsOrder: recordIds,
          });
        }

        return ok({
          spec:
            fkHostTableName === currentTableDbName || hostTableDbName === currentTableDbName
              ? IncomingLinkSelectedSpec.create({
                  mode: 'currentColumnNotNull',
                  selfKeyName,
                })
              : IncomingLinkSelectedSpec.create({
                  mode: 'hostReferenceExists',
                  selfKeyName,
                  fkHostTableName,
                  foreignKeyName,
                }),
        });
      }.bind(this)
    );
  }

  private async buildLinkCandidatePlan(
    context: IExecutionContext,
    table: Table,
    filterLinkCellCandidate: string | [string, string]
  ): Promise<
    Result<
      {
        candidateSpec?: IncomingLinkCandidateSpec;
        linkFilterSpec?: ISpecification<TableRecord, ITableRecordConditionSpecVisitor> | null;
        filterByViewId?: string;
      },
      DomainError
    >
  > {
    return safeTry(
      async function* (this: ListTableRecordsHandler) {
        const fieldId = Array.isArray(filterLinkCellCandidate)
          ? filterLinkCellCandidate[0]
          : filterLinkCellCandidate;
        const hostRecordId = Array.isArray(filterLinkCellCandidate)
          ? yield* RecordId.create(filterLinkCellCandidate[1])
          : undefined;
        const linkFieldResult = yield* await this.resolveIncomingLinkField(context, table, fieldId);
        const linkField = linkFieldResult.linkField;
        const selfKeyName = yield* linkField.selfKeyNameString();
        const fkHostTableName = yield* linkField.fkHostTableNameString();
        const foreignKeyName = yield* linkField.foreignKeyNameString();

        // Build candidate exclusion spec (OneMany / OneOne relationships only).
        let candidateSpec: IncomingLinkCandidateSpec | undefined;
        if (linkField.relationship().toString() === 'oneMany') {
          candidateSpec = this.isJunctionTable(fkHostTableName)
            ? IncomingLinkCandidateSpec.create({
                mode: 'junctionReferenceAvailable',
                selfKeyName,
                hostRecordId,
                fkHostTableName,
                foreignKeyName,
              })
            : IncomingLinkCandidateSpec.create({
                mode: 'currentColumnAvailable',
                selfKeyName,
                hostRecordId,
              });
        } else if (linkField.relationship().toString() === 'oneOne') {
          candidateSpec =
            selfKeyName === '__id'
              ? IncomingLinkCandidateSpec.create({
                  mode: 'hostReferenceAvailable',
                  selfKeyName,
                  hostRecordId,
                  fkHostTableName,
                  foreignKeyName,
                })
              : IncomingLinkCandidateSpec.create({
                  mode: 'currentColumnAvailable',
                  selfKeyName,
                  hostRecordId,
                });
        }

        // Extract the link field's custom filter (v1 IFilter format stored in options).
        // This mirrors what v1's getFormLinkRecords does: apply the link field's configured filter.
        let linkFilterSpec: ISpecification<TableRecord, ITableRecordConditionSpecVisitor> | null =
          null;
        const rawFilter = linkField.config().filter();
        if (rawFilter !== null && rawFilter !== undefined) {
          const conditionResult = FieldCondition.create({ filter: rawFilter });
          if (conditionResult.isOk()) {
            const specResult = conditionResult.value.toRecordConditionSpec(table);
            if (specResult.isOk()) {
              linkFilterSpec = specResult.value;
            } else {
              this.logger.warn('Failed to build link field filter spec', {
                fieldId,
                error: specResult.error,
              });
            }
          } else {
            this.logger.warn('Failed to parse link field filter', {
              fieldId,
              error: conditionResult.error,
            });
          }
        }

        // Extract filterByViewId so handle() can use it as the effective view.
        const filterByViewId = linkField.filterByViewId()?.toString() ?? undefined;

        return ok({ candidateSpec, linkFilterSpec, filterByViewId });
      }.bind(this)
    );
  }

  private async resolveIncomingLinkField(
    context: IExecutionContext,
    table: Table,
    rawFieldId: string
  ): Promise<Result<{ hostTable: Table; linkField: LinkField }, DomainError>> {
    return safeTry(
      async function* (this: ListTableRecordsHandler) {
        const fieldId = yield* FieldId.create(rawFieldId);
        const hostTables = yield* await this.tableRepository.find(
          context,
          TableByIncomingReferenceToTableSpec.create(table.id())
        );

        for (const hostTable of hostTables) {
          const linkField = hostTable.getFields().find((field): field is LinkField => {
            return field.type().toString() === 'link' && field.id().equals(fieldId);
          });

          if (linkField && linkField.foreignTableId().equals(table.id())) {
            return ok({ hostTable, linkField });
          }
        }

        return err(
          domainError.notFound({
            code: 'field.not_found',
            message: `Field not found: ${rawFieldId}`,
            details: { fieldId: rawFieldId },
          })
        );
      }.bind(this)
    );
  }

  private extractLinkedRecordIds(value: unknown): Result<ReadonlyArray<RecordId>, DomainError> {
    const rawIds = Array.isArray(value)
      ? value
          .map((item) =>
            item && typeof item === 'object' && 'id' in item ? (item.id as unknown) : undefined
          )
          .filter((item): item is string => typeof item === 'string')
      : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
        ? [value.id]
        : [];

    const recordIds = rawIds.map((recordId) => RecordId.create(recordId));
    const invalidRecordId = recordIds.find((result) => result.isErr());
    if (invalidRecordId?.isErr()) {
      return err(invalidRecordId.error);
    }

    return ok(recordIds.map((result) => result._unsafeUnwrap()));
  }

  private isJunctionTable(dbTableName: string): boolean {
    if (dbTableName.includes('.')) {
      return dbTableName.split('.')[1]?.startsWith('junction') ?? false;
    }
    return dbTableName.split('_')[1]?.startsWith('junction') ?? false;
  }
}
