import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config } from '@permguard/platform';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableCors();
  app.enableShutdownHooks();
  await app.listen(config.apiPort, '0.0.0.0');
  console.log(`[api ${config.nodeId}] listening on ${config.apiPort}`);
}

bootstrap().catch((err) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
