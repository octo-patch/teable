import type { BaseId } from '../../base/BaseId';
import { DomainEventName } from '../../shared/DomainEventName';
import { OccurredAt } from '../../shared/OccurredAt';
import type { TableId } from '../TableId';
import type { ViewId } from '../views/ViewId';
import { AbstractTableUpdatedEvent } from './AbstractTableUpdatedEvent';

export class ViewDeleted extends AbstractTableUpdatedEvent {
  readonly name = DomainEventName.viewDeleted();
  readonly occurredAt = OccurredAt.now();

  private constructor(
    tableId: TableId,
    baseId: BaseId,
    readonly viewId: ViewId
  ) {
    super(tableId, baseId);
  }

  static create(params: { tableId: TableId; baseId: BaseId; viewId: ViewId }): ViewDeleted {
    return new ViewDeleted(params.tableId, params.baseId, params.viewId);
  }
}
