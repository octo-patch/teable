import { createV2HttpClient } from '@teable/v2-contract-http-client';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getSharedTestContext,
  TEST_USER,
  type SharedTestContext,
} from './shared/globalTestContext';

describe('v2 http View operation contracts (e2e)', () => {
  let ctx: SharedTestContext;
  let client: ReturnType<typeof createV2HttpClient>;
  let tableId: string;
  let foreignTableId: string;
  let viewId: string;
  let seedViewId: string;
  let foreignViewId: string;
  let primaryFieldId: string;
  let statusFieldId: string;
  let pluginViewId: string | undefined;
  let pluginInstallId: string | undefined;

  const pluginId = `plg${'c'.repeat(16)}`;

  beforeAll(async () => {
    ctx = await getSharedTestContext();
    client = createV2HttpClient({ baseUrl: ctx.baseUrl });

    const table = await ctx.createTable({
      baseId: ctx.baseId,
      name: 'View Operations Contract',
      fields: [
        { type: 'singleLineText', name: 'Name', isPrimary: true },
        {
          type: 'singleSelect',
          name: 'Status',
          options: {
            choices: [
              { id: 'choTodo', name: 'Todo', color: 'blue' },
              { id: 'choDone', name: 'Done', color: 'green' },
            ],
          },
        },
      ],
      views: [
        { type: 'grid', name: 'Seed' },
        { type: 'grid', name: 'Working' },
      ],
    });
    tableId = table.id;
    seedViewId = table.views[0]?.id ?? '';
    viewId = table.views[1]?.id ?? '';
    primaryFieldId = table.fields.find((field) => field.isPrimary)?.id ?? '';
    statusFieldId = table.fields.find((field) => field.name === 'Status')?.id ?? '';
    if (!seedViewId || !viewId || !primaryFieldId || !statusFieldId) {
      throw new Error('View operation contract fixture is incomplete');
    }

    const foreignTable = await ctx.createTable({
      baseId: ctx.baseId,
      name: 'Foreign View Operations Contract',
      fields: [{ type: 'singleLineText', name: 'Name', isPrimary: true }],
      views: [{ type: 'grid', name: 'Foreign' }],
    });
    foreignTableId = foreignTable.id;
    foreignViewId = foreignTable.views[0]?.id ?? '';
    if (!foreignViewId) throw new Error('Foreign View fixture is incomplete');

    await ctx.testContainer.db.schema
      .createTable('plugin')
      .ifNotExists()
      .addColumn('id', 'varchar', (column) => column.primaryKey())
      .addColumn('name', 'varchar', (column) => column.notNull())
      .addColumn('logo', 'varchar', (column) => column.notNull())
      .addColumn('url', 'varchar')
      .addColumn('status', 'varchar', (column) => column.notNull())
      .addColumn('positions', 'text', (column) => column.notNull())
      .addColumn('created_by', 'varchar', (column) => column.notNull())
      .execute();
    await ctx.testContainer.db.schema
      .createTable('plugin_install')
      .ifNotExists()
      .addColumn('id', 'varchar', (column) => column.primaryKey())
      .addColumn('plugin_id', 'varchar', (column) => column.notNull())
      .addColumn('base_id', 'varchar', (column) => column.notNull())
      .addColumn('name', 'varchar', (column) => column.notNull())
      .addColumn('position_id', 'varchar', (column) => column.notNull())
      .addColumn('position', 'varchar', (column) => column.notNull())
      .addColumn('storage', 'text')
      .addColumn('created_time', 'timestamptz', (column) =>
        column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
      )
      .addColumn('created_by', 'varchar', (column) => column.notNull())
      .addColumn('last_modified_time', 'timestamptz')
      .addColumn('last_modified_by', 'varchar')
      .execute();

    await ctx.testContainer.db
      .insertInto('plugin')
      .values({
        id: pluginId,
        name: 'Contract Plugin',
        logo: 'contract-plugin.svg',
        url: 'https://example.test/plugin',
        status: 'published',
        positions: JSON.stringify(['view']),
        created_by: TEST_USER.id,
      })
      .execute();
  });

  afterAll(async () => {
    if (ctx && tableId)
      await ctx.deleteTable(tableId, { mode: 'permanent' }).catch(() => undefined);
    if (ctx && foreignTableId) {
      await ctx.deleteTable(foreignTableId, { mode: 'permanent' }).catch(() => undefined);
    }
    if (ctx) {
      await ctx.testContainer.db
        .deleteFrom('plugin_install')
        .where('plugin_id', '=', pluginId)
        .execute()
        .catch(() => undefined);
      await ctx.testContainer.db
        .deleteFrom('plugin')
        .where('id', '=', pluginId)
        .execute()
        .catch(() => undefined);
    }
  });

  it('exposes filter-link records, snapshots, and document IDs through aggregate reads', async () => {
    const links = await client.tables.getViewFilterLinkRecords({ tableId, viewId });
    expect(links).toEqual({ ok: true, data: { groups: [] } });

    const snapshots = await client.tables.getViewSnapshots({
      tableId,
      viewIds: [viewId, seedViewId],
    });
    expect(snapshots.ok).toBe(true);
    if (!snapshots.ok) return;
    expect(snapshots.data.snapshots.map((snapshot) => snapshot.id)).toEqual([viewId, seedViewId]);
    expect(snapshots.data.snapshots[0]).toMatchObject({
      id: viewId,
      type: 'json0',
      data: { id: viewId, name: 'Working' },
    });

    const docIds = await client.tables.listViewDocIds({ tableId });
    expect(docIds).toEqual({
      ok: true,
      data: { ids: [seedViewId, viewId] },
    });
  });

  it('runs every ordinary View lifecycle mutation through Table aggregate commands', async () => {
    const renamed = await client.tables.renameView({
      tableId,
      viewId,
      name: 'Planning',
    });
    expect(renamed.ok).toBe(true);

    const described = await client.tables.updateViewDescription({
      tableId,
      viewId,
      description: 'Planning details',
    });
    expect(described.ok).toBe(true);

    const locked = await client.tables.updateViewLocked({
      tableId,
      viewId,
      isLocked: true,
    });
    expect(locked.ok).toBe(true);

    const ordered = await client.tables.updateViewOrder({
      tableId,
      viewId,
      anchorId: seedViewId,
      position: 'before',
    });
    expect(ordered.ok).toBe(true);

    const columnMeta = await client.tables.updateViewColumnMeta({
      tableId,
      viewId,
      columnMeta: [{ fieldId: primaryFieldId, columnMeta: { width: 280 } }],
    });
    expect(columnMeta.ok).toBe(true);

    const filtered = await client.tables.updateViewFilter({
      tableId,
      viewId,
      filter: {
        conjunction: 'and',
        filterSet: [
          {
            fieldId: primaryFieldId,
            operator: 'LIKE',
            isSymbol: true,
            value: 'alpha',
          },
        ],
      },
    });
    expect(filtered.ok).toBe(true);

    const sorted = await client.tables.updateViewSort({
      tableId,
      viewId,
      sort: {
        sortObjs: [{ fieldId: primaryFieldId, order: 'asc' }],
        manualSort: false,
      },
    });
    expect(sorted.ok).toBe(true);

    const grouped = await client.tables.updateViewGroup({
      tableId,
      viewId,
      group: [{ fieldId: statusFieldId, order: 'desc' }],
    });
    expect(grouped.ok).toBe(true);

    const options = await client.tables.updateViewOptions({
      tableId,
      viewId,
      options: { rowHeight: 'medium' },
    });
    expect(options.ok).toBe(true);

    const manualSort = await client.tables.applyViewManualSort({
      tableId,
      viewId,
      sort: [],
    });
    expect(manualSort).toMatchObject({
      ok: true,
      data: { viewId, updatedRecordCount: 0 },
    });

    const current = await client.tables.getView({ tableId, viewId });
    expect(current).toMatchObject({
      ok: true,
      data: {
        view: {
          id: viewId,
          name: 'Planning',
          description: 'Planning details',
          isLocked: true,
          options: { rowHeight: 'medium' },
          columnMeta: { [primaryFieldId]: { width: 280 } },
        },
      },
    });
  });

  it('keeps share credentials replay-safe and out of non-credential responses', async () => {
    const enabled = await client.tables.enableViewShare({ tableId, viewId });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.data.shareId).toMatch(/^shr/);
    const firstShareId = enabled.data.shareId;

    const metadata = await client.tables.updateViewShareMeta({
      tableId,
      viewId,
      shareMeta: { allowCopy: false, password: 'secret' },
    });
    expect(metadata).toEqual({ ok: true, data: { viewId } });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain(firstShareId);

    const refreshed = await client.tables.refreshViewShareId({ tableId, viewId });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.data.shareId).toMatch(/^shr/);
    expect(refreshed.data.shareId).not.toBe(firstShareId);
    expect(JSON.stringify(refreshed)).not.toContain(firstShareId);

    const disabled = await client.tables.disableViewShare({ tableId, viewId });
    expect(disabled).toEqual({ ok: true, data: { viewId } });
    expect(JSON.stringify(disabled)).not.toContain(refreshed.data.shareId);
  });

  it('duplicates and deletes View children without bypassing the aggregate', async () => {
    const duplicated = await client.tables.duplicateView({ tableId, viewId });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const duplicateViewId = duplicated.data.viewId;
    expect(duplicateViewId).not.toBe(viewId);
    expect(duplicated.data.table.views).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: duplicateViewId, name: 'Planning 2' })])
    );

    const deleted = await client.tables.deleteView({
      tableId,
      viewId: duplicateViewId,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.data.table.views.some((view) => view.id === duplicateViewId)).toBe(false);
  });

  it('installs, reads, and updates a Plugin View through native contracts', async () => {
    const installed = await client.tables.installViewPlugin({
      tableId,
      pluginId,
      name: 'Contract Plugin View',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    pluginViewId = installed.data.viewId;
    pluginInstallId = installed.data.pluginInstallId;
    expect(installed.data).toMatchObject({
      pluginId,
      name: 'Contract Plugin View',
    });

    const metadata = await client.tables.getViewPluginInstall({
      tableId,
      viewId: pluginViewId,
    });
    expect(metadata).toMatchObject({
      ok: true,
      data: {
        pluginId,
        pluginInstallId,
        baseId: ctx.baseId,
        name: 'Contract Plugin View',
        url: 'https://example.test/plugin',
      },
    });

    const updated = await client.tables.updateViewPluginStorage({
      tableId,
      viewId: pluginViewId,
      pluginInstallId,
      storage: { nested: { enabled: true }, count: 2 },
    });
    expect(updated).toEqual({
      ok: true,
      data: {
        tableId,
        viewId: pluginViewId,
        pluginInstallId,
        storage: { nested: { enabled: true }, count: 2 },
      },
    });

    const reread = await client.tables.getViewPluginInstall({
      tableId,
      viewId: pluginViewId,
    });
    expect(reread).toMatchObject({
      ok: true,
      data: { storage: { nested: { enabled: true }, count: 2 } },
    });
  });

  it('rejects malformed and cross-Table child identifiers at the interface boundary', async () => {
    const malformed = await fetch(`${ctx.baseUrl}/tables/renameView`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tableId: 'invalid', viewId: 'invalid', name: 'Nope' }),
    });
    expect(malformed.status).toBe(400);

    await expect(
      client.tables.renameView({
        tableId,
        viewId: foreignViewId,
        name: 'Cross aggregate',
      })
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      client.tables.getViewSnapshots({
        tableId,
        viewIds: [foreignViewId],
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
