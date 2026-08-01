import type { Result } from 'neverthrow';

import type { DomainError } from '../domain/shared/DomainError';
import type { ISpecification } from '../domain/shared/specification/ISpecification';
import type { ITableRecordConditionSpecVisitor } from '../domain/table/records/specs/ITableRecordConditionSpecVisitor';
import type { TableRecord } from '../domain/table/records/TableRecord';
import type { Table } from '../domain/table/Table';
import type { IExecutionContext } from './ExecutionContext';
import type { PluginTraceContext } from './Tracer';

/**
 * Read-side operation kinds for record query plugins.
 * Start with list / getOne / getByIds; extend later for search/aggregate.
 */
export const RecordQueryOperationKind = {
  list: 'list',
  getOne: 'getOne',
  getByIds: 'getByIds',
} as const;

export type RecordQueryOperationKind =
  (typeof RecordQueryOperationKind)[keyof typeof RecordQueryOperationKind];

export type RecordQueryPluginEnforce = 'pre' | 'post';

export interface RecordQueryPluginRunnerOptions {
  readonly skipPluginNames?: ReadonlySet<string>;
}

/**
 * Soft constraints applied mechanically by query handlers.
 * Handlers must not interpret authority-matrix policy — only this shape.
 */
export interface RecordQueryPluginScope {
  /**
   * Row visibility. AND-ed into the query condition tree with user/view filters
   * unless {@link skipRecordSpec} is true.
   */
  readonly recordSpec?: ISpecification<TableRecord, ITableRecordConditionSpecVisitor>;

  /**
   * When true, handlers must not AND {@link recordSpec} into the list query.
   * Used for link-selected UX (legacy keepPrimaryKey / skip row filter).
   * Field allow-list and masks still apply.
   *
   * Merge semantics: skip only drops **this plugin's** row filter contribution.
   * It must not erase other plugins' recordSpecs.
   */
  readonly skipRecordSpec?: boolean;

  /**
   * Static field allow-list.
   * - `undefined`: all user fields allowed
   * - empty set: no user fields (system columns only)
   * - non-empty: only listed fields may be projected / used in filter-sort-search
   *
   * Cross-plugin merge is intersection (monotonic tighten).
   */
  readonly readableFieldIds?: ReadonlySet<string>;

  /**
   * Field ids that must remain readable even when a static allow-list is present
   * (e.g. primary field for link titles when skipRecordSpec is set).
   *
   * Merge semantics: applied **inside** this plugin's allow-list before
   * cross-plugin intersection — cannot re-open fields another plugin denied.
   */
  readonly forceReadableFieldIds?: ReadonlySet<string>;

  /**
   * Conditional field visibility (replaces outer permission-view CASE WHEN).
   * Applied after read (null-out) using domain evaluation; never as a host-built CTE.
   * Handlers must expand projection with mask dependency fields (not only static
   * readable fields) and fail-closed when dependencies are missing.
   */
  readonly fieldMasks?: ReadonlyArray<RecordQueryFieldMask>;

  /**
   * The legacy permission-aware record query is guaranteed to enforce the same
   * access constraints as this scope.
   *
   * This is a narrow ShareDB compatibility capability for query features that
   * V2 cannot yet express with conditional masks (group/search/order). The
   * runner exports it only when every access-restricting plugin opts in.
   */
  readonly legacyPermissionQueryCompatible?: true;
}

export interface RecordQueryFieldMask {
  readonly fieldId: string;
  readonly visibleWhen: ISpecification<TableRecord, ITableRecordConditionSpecVisitor>;
}

type RecordQueryPluginHookResult<T> = Result<T, DomainError> | Promise<Result<T, DomainError>>;

interface IRecordQueryPluginContextBase<TKind extends RecordQueryOperationKind, TPayload> {
  readonly kind: TKind;
  readonly executionContext: IExecutionContext;
  readonly table: Table;
  readonly payload: TPayload;
  readonly trace?: PluginTraceContext;
}

export type RecordQueryListPayload = {
  readonly viewId?: string;
  readonly ignoreViewQuery?: boolean;
  /** Client-requested projection field keys/ids before scope intersection (optional). */
  readonly projectionFieldIds?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly offset?: number;
  /**
   * When true (e.g. filterLinkCellSelected), row recordSpec should be skipped and
   * primary field force-included for link title UX.
   */
  readonly keepPrimaryKey?: boolean;
};

export type RecordQueryGetOnePayload = {
  readonly recordId: string;
  readonly projectionFieldIds?: ReadonlyArray<string>;
  readonly viewId?: string;
  readonly ignoreViewQuery?: boolean;
  /**
   * Host-controlled existence probe after a scoped getOne miss.
   *
   * Plugins with discretionary row filters (e.g. authority matrix) set
   * {@link RecordQueryPluginScope.skipRecordSpec} so the host can distinguish
   * 403 vs 404. Other plugins keep their row filters. Field allow-lists and
   * masks still apply. Must not force-include fields (unlike list keepPrimary).
   *
   * Only the OpenAPI getOne 403/404 path may set this — not a general-purpose
   * client flag.
   */
  readonly existenceProbe?: boolean;
};

export type RecordQueryGetByIdsPayload = {
  readonly recordIds: ReadonlyArray<string>;
  readonly projectionFieldIds?: ReadonlyArray<string>;
  readonly viewId?: string;
  readonly ignoreViewQuery?: boolean;
  /**
   * Host-controlled ShareDB snapshot compatibility mode. Skips discretionary
   * row filters and preserves the primary field while retaining static field
   * allow-lists and non-primary conditional masks.
   */
  readonly keepPrimaryKey?: boolean;
};

export type RecordQueryPluginContextMap = {
  list: IRecordQueryPluginContextBase<'list', RecordQueryListPayload>;
  getOne: IRecordQueryPluginContextBase<'getOne', RecordQueryGetOnePayload>;
  getByIds: IRecordQueryPluginContextBase<'getByIds', RecordQueryGetByIdsPayload>;
};

export type RecordQueryPluginContext = RecordQueryPluginContextMap[RecordQueryOperationKind];

/**
 * Outer-layer read authorization plugin.
 *
 * Domain query handlers never import authority-matrix types. They only consume
 * merged {@link RecordQueryPluginScope} (recordSpec + readableFieldIds + fieldMasks).
 */
export interface IRecordQueryPlugin<TPreparedState = unknown> {
  readonly name: string;
  /**
   * Ordering hint: `pre` → default → `post`.
   */
  readonly enforce?: RecordQueryPluginEnforce;

  supports(operation: RecordQueryOperationKind): boolean;

  prepare?(
    context: RecordQueryPluginContext,
    previousPreparedState?: TPreparedState
  ): RecordQueryPluginHookResult<TPreparedState>;

  /**
   * Emit soft constraints. Handlers AND recordSpec and intersect field sets.
   * `preparedState` is undefined when `prepare` was omitted.
   */
  scope?(
    context: RecordQueryPluginContext,
    preparedState: TPreparedState | undefined
  ): RecordQueryPluginHookResult<RecordQueryPluginScope | undefined>;

  /**
   * Hard deny (e.g. no table read). Fail closed.
   * `preparedState` is undefined when `prepare` was omitted.
   */
  guard?(
    context: RecordQueryPluginContext,
    preparedState: TPreparedState | undefined
  ): RecordQueryPluginHookResult<void>;
}
