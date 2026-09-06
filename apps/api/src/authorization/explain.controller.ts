import { BadRequestException, Controller, Get, Headers, Inject, Param, Query } from '@nestjs/common';
import type { GraphService } from '@permguard/authorization';
import { isPermission, isRole } from '@permguard/authorization';
import { KG_QUERIES } from './tokens';

/**
 * The questions a boolean cannot answer.
 *
 * `/check` says yes or no and is the hot path — cached, generational,
 * measured. These are the cold path: they always compute, they are never
 * cached, and they exist because "is this allowed" is the question a service
 * asks and "why is this allowed" is the question a person asks.
 *
 * All three are traversals over the property graph in `kg_nodes` / `kg_edges`.
 * The same three run against Neo4j in `bench/kg-engines.ts`, which is how
 * ADR-0007 compares them.
 */
@Controller()
export class ExplainController {
  constructor(@Inject(KG_QUERIES) private readonly graph: GraphService) {}

  /** Every path that grants this, not just the first one `/check` would find. */
  @Get('explain')
  async explain(
    @Headers('x-user-id') userId: string | undefined,
    @Query('permission') permission: string,
    @Query('resource') resourceId: string,
  ) {
    if (!userId) throw new BadRequestException('x-user-id header is required');
    if (!permission || !isPermission(permission)) {
      throw new BadRequestException('permission must be one of read, write, delete, grant');
    }
    if (!resourceId) throw new BadRequestException('resource is required');

    const { result: explanations, engine, authoritative } = await this.graph.why(
      userId,
      permission,
      resourceId,
    );
    return {
      userId,
      permission,
      resourceId,
      allowed: explanations.length > 0,
      // More than one path is not a bug and is worth surfacing: revoking one of
      // them changes nothing, which is the single most common surprise when
      // someone tries to take access away.
      paths: explanations.length,
      explanations,
      engine,
      authoritative,
    };
  }

  /** Everyone who can reach this resource. The traversal runs backwards. */
  @Get('reachable')
  async reachable(@Query('permission') permission: string, @Query('resource') resourceId: string) {
    if (!permission || !isPermission(permission)) {
      throw new BadRequestException('permission must be one of read, write, delete, grant');
    }
    if (!resourceId) throw new BadRequestException('resource is required');
    const { result: users, engine, authoritative } = await this.graph.who(permission, resourceId);
    return { permission, resourceId, users, engine, authoritative };
  }

  /**
   * What breaks if this grant is revoked.
   *
   * Answered before the revoke rather than discovered after it. The subtraction
   * is the point: a pair only appears here if *no other* grant still covers it.
   */
  @Get('impact/:subjectId/:role/:resourceId')
  async impact(
    @Param('subjectId') subjectId: string,
    @Param('role') role: string,
    @Param('resourceId') resourceId: string,
    @Query('permission') permission = 'read',
  ) {
    if (!isRole(role)) throw new BadRequestException('role must be viewer, editor or owner');
    if (!isPermission(permission)) {
      throw new BadRequestException('permission must be one of read, write, delete, grant');
    }
    const { result: lost, engine, authoritative } = await this.graph.blastRadius(
      { subjectId, role, resourceId },
      permission,
    );
    return { grant: { subjectId, role, resourceId }, permission, lost, engine, authoritative };
  }
}
