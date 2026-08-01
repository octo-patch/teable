import { v2MetaDbTokens } from '@teable/v2-adapter-db-postgres-pg';
import { describe, expect, it, vi } from 'vitest';
import { SharedViewAccessV2Service } from './shared-view-access-v2.service';

/* eslint-disable @typescript-eslint/naming-convention */
const createFixture = (identity?: { id: string; table_id: string }) => {
  const query = {
    select: vi.fn(),
    where: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValue(identity),
  };
  query.select.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const db = {
    selectFrom: vi.fn().mockReturnValue(query),
  };
  const resolve = vi.fn().mockReturnValue(db);
  const v2ContainerService = {
    getContainer: vi.fn().mockResolvedValue({ resolve }),
  };
  const viewOpenApiV2Service = {
    getView: vi.fn(),
  };
  const service = new SharedViewAccessV2Service(
    v2ContainerService as never,
    viewOpenApiV2Service as never
  );
  return { service, db, query, resolve, viewOpenApiV2Service };
};

describe('SharedViewAccessV2Service', () => {
  it('resolves aggregate identity with Kysely and loads the View through Table', async () => {
    const fixture = createFixture({ id: 'viwShared', table_id: 'tblShared' });
    fixture.viewOpenApiV2Service.getView.mockResolvedValue({
      id: 'viwShared',
      enableShare: true,
      shareId: 'shrShared',
      shareMeta: { includeRecords: true },
    });

    await expect(fixture.service.findByShareId('shrShared')).resolves.toEqual({
      shareId: 'shrShared',
      tableId: 'tblShared',
      view: expect.objectContaining({ id: 'viwShared' }),
      shareMeta: { includeRecords: true },
    });

    expect(fixture.resolve).toHaveBeenCalledWith(v2MetaDbTokens.db);
    expect(fixture.db.selectFrom).toHaveBeenCalledWith('view');
    expect(fixture.query.where).toHaveBeenNthCalledWith(1, 'share_id', '=', 'shrShared');
    expect(fixture.query.where).toHaveBeenNthCalledWith(2, 'enable_share', '=', true);
    expect(fixture.query.where).toHaveBeenNthCalledWith(3, 'deleted_time', 'is', null);
    expect(fixture.viewOpenApiV2Service.getView).toHaveBeenCalledWith(
      'tblShared',
      'viwShared',
      expect.objectContaining({ actorId: expect.anything() })
    );
  });

  it('returns undefined without loading a Table when the active share index misses', async () => {
    const fixture = createFixture();

    await expect(fixture.service.findByShareId('shrMissing')).resolves.toBeUndefined();
    expect(fixture.viewOpenApiV2Service.getView).not.toHaveBeenCalled();
  });

  it.each([
    { enableShare: false, shareId: 'shrShared' },
    { enableShare: true, shareId: 'shrRotated' },
  ])('rejects stale aggregate share state: %j', async (view) => {
    const fixture = createFixture({ id: 'viwShared', table_id: 'tblShared' });
    fixture.viewOpenApiV2Service.getView.mockResolvedValue({
      id: 'viwShared',
      ...view,
    });

    await expect(fixture.service.findByShareId('shrShared')).resolves.toBeUndefined();
  });
});
