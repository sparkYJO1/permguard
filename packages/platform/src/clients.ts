import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import Redis from 'ioredis';
import neo4j, { type Driver } from 'neo4j-driver';
import { Pool } from 'pg';
import { config } from './config';

export function pgPool(): Pool {
  return new Pool({ ...config.pg, max: 12 });
}

export function redis(): Redis {
  // The check path must not queue behind a reconnect: a Redis hiccup is
  // supposed to cost latency, and `enableOfflineQueue` would turn it into a
  // stall that looks like a permission failure.
  return new Redis(config.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 2 });
}

export function neo4jDriver(): Driver {
  return neo4j.driver(
    config.neo4j.url,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
    { disableLosslessIntegers: true },
  );
}

export function kafka(clientId: string): Kafka {
  return new Kafka({ clientId, brokers: [...config.kafkaBrokers], logLevel: logLevel.ERROR });
}

export async function producer(clientId: string): Promise<Producer> {
  const p = kafka(clientId).producer({ allowAutoTopicCreation: true });
  await p.connect();
  return p;
}

export async function consumer(clientId: string, groupId: string): Promise<Consumer> {
  const c = kafka(clientId).consumer({ groupId, allowAutoTopicCreation: true });
  await c.connect();
  return c;
}

/** Wait for a dependency to answer. Used by bootstrap, not by the hot path. */
export async function waitFor(
  label: string,
  probe: () => Promise<unknown>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${label} not ready after ${timeoutMs}ms: ${String(lastError)}`);
}

/**
 * Resolves once the client can accept a command.
 *
 * Needed because `enableOfflineQueue: false` is the right setting for the hot
 * path and the wrong one for startup: with no offline queue the first command
 * issued before the socket is up fails outright rather than waiting. Startup
 * waits here; the request path never does.
 */
export async function redisReady(client: import('ioredis').Redis, timeoutMs = 30_000): Promise<void> {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redis not ready in time')), timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      client.off('error', onError);
      resolve();
    };
    const onError = (): void => undefined;
    client.once('ready', done);
    client.on('error', onError);
  });
}
