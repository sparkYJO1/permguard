import { Controller, Get, Inject, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostgresIdentityRepository, type IdentityRepository } from '@permguard/identity';
import { PG } from '../platform.module';

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

@Controller('identity')
class IdentityController {
  constructor(@Inject(IDENTITY_REPOSITORY) private readonly repo: IdentityRepository) {}

  @Get()
  async all() {
    const [users, teams, memberships] = await Promise.all([
      this.repo.users(),
      this.repo.teams(),
      this.repo.memberships(),
    ]);
    return { users, teams, memberships };
  }
}

@Module({
  controllers: [IdentityController],
  providers: [
    {
      provide: IDENTITY_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresIdentityRepository(pool),
      inject: [PG],
    },
  ],
  exports: [IDENTITY_REPOSITORY],
})
export class IdentityModule {}
