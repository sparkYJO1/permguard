import type { Pool } from 'pg';
import type { GenerationSource } from '../domain/ports';

export interface OutboxGenerationOptions {
  readonly pool: Pool;
  /**
   * The backstop interval, and therefore the answer to "how long can this node
   * be stale if the event never arrives".
   *
   * Active invalidation is the fast path and it is what the measured window in
   * the README reports. This is what happens when the fast path does not: a
   * dropped message, a consumer that died between poll and commit, a broker
   * partition. Trusting active invalidation alone means a lost message is a
   * permanent security hole, so the poll stays. ADR-0001.
   */
  readonly backstopMs?: number;
  readonly onAdvance?: (from: number, to: number, via: 'event' | 'backstop') => void;
}

/**
 * A node's belief about the current generation.
 *
 * The generation is the outbox id of the most recent authorization write. That
 * choice removes a moving part: there is no counter for anything to increment,
 * no second topic carrying it, and no window in which two writers could race to
 * bump it. The number is already durable, already monotonic, and already
 * attached to the event that carries the change.
 *
 * `current()` never awaits, because it is on the hot path of every check. The
 * value only ever moves forward — a message arriving out of order cannot rewind
 * a node into serving decisions it has already retired.
 */
export class OutboxGeneration implements GenerationSource {
  private value = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OutboxGenerationOptions) {}

  current(): number {
    return this.value;
  }

  /** Authoritative read. Also how a starting node finds out where it is. */
  async refresh(): Promise<number> {
    const { rows } = await this.opts.pool.query<{ seq: string }>(
      'SELECT COALESCE(max(id), 0)::text AS seq FROM outbox',
    );
    this.advance(Number(rows[0]?.seq ?? 0), 'backstop');
    return this.value;
  }

  /** Called by the invalidation consumer for each authorization event. */
  observe(outboxId: number): void {
    this.advance(outboxId, 'event');
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.backstopMs ?? 5_000;
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private advance(to: number, via: 'event' | 'backstop'): void {
    if (!Number.isFinite(to) || to <= this.value) return;
    const from = this.value;
    this.value = to;
    this.opts.onAdvance?.(from, to, via);
  }
}
