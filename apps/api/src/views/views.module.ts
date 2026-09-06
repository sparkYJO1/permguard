import { Controller, Get, Inject, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import type { GrantRepository } from '@permguard/authorization';
import type { IdentityRepository } from '@permguard/identity';
import { PG } from '../platform.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { GRANT_REPOSITORY } from '../authorization/tokens';
import { IDENTITY_REPOSITORY, IdentityModule } from '../identity/identity.module';

/**
 * The read model the visualiser draws.
 *
 * It is assembled here, in the API, from the two contexts' exported ports —
 * not by joining their tables. That distinction is the point of the rule: this
 * composition is allowed to know that both contexts exist, and neither context
 * is allowed to know about the other.
 *
 * Resources are read directly because the resource tree is authorization's own
 * data and has no repository of its own yet; if a fourth context ever owns it,
 * this is the one place that changes.
 */
@Controller('graph')
class GraphController {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository,
    @Inject(GRANT_REPOSITORY) private readonly grants: GrantRepository,
    @Inject(PG) private readonly pool: Pool,
  ) {}

  @Get()
  async graph() {
    const [users, teams, memberships, grants, resources] = await Promise.all([
      this.identity.users(),
      this.identity.teams(),
      this.identity.memberships(),
      this.grants.list(),
      this.pool
        .query<{ id: string; kind: string; parent_id: string | null }>(
          'SELECT id, kind, parent_id FROM resources ORDER BY id',
        )
        .then((r) => r.rows.map((x) => ({ id: x.id, kind: x.kind, parentId: x.parent_id }))),
    ]);
    return { users, teams, memberships, resources, grants };
  }
}

@Module({
  imports: [AuthorizationModule, IdentityModule],
  controllers: [GraphController],
})
export class ViewsModule {}
