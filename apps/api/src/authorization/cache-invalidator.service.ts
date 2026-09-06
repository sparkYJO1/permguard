import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Consumer } from 'kafkajs';
import type { Pool } from 'pg';
import { OutboxGeneration } from '@permguard/authorization';
import { TOPIC } from '@permguard/shared-kernel';
import { config, consumer } from '@permguard/platform';
import { PG } from '../platform.module';

/**
 * The thing being measured.
 *
 * This node learns that a permission changed by consuming
 * `authorization.events` into a consumer group of its own — one group per node,
 * so every node sees every message rather than the messages being shared out
 * between them. The moment `observe()` moves the generation forward, every
 * cached decision on this node becomes unaddressable.
 *
 * Nothing sits between the write and this consumer except the outbox relay. An
 * earlier design routed invalidation through a projector that first updated a
 * graph read model and then announced it; removing the graph removed the hop,
 * and the measured window in the README is the number after that removal.
 *
 * `adoptedAt` is recorded because the number this repository publishes is the
 * distance between a revoke committing and this line running on the slowest
 * node. Without the timestamp there is nothing to subtract.
 */
@Injectable()
export class CacheInvalidator implements OnModuleInit, OnModuleDestroy {
  readonly generation: OutboxGeneration;
  private consumerRef: Consumer | null = null;
  private adoptedAt = 0;
  private adoptedVia: 'event' | 'backstop' | 'start' = 'start';

  constructor(@Inject(PG) pool: Pool) {
    this.generation = new OutboxGeneration({
      pool,
      backstopMs: config.generationBackstopMs,
      onAdvance: (_from, _to, via) => {
        this.adoptedAt = Date.now();
        this.adoptedVia = via;
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.generation.refresh();
    this.generation.start();

    // Group id includes the node id on purpose. A shared group would hand each
    // invalidation to exactly one node and leave the other two serving stale
    // allows — the bug this whole design exists to avoid, introduced by a
    // one-word difference in a config string.
    this.consumerRef = await consumer(
      `permguard-cache-${config.nodeId}`,
      `permguard-cache-${config.nodeId}`,
    );
    await this.consumerRef.subscribe({ topic: TOPIC.authorization, fromBeginning: false });
    await this.consumerRef.run({
      eachMessage: async ({ message }) => {
        // The generation is the outbox id, and the relay puts it in a header on
        // every message it publishes. Nothing needs to be parsed out of the
        // body to invalidate.
        const outboxId = Number(message.headers?.['outbox-id']?.toString() ?? 0);
        this.generation.observe(outboxId);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.generation.stop();
    await this.consumerRef?.disconnect();
  }

  status(): { generation: number; adoptedAt: number; adoptedVia: string } {
    return {
      generation: this.generation.current(),
      adoptedAt: this.adoptedAt,
      adoptedVia: this.adoptedVia,
    };
  }
}
