import {
  domainError,
  type CollaboratorDirectoryUser,
  type DomainError,
  type ICollaboratorDirectoryService,
  type IExecutionContext,
  type BaseId,
} from '@teable/v2-core';
import { inject, injectable } from '@teable/v2-di';
import type { V1TeableDatabase } from '@teable/v2-postgres-schema';
import type { Kysely } from 'kysely';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';

import { v2RecordRepositoryPostgresTokens } from '../di/tokens';

@injectable()
export class PostgresCollaboratorDirectoryService implements ICollaboratorDirectoryService {
  constructor(
    @inject(v2RecordRepositoryPostgresTokens.metaDb)
    private readonly db: Kysely<V1TeableDatabase>
  ) {}

  async listBaseUsers(
    _context: IExecutionContext,
    baseId: BaseId,
    options: Parameters<ICollaboratorDirectoryService['listBaseUsers']>[2]
  ): Promise<Result<ReadonlyArray<CollaboratorDirectoryUser>, DomainError>> {
    try {
      const base = await this.db
        .selectFrom('base')
        .select('space_id')
        .where('id', '=', baseId.toString())
        .executeTakeFirst();
      if (!base) {
        return err(
          domainError.notFound({
            code: 'base.not_found',
            message: `Base not found: ${baseId.toString()}`,
          })
        );
      }

      let query = this.db
        .selectFrom('collaborator')
        .innerJoin('users', 'users.id', 'collaborator.principal_id')
        .select(['users.id', 'users.name', 'users.avatar'])
        .where('collaborator.resource_id', 'in', [baseId.toString(), base.space_id])
        .where((eb) =>
          eb.or([eb('users.is_system', 'is', null), eb('users.is_system', '=', false)])
        )
        .orderBy('collaborator.created_time', 'desc')
        .offset(options.pagination.offset().toNumber())
        .limit(options.pagination.limit().toNumber());
      if (options.search) {
        query = query.where('users.name', 'ilike', `%${options.search}%`);
      }
      const rows = await query.execute();
      return ok(rows.map(PostgresCollaboratorDirectoryService.mapUser));
    } catch (error) {
      return err(
        domainError.infrastructure({
          message: 'Failed to list base collaborators',
          details: { error: (error as Error)?.message ?? String(error) },
        })
      );
    }
  }

  async listUsersByIds(
    _context: IExecutionContext,
    userIds: ReadonlyArray<string>,
    options: Parameters<ICollaboratorDirectoryService['listUsersByIds']>[2]
  ): Promise<Result<ReadonlyArray<CollaboratorDirectoryUser>, DomainError>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (!uniqueIds.length) return ok([]);

    try {
      let query = this.db
        .selectFrom('users')
        .select(['id', 'name', 'avatar'])
        .where('id', 'in', uniqueIds)
        .offset(options.pagination.offset().toNumber())
        .limit(options.pagination.limit().toNumber());
      if (options.search) {
        query = query.where('name', 'ilike', `%${options.search}%`);
      }
      const rows = await query.execute();
      return ok(rows.map(PostgresCollaboratorDirectoryService.mapUser));
    } catch (error) {
      return err(
        domainError.infrastructure({
          message: 'Failed to list referenced collaborators',
          details: { error: (error as Error)?.message ?? String(error) },
        })
      );
    }
  }

  private static mapUser(row: {
    readonly id: string;
    readonly name: string;
    readonly avatar: string | null;
  }): CollaboratorDirectoryUser {
    return { id: row.id, name: row.name, avatar: row.avatar };
  }
}
