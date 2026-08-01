Declaration: If the folder I belong to changes, please update me, especially core domain concepts. Add examples or example file paths for abstract concepts when needed.

# application/projections Architecture Notes

## Responsibilities

- Define projection types that bind Domain Events to derived effects.
- Provide an alias decorator for projection event bindings.
- Keep projections as EventHandlers (no event type branching inside handlers).

## Files

- `ARCHITECTURE.md` - Role: folder architecture note; Purpose: describe projection scope.
- `Projection.ts` - Role: projection alias; Purpose: define IProjection and the ProjectionHandler decorator.
- `RealtimeProjection.ts` - Role: marker type; Purpose: label projections that target realtime engines.
- `TableCreatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish table snapshots on create.
- `FieldCreatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish field snapshots on create.
- `FieldDeletedRealtimeProjection.ts` - Role: realtime projection; Purpose: delete field snapshots on remove.
- `ViewColumnMetaUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: update view column meta snapshots when field is added/removed.
- `ViewCreatedRealtimeProjection.ts` - Role: realtime projection; Purpose: append the created View to
  the Table document and publish its standalone document.
- `ViewDeletedRealtimeProjection.ts` - Role: realtime projection; Purpose: refresh the Table View list
  and remove the deleted View document.
- `ViewDescriptionUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish View
  description changes.
- `ViewFilterUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish View filter
  changes and refresh query defaults.
- `ViewGroupUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish View group
  changes and refresh query defaults.
- `ViewLockedUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish View lock
  state changes.
- `ViewSortUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: refresh query defaults
  in both the Table document and standalone View document.
- `ViewManualSortAppliedRealtimeProjection.ts` - Role: realtime projection; Purpose: invalidate
  record collection queries after bulk row-order materialization commits.
- `ViewOptionsUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish
  type-specific View option changes.
- `ViewOrderUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish the complete
  Table View ordering after a reorder.
- `ViewRenamedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish View name changes.
- `ViewShareIdRefreshedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish the
  current credential after share ID rotation.
- `ViewShareMetaUpdatedRealtimeProjection.ts` - Role: realtime projection; Purpose: publish current
  View share metadata.
- `ViewShareStateRealtimeProjection.ts` - Role: realtime projection; Purpose: publish enable and
  disable share state through event-specific handlers.
