import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';

import type { RecordFilter, RecordFilterNode } from '../../../queries/RecordFilterDto';
import { domainError, type DomainError } from '../../shared/DomainError';
import { Entity } from '../../shared/Entity';
import type { Field } from '../fields/Field';
import type { FieldDeletionContext } from '../OnTeableFieldDeleted';
import type { OnTeableViewFieldDeleted, ViewFieldDeletionUpdate } from './OnTeableViewFieldDeleted';
import type { ViewAuditMetadata } from './ViewAuditMetadata';
import { ViewColumnMeta } from './ViewColumnMeta';
import type { ViewId } from './ViewId';
import type { ViewName } from './ViewName';
import type { ViewOrder } from './ViewOrder';
import { ViewProperties } from './ViewProperties';
import type { ViewQueryDefaults } from './ViewQueryDefaults';
import { ViewQueryDefaults as ViewQueryDefaultsValue } from './ViewQueryDefaults';
import type { ViewType } from './ViewType';
import type { ViewVersion } from './ViewVersion';
import type { IViewVisitor } from './visitors/IViewVisitor';

export abstract class View extends Entity<ViewId> implements OnTeableViewFieldDeleted {
  private columnMetaValue: ViewColumnMeta | undefined;
  private queryDefaultsValue: ViewQueryDefaults | undefined;
  private optionsValue: unknown;
  private auditMetadataValue: ViewAuditMetadata | undefined;
  private orderValue: ViewOrder | undefined;
  private versionValue: ViewVersion | undefined;

  protected constructor(
    id: ViewId,
    private readonly nameValue: ViewName,
    private readonly typeValue: ViewType,
    private readonly propertiesValue: ViewProperties = ViewProperties.empty()
  ) {
    super(id);
  }

  name(): ViewName {
    return this.nameValue;
  }

  type(): ViewType {
    return this.typeValue;
  }

  properties(): ViewProperties {
    return this.propertiesValue;
  }

  description(): string | undefined {
    return this.propertiesValue.description();
  }

  isLocked(): boolean | undefined {
    return this.propertiesValue.isLocked();
  }

  enableShare(): boolean | undefined {
    return this.propertiesValue.enableShare();
  }

  shareId(): string | undefined {
    return this.propertiesValue.shareId();
  }

  shareMeta(): ReturnType<ViewProperties['shareMeta']> {
    return this.propertiesValue.shareMeta();
  }

  columnMeta(): Result<ViewColumnMeta, DomainError> {
    if (!this.columnMetaValue)
      return err(domainError.invariant({ message: 'ViewColumnMeta not set' }));
    return ok(this.columnMetaValue);
  }

  queryDefaults(): Result<ViewQueryDefaults, DomainError> {
    if (!this.queryDefaultsValue)
      return err(domainError.invariant({ message: 'ViewQueryDefaults not set' }));
    return ok(this.queryDefaultsValue);
  }

  options(): unknown | undefined {
    return this.optionsValue;
  }

  auditMetadata(): Result<ViewAuditMetadata, DomainError> {
    if (!this.auditMetadataValue) {
      return err(domainError.invariant({ message: 'ViewAuditMetadata not set' }));
    }
    return ok(this.auditMetadataValue);
  }

  order(): Result<ViewOrder, DomainError> {
    if (!this.orderValue) {
      return err(domainError.invariant({ message: 'ViewOrder not set' }));
    }
    return ok(this.orderValue);
  }

  version(): Result<ViewVersion, DomainError> {
    if (!this.versionValue) {
      return err(domainError.invariant({ message: 'ViewVersion not set' }));
    }
    return ok(this.versionValue);
  }

  setColumnMeta(columnMeta: ViewColumnMeta): Result<void, DomainError> {
    if (this.columnMetaValue) {
      if (this.columnMetaValue.equals(columnMeta)) return ok(undefined);
      return err(domainError.invariant({ message: 'ViewColumnMeta already set' }));
    }
    this.columnMetaValue = columnMeta;
    return ok(undefined);
  }

