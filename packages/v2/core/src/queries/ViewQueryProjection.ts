import { ok, safeTry } from 'neverthrow';
import type { Result } from 'neverthrow';

import type { DomainError } from '../domain/shared/DomainError';
import type { Table } from '../domain/table/Table';
import type { View } from '../domain/table/views/View';
import type { ViewColumnMetaValue } from '../domain/table/views/ViewColumnMeta';
import type { ViewShareMetaValue } from '../domain/table/views/ViewProperties';
import type {
  ViewQueryGroupItem,
  ViewQuerySortItem,
} from '../domain/table/views/ViewQueryDefaults';

export type ViewQueryResultView = {
  id: string;
  version?: number;
  name: string;
  type: 'grid' | 'kanban' | 'gallery' | 'calendar' | 'form' | 'plugin';
  description?: string;
  order?: number;
  options?: unknown;
  filter?: unknown;
  sort?: {
    sortObjs: ReadonlyArray<ViewQuerySortItem>;
    manualSort?: boolean;
  };
  group?: ReadonlyArray<ViewQueryGroupItem>;
  isLocked?: boolean;
  shareId?: string;
  enableShare?: boolean;
  shareMeta?: ViewShareMetaValue;
  createdBy: string;
  lastModifiedBy?: string;
  createdTime: string;
  lastModifiedTime?: string;
  columnMeta: ViewColumnMetaValue;
};

export const projectViewForQuery = (
  table: Table,
  view: View
): Result<ViewQueryResultView, DomainError> =>
  safeTry<ViewQueryResultView, DomainError>(function* () {
    const columnMeta = yield* view.columnMeta();
    const queryDefaults = yield* view.queryDefaults();
    const auditMetadata = yield* view.auditMetadata();
    const activeFieldIds = new Set(table.getFields().map((field) => field.id().toString()));
    const sanitizedColumnMeta = Object.fromEntries(
      Object.entries(columnMeta.toDto()).filter(([fieldId]) => activeFieldIds.has(fieldId))
    );
    const sourceFilter = queryDefaults.sourceFilter();
    const sortObjs = queryDefaults.sort();
    const manualSort = queryDefaults.manualSort();
    const group = queryDefaults.group();
    const metadata = auditMetadata.toDto();
    const order = view.order();
    const version = view.version();

    return ok({
      id: view.id().toString(),
      ...(version.isOk() ? { version: version.value.toNumber() } : {}),
      name: view.name().toString(),
      type: view.type().toString(),
      ...(order.isOk() ? { order: order.value.toNumber() } : {}),
      ...(view.description() ? { description: view.description() } : {}),
      ...(view.options() !== undefined ? { options: view.options() } : {}),
      ...(sourceFilter != null ? { filter: sourceFilter } : {}),
      ...(sortObjs !== undefined || manualSort !== undefined
        ? {
            sort: {
              sortObjs: sortObjs ?? [],
              ...(manualSort !== undefined ? { manualSort } : {}),
            },
          }
        : {}),
      ...(group?.length ? { group } : {}),
      ...(view.isLocked() ? { isLocked: true } : {}),
      ...(view.shareId() ? { shareId: view.shareId() } : {}),
      ...(view.enableShare() ? { enableShare: true } : {}),
      ...(view.shareMeta() ? { shareMeta: view.shareMeta() } : {}),
      ...metadata,
      columnMeta: sanitizedColumnMeta,
    });
  });
