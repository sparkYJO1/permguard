import { createServer } from 'node:http';
import { OutboxRelay } from 'nestjs-outbox';
import { PostgresAuditLog } from '@permguard/audit';
import type { AuthorizationEvent } from '@permguard/authorization';
import { TOPIC } from '@permguard/shared-kernel';
import { config, consumer, pgPool, producer, redis, redisReady, waitFor } from '@permguard/platform';

/**
 * Two jobs, one process.
 *
 *   outbox relay      grant writes  ->  authorization.events
 *   audit writer      events        ->  audit_log
 *
 * Notably the relay is *not* in the invalidation path in the sense of deciding
 * anything — the API nodes consume `authorization.events` directly. The relay's
 * only job is getting the committed row onto the topic, and its poll interval
 * is consequently the largest single term in the measured window.
 *
 * Both are safe to run more than one of: the relay takes rows with
 * FOR UPDATE SKIP LOCKED, and the audit write is idempotent on the outbox id.
 * One instance is enough for a demo and keeps the numbers easy to attribute.
 */
async function main(): Promise<void> {
  const pool = pgPool();
  const cache = redis();

  await waitFor('postgres', () => pool.query('SELECT 1'));
  await redisReady(cache);
  await waitFor('redis', () => cache.ping());

  const send = await producer('permguard-worker');
  const audit = new PostgresAuditLog(pool);

  const stats = { audited: 0, lastError: null as string | null };

  const relay = new OutboxRelay({
    pool,
    producer: send,
    batchSize: 100,
    // The relay poll is inside the invalidation window, so it is the first
    // number to look at when the window is worse than expected. 50ms is a
    // deliberate trade against idle database load; ADR-0001 has the reasoning.
    intervalMs: config.outboxPollMs,
    onError: (err) => {
      stats.lastError = err.message;
      console.error('[relay]', err.message);
    },
  });
  relay.start();

  const auditConsumer = await consumer('permguard-audit', 'permguard-audit');
  await auditConsumer.subscribe({ topic: TOPIC.authorization, fromBeginning: true });
  await auditConsumer.run({
    eachMessage: async ({ message }) => {
      const outboxId = Number(message.headers?.['outbox-id']?.toString() ?? 0);
      const event = JSON.parse(message.value!.toString()) as AuthorizationEvent;
      await audit.append({
        eventType: event.type,
        outboxId,
        subjectKind: event.payload.subjectKind,
        subjectId: event.payload.subjectId,
        role: event.payload.role,
        resourceId: event.payload.resourceId,
        occurredAt: event.occurredAt,
      });
      stats.audited += 1;
    },
  });

  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...stats }));
      return;
    }
    res.writeHead(404).end();
  }).listen(3910, () => console.log('[worker] listening on 3910'));

  const shutdown = async (): Promise<void> => {
    await relay.stop();
    await auditConsumer.disconnect();
    await send.disconnect();
    await pool.end();
    cache.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[worker] failed', err);
  process.exit(1);
});