  setQueryDefaults(queryDefaults: ViewQueryDefaults): Result<void, DomainError> {
    if (this.queryDefaultsValue) {
      if (this.queryDefaultsValue.equals(queryDefaults)) return ok(undefined);
      return err(domainError.invariant({ message: 'ViewQueryDefaults already set' }));
    }
    this.queryDefaultsValue = queryDefaults;
    return ok(undefined);
  }

  setOptions(options: unknown): Result<void, DomainError> {
    if (options === undefined) return ok(undefined);

    const nextSerialized = JSON.stringify(options);
    if (this.optionsValue !== undefined) {
      if (JSON.stringify(this.optionsValue) === nextSerialized) return ok(undefined);
      return err(domainError.invariant({ message: 'ViewOptions already set' }));
    }

    this.optionsValue = options;
    return ok(undefined);
  }

  setAuditMetadata(metadata: ViewAuditMetadata): Result<void, DomainError> {
    if (this.auditMetadataValue) {
      if (this.auditMetadataValue.equals(metadata)) return ok(undefined);
      return err(domainError.invariant({ message: 'ViewAuditMetadata already set' }));
    }
    this.auditMetadataValue = metadata;
    return ok(undefined);
  }

  setOrder(order: ViewOrder): Result<void, DomainError> {
    if (this.orderValue) {
      if (this.orderValue.equals(order)) return ok(undefined);
      return err(domainError.invariant({ message: 'ViewOrder already set' }));
    }
    this.orderValue = order;
    return ok(undefined);
  }

  setVersion(version: ViewVersion): Result<void, DomainError> {
    if (this.versionValue) {
      if (this.versionValue.equals(version)) return ok(undefined);
      return err(domainError.invariant({ message: 'ViewVersion already set' }));
    }
    this.versionValue = version;
    return ok(undefined);
  }

  /**
   * Move the persisted-version baseline forward after a successful repository
   * update so a later update reusing the same aggregate instance does not
   * carry a stale optimistic-lock expectation. Never moves backwards.
   */
  advanceVersion(version: ViewVersion): void {
    if (this.versionValue && version.toNumber() <= this.versionValue.toNumber()) return;
    this.versionValue = version;
  }

  onFieldDeleted(
    deletedField: Field,
    context: FieldDeletionContext
  ): Result<ViewFieldDeletionUpdate | undefined, DomainError> {
    let nextColumnMetaValue: ViewColumnMeta | undefined;
    let nextQueryDefaultsValue: ViewQueryDefaults | undefined;
    const deletedFieldId = deletedField.id().toString();

    const columnMetaResult = this.columnMeta();
    if (columnMetaResult.isErr()) return err(columnMetaResult.error);
    const currentColumnMeta = columnMetaResult.value;
    const nextColumnMetaResult = this.buildNextColumnMeta(
      currentColumnMeta,
      deletedFieldId,
      context
    );
    if (nextColumnMetaResult.isErr()) return err(nextColumnMetaResult.error);
    const nextColumnMeta = nextColumnMetaResult.value;

    if (!currentColumnMeta.equals(nextColumnMeta)) {
      nextColumnMetaValue = nextColumnMeta;
    }

    const queryDefaultsResult = this.queryDefaults();
    if (queryDefaultsResult.isErr()) return err(queryDefaultsResult.error);
    const currentQueryDefaults = queryDefaultsResult.value;
    const currentQueryDefaultsDto = currentQueryDefaults.toDto();

    const nextFilter = this.removeFieldReferenceFromFilter(
      currentQueryDefaultsDto.filter,
      deletedFieldId
    );
    const nextSort = currentQueryDefaultsDto.sort?.filter(
      (item) => item.fieldId !== deletedFieldId
    );
    const nextGroup = currentQueryDefaultsDto.group?.filter(
      (item) => item.fieldId !== deletedFieldId
    );

    const nextManualSort =
      nextSort && nextSort.length > 0 ? currentQueryDefaultsDto.manualSort ?? false : undefined;

    const nextQueryDefaultsDto = {
      ...(nextFilter !== undefined ? { filter: nextFilter } : {}),
      ...(nextSort && nextSort.length > 0 ? { sort: nextSort } : {}),
      ...(nextGroup && nextGroup.length > 0 ? { group: nextGroup } : {}),
      ...(nextManualSort !== undefined ? { manualSort: nextManualSort } : {}),
    };

    const filterChanged =
      JSON.stringify(currentQueryDefaultsDto.filter) !== JSON.stringify(nextFilter);
    const nextQueryDefaultsResult = ViewQueryDefaultsValue.rehydrate(nextQueryDefaultsDto, {
      sourceFilter: filterChanged ? undefined : currentQueryDefaults.sourceFilter(),
    });
    if (nextQueryDefaultsResult.isErr()) return err(nextQueryDefaultsResult.error);
    const nextQueryDefaults = nextQueryDefaultsResult.value;

    if (!currentQueryDefaults.equals(nextQueryDefaults)) {
      nextQueryDefaultsValue = nextQueryDefaults;
    }

    if (!nextColumnMetaValue && !nextQueryDefaultsValue) {
      return ok(undefined);
    }

    return ok({
      viewId: this.id(),
      fieldId: deletedField.id(),
      columnMeta: nextColumnMetaValue,
      queryDefaults: nextQueryDefaultsValue,
    });
  }

