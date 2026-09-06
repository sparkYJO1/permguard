import { Module } from '@nestjs/common';
import { PlatformModule } from './platform.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { IdentityModule } from './identity/identity.module';
import { AuditModule } from './audit/audit.module';
import { ViewsModule } from './views/views.module';
import { HealthController } from './health.controller';

@Module({
  imports: [PlatformModule, AuthorizationModule, IdentityModule, AuditModule, ViewsModule],
  controllers: [HealthController],
})
export class AppModule {}
