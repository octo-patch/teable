import { HttpErrorCode } from '@teable/core';
import { describe, expect, it, vi } from 'vitest';
import { ShareAuthService } from './share-auth.service';

const createFixture = (shareInfo?: {
  shareId: string;
  tableId: string;
  shareMeta?: { password?: string };
}) => {
  const prismaService = {
    view: { findFirst: vi.fn().mockResolvedValue(undefined) },
  };
  const sharedViewAccessV2Service = {
    findByShareId: vi.fn().mockResolvedValue(shareInfo),
  };
  const service = new ShareAuthService(
    {} as never,
    prismaService as never,
    {} as never,
    {} as never,
    sharedViewAccessV2Service as never
  );
  return { service, prismaService, sharedViewAccessV2Service };
};

describe('ShareAuthService v2 View access', () => {
  it('returns aggregate-backed share information without querying Prisma View', async () => {
    const shareInfo = {
      shareId: 'shrShared',
      tableId: 'tblShared',
      shareMeta: { password: 'secret' },
    };
    const fixture = createFixture(shareInfo);

    await expect(fixture.service.getShareViewInfo('shrShared', true)).resolves.toBe(shareInfo);
    expect(fixture.sharedViewAccessV2Service.findByShareId).toHaveBeenCalledWith('shrShared');
    expect(fixture.prismaService.view.findFirst).not.toHaveBeenCalled();
  });

  it('preserves missing-share behavior for metadata and password authentication', async () => {
    const fixture = createFixture();

    await expect(fixture.service.getShareViewInfo('shrMissing', true)).rejects.toMatchObject({
      code: HttpErrorCode.VALIDATION_ERROR,
    });
    await expect(fixture.service.authShareView('shrMissing', 'secret', true)).resolves.toBeNull();
    expect(fixture.prismaService.view.findFirst).not.toHaveBeenCalled();
  });

  it('accepts only the aggregate-backed password', async () => {
    const fixture = createFixture({
      shareId: 'shrShared',
      tableId: 'tblShared',
      shareMeta: { password: 'secret' },
    });

    await expect(fixture.service.authShareView('shrShared', 'secret', true)).resolves.toBe(
      'shrShared'
    );
    await expect(fixture.service.authShareView('shrShared', 'wrong', true)).resolves.toBeNull();
  });

  it('preserves the password-not-enabled validation branch', async () => {
    const fixture = createFixture({
      shareId: 'shrShared',
      tableId: 'tblShared',
    });

    await expect(fixture.service.authShareView('shrShared', 'secret', true)).rejects.toMatchObject({
      code: HttpErrorCode.VALIDATION_ERROR,
    });
  });

  it('uses the legacy Prisma lookup when v2 is not selected', async () => {
    const fixture = createFixture({
      shareId: 'shrV2MustNotRun',
      tableId: 'tblV2MustNotRun',
      shareMeta: { password: 'wrong-source' },
    });
    fixture.prismaService.view.findFirst.mockResolvedValue({
      id: 'viwLegacy',
      tableId: 'tblLegacy',
      name: 'Legacy shared View',
      type: 'grid',
      description: null,
      options: 'null',
      filter: 'null',
      sort: 'null',
      group: 'null',
      shareId: 'shrLegacy',
      shareMeta: JSON.stringify({ password: 'legacy-secret' }),
      enableShare: true,
      createdBy: 'usrLegacy',
      lastModifiedBy: null,
      createdTime: new Date('2026-01-01T00:00:00.000Z'),
      lastModifiedTime: null,
      columnMeta: '{}',
      isLocked: null,
    });

    await expect(fixture.service.getShareViewInfo('shrLegacy')).resolves.toMatchObject({
      shareId: 'shrLegacy',
      tableId: 'tblLegacy',
      shareMeta: { password: 'legacy-secret' },
    });
    await expect(fixture.service.authShareView('shrLegacy', 'legacy-secret')).resolves.toBe(
      'shrLegacy'
    );
    await expect(fixture.service.authShareView('shrLegacy', 'wrong')).resolves.toBeNull();
    expect(fixture.prismaService.view.findFirst).toHaveBeenCalledWith({
      where: { shareId: 'shrLegacy', enableShare: true, deletedTime: null },
    });
    expect(fixture.sharedViewAccessV2Service.findByShareId).not.toHaveBeenCalled();
  });
});
