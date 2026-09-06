import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type {
  DecisionService,
  GrantRepository,
  Role,
} from '@permguard/authorization';
import { isPermission, isRole } from '@permguard/authorization';
import { config } from '@permguard/platform';
import { DECISION_SERVICE, GRANT_REPOSITORY } from './tokens';
import { CacheInvalidator } from './cache-invalidator.service';

@Controller()
export class AuthorizationController {
  constructor(
    @Inject(DECISION_SERVICE) private readonly decisions: DecisionService,
    @Inject(GRANT_REPOSITORY) private readonly grants: GrantRepository,
    private readonly invalidator: CacheInvalidator,
  ) {}

  /**
   * The whole product, in one route.
   *
   * The user arrives in a header. This service authorizes; it does not
   * authenticate, and pretending otherwise by adding a login form would be
   * scope that teaches the reader nothing about the hard part. In front of this
   * would sit whatever issues the header — that is a different problem with a
   * large number of good existing answers.
   */
  @Get('check')
  async check(
    @Headers('x-user-id') userId: string | undefined,
    @Query('permission') permission: string,
    @Query('resource') resourceId: string,
  ) {
    if (!userId) throw new BadRequestException('x-user-id header is required');
    if (!permission || !isPermission(permission)) {
      throw new BadRequestException(`permission must be one of read, write, delete, grant`);
    }
    if (!resourceId) throw new BadRequestException('resource is required');

    const startedAt = process.hrtime.bigint();
    const decision = await this.decisions.check({ userId, permission, resourceId });
    const micros = Number((process.hrtime.bigint() - startedAt) / 1000n);

    return {
      ...decision,
      node: config.nodeId,
      // Reported on every answer, not hidden behind a debug flag. A permission
      // decision you cannot attribute to a source and a generation is one you
      // cannot investigate after the fact.
      latencyMicros: micros,
      observedAt: Date.now(),
    };
  }

  @Get('admin/grants')
  async list() {
    return { grants: await this.grants.list() };
  }

  @Post('admin/grants')
  async grant(
    @Body() body: { subjectKind?: string; subjectId?: string; role?: string; resourceId?: string },
  ) {
    if (body.subjectKind !== 'user' && body.subjectKind !== 'team') {
      throw new BadRequestException('subjectKind must be user or team');
    }
    if (!body.role || !isRole(body.role)) {
      throw new BadRequestException('role must be one of viewer, editor, owner');
    }
    if (!body.subjectId || !body.resourceId) {
      throw new BadRequestException('subjectId and resourceId are required');
    }
    const result = await this.grants.grant({
      subjectKind: body.subjectKind,
      subjectId: body.subjectId,
      role: body.role as Role,
      resourceId: body.resourceId,
    });
    // `committedAt` is the zero point of the invalidation window. The write and
    // its event are already durable when this is read.
    return { ...result, committedAt: Date.now() };
  }

  @Delete('admin/grants/:id')
  async revoke(@Param('id') id: string) {
    const result = await this.grants.revoke(id);
    return { ...result, committedAt: Date.now() };
  }

  /** What this node believes right now. The bench and the UI both poll it. */
  @Get('generation')
  generation() {
    return { node: config.nodeId, ...this.invalidator.status() };
  }
}