  private buildNextColumnMeta(
    currentColumnMeta: ViewColumnMeta,
    deletedFieldId: string,
    context: FieldDeletionContext
  ): Result<ViewColumnMeta, DomainError> {
    const nextColumnMetaRaw = currentColumnMeta.toDto();

    const removedEntry = nextColumnMetaRaw[deletedFieldId];
    if (removedEntry) {
      delete nextColumnMetaRaw[deletedFieldId];
    }

    const deletedOrder = this.getDeletedFieldOrder(deletedFieldId, removedEntry?.order, context);
    if (deletedOrder !== undefined) {
      for (const entry of Object.values(nextColumnMetaRaw)) {
        if (typeof entry.order !== 'number') continue;
        if (entry.order > deletedOrder) {
          entry.order = entry.order - 1;
        }
      }
    }

    return ViewColumnMeta.create(nextColumnMetaRaw);
  }

  private getDeletedFieldOrder(
    deletedFieldId: string,
    currentOrder: number | null | undefined,
    context: FieldDeletionContext
  ): number | undefined {
    if (typeof currentOrder === 'number') {
      return currentOrder;
    }

    if (!context.previousSourceTable || !context.table.id().equals(context.sourceTable.id())) {
      return undefined;
    }

    const previousViewResult = context.previousSourceTable.getView(this.id());
    if (previousViewResult.isErr()) {
      return undefined;
    }
    const previousColumnMetaResult = previousViewResult.value.columnMeta();
    if (previousColumnMetaResult.isErr()) {
      return undefined;
    }

    const previousOrder = previousColumnMetaResult.value.toDto()[deletedFieldId]?.order;
    return typeof previousOrder === 'number' ? previousOrder : undefined;
  }

  private removeFieldReferenceFromFilter(
    filter: RecordFilter | null | undefined,
    deletedFieldId: string
  ): RecordFilter | null | undefined {
    if (filter == null) {
      return filter;
    }

    const nextFilter = this.removeFieldReferenceFromFilterNode(filter, deletedFieldId);
    return nextFilter ?? null;
  }

  private removeFieldReferenceFromFilterNode(
    node: RecordFilterNode,
    deletedFieldId: string
  ): RecordFilterNode | null {
    if ('fieldId' in node) {
      if (node.fieldId === deletedFieldId) {
        return null;
      }
      return { ...node };
    }

    if ('items' in node) {
      const nextItems = node.items
        .map((item) => this.removeFieldReferenceFromFilterNode(item, deletedFieldId))
        .filter((item): item is RecordFilterNode => item != null);
      if (nextItems.length === 0) {
        return null;
      }
      return {
        conjunction: node.conjunction,
        items: nextItems,
      };
    }

    if ('not' in node) {
      const nextNode = this.removeFieldReferenceFromFilterNode(node.not, deletedFieldId);
      if (nextNode == null) {
        return null;
      }
      return { not: nextNode };
    }

    return node;
  }

  abstract accept<T = void>(visitor: IViewVisitor<T>): Result<T, DomainError>;
}
