import { inject, injectable } from '@teable/v2-di';
import { ok, safeTry, type Result } from 'neverthrow';

import type { DomainError } from '../../domain/shared/DomainError';
import { ViewSortUpdated } from '../../domain/table/events/ViewSortUpdated';
import type { ViewSortDTO } from '../../domain/table/views/ViewSort';
import type { IEventDispatchScope, IEventHandler } from '../../ports/EventHandler';
import type * as ExecutionContextPort from '../../ports/ExecutionContext';
import * as TableMapperPort from '../../ports/mappers/TableMapper';
import { RealtimeDocId } from '../../ports/RealtimeDocId';
import * as RealtimeEnginePort from '../../ports/RealtimeEngine';
import * as TableRepositoryPort from '../../ports/TableRepository';
import { v2CoreTokens } from '../../ports/tokens';
import { ProjectionHandler } from './Projection';
import { loadRealtimeTableSnapshot } from './RealtimeTableSnapshotCache';
import {
  getRealtimeProjectionScope,
  scheduleRealtimeProjection,
} from './scheduleRealtimeProjection';

const tableCollectionPrefix = 'tbl';
const viewCollectionPrefix = 'viw';

const querySortMatches = (
  query: { sort?: unknown; manualSort?: unknown } | undefined,
  sort: ViewSortDTO
): boolean => {
  const projected =
    query?.sort === undefined && query?.manualSort === undefined
      ? null
      : {
          sortObjs: query?.sort ?? [],
          ...(query?.manualSort !== undefined ? { manualSort: query.manualSort } : {}),
        };
  return JSON.stringify(projected) === JSON.stringify(sort);
};

@ProjectionHandler(ViewSortUpdated)
@injectable()
export class ViewSortUpdatedRealtimeProjection implements IEventHandler<ViewSortUpdated> {
  constructor(
    @inject(v2CoreTokens.realtimeEngine)
    private readonly realtimeEngine: RealtimeEnginePort.IRealtimeEngine,
    @inject(v2CoreTokens.tableRepository)
    private readonly tableRepository: TableRepositoryPort.ITableRepository,
    @inject(v2CoreTokens.tableMapper)
    private readonly tableMapper: TableMapperPort.ITableMapper
  ) {}

  async handle(
    context: ExecutionContextPort.IExecutionContext,
    event: ViewSortUpdated,
    dispatchScope?: IEventDispatchScope
  ): Promise<Result<void, DomainError>> {
    const { realtimeEngine, tableRepository, tableMapper } = this;
    return scheduleRealtimeProjection(
      context,
      ViewSortUpdatedRealtimeProjection.name,
      (context, scope) =>
        safeTry(async function* () {
          const snapshot = yield* (
            await loadRealtimeTableSnapshot(context, {
              baseId: event.baseId,
              tableId: event.tableId,
              tableRepository,
              tableMapper,
              tableSnapshotCache: scope.tableSnapshotCache,
              isSnapshotUsable: (candidate) => {
                const view = candidate.views.find(
                  (candidateView) => candidateView.id === event.viewId.toString()
                );
                return querySortMatches(view?.query, event.nextSort);
              },
            })
          ).safeUnwrap();
          const viewIndex = snapshot.views.findIndex((view) => view.id === event.viewId.toString());
          if (viewIndex === -1) return ok(undefined);
          const viewDto = snapshot.views[viewIndex];

          const tableDocId = yield* RealtimeDocId.fromParts(
            `${tableCollectionPrefix}_${event.baseId.toString()}`,
            event.tableId.toString()
          ).safeUnwrap();
          yield* (await realtimeEngine.ensure(context, tableDocId, snapshot)).safeUnwrap();
          yield* (
            await realtimeEngine.applyChange(context, tableDocId, [
              { type: 'set', path: ['views', viewIndex, 'query'], value: viewDto.query },
            ])
          ).safeUnwrap();

          const viewDocId = yield* RealtimeDocId.fromParts(
            `${viewCollectionPrefix}_${event.tableId.toString()}`,
            event.viewId.toString()
          ).safeUnwrap();
          yield* (await realtimeEngine.ensure(context, viewDocId, viewDto)).safeUnwrap();
          return realtimeEngine.applyChange(
            context,
            viewDocId,
            [{ type: 'set', path: ['query'], value: viewDto.query }],
            { version: event.oldVersion }
          );
        }),
      getRealtimeProjectionScope(dispatchScope)
    );
  }
}
