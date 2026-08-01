import { Injectable } from '@nestjs/common';
import { ANONYMOUS_USER_ID } from '@teable/core';
import { v2MetaDbTokens } from '@teable/v2-adapter-db-postgres-pg';
import { ActorId } from '@teable/v2-core';
import type { V1TeableDatabase } from '@teable/v2-postgres-schema';
import type { Kysely } from 'kysely';
import { V2ContainerService } from '../v2/v2-container.service';
import { ViewOpenApiV2Service } from '../view/open-api/view-open-api-v2.service';
import type { IShareViewInfo } from './share-auth.service';

const publicShareActorId = ActorId.create(ANONYMOUS_USER_ID)._unsafeUnwrap();

/**
 * Resolves the public share credential through a read-model index, then loads
 * the View child through the Table aggregate query path.
 *
 * This is intentionally not a View repository: the Kysely lookup returns only
 * aggregate identity, while View state comes from `ITableRepository`.
 */
@Injectable()
export class SharedViewAccessV2Service {
  constructor(
    private readonly v2ContainerService: V2ContainerService,
    private readonly viewOpenApiV2Service: ViewOpenApiV2Service
  ) {}

  async findByShareId(shareId: string): Promise<IShareViewInfo | undefined> {
    const container = await this.v2ContainerService.getContainer();
    const db = container.resolve<Kysely<V1TeableDatabase>>(v2MetaDbTokens.db);
    const identity = await db
      .selectFrom('view')
      .select(['id', 'table_id'])
      .where('share_id', '=', shareId)
      .where('enable_share', '=', true)
      .where('deleted_time', 'is', null)
      .executeTakeFirst();
    if (!identity) return undefined;

    const view = await this.viewOpenApiV2Service.getView(identity.table_id, identity.id, {
      actorId: publicShareActorId,
    });
    if (view.enableShare !== true || view.shareId !== shareId) return undefined;

    return {
      shareId,
      tableId: identity.table_id,
      view,
      shareMeta: view.shareMeta,
    };
  }
}
