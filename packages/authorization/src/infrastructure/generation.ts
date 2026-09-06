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
  readonly onAdvance?: (from: number, to: number, via: Via) => void;
}

/**
 * How a node came to believe the current generation.
 *
 * `start` is separate from `backstop` on purpose. Both go through `refresh()`,
 * so a single flag reported "backstop" for every freshly started node and made
 * it impossible to tell a normal boot from a lost message — which is exactly
 * the question the flag existed to answer, and it was misread as evidence of a
 * dropped event during review.
 */
export type Via = 'start' | 'event' | 'backstop';

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
  private started = false;
  private readonly counts = { start: 0, event: 0, backstop: 0 };
  private lastEventAt = 0;
  private lastBackstopAt = 0;

  constructor(private readonly opts: OutboxGenerationOptions) {}

  current(): number {
    return this.value;
  }

  /** Authoritative read. Also how a starting node finds out where it is. */
  async refresh(): Promise<number> {
    // The sequence, not `max(id)`.
    //
    // `max(id)` goes backwards when rows are deleted, and the outbox is a table
    // people delete from — a retention job, or in this repository an
    // integration test cleaning up after itself. A node that restarted after
    // such a delete read a *lower* generation than its peers and then refused
    // to advance to theirs, because `advance` only moves forward. Two nodes
    // permanently disagreeing about the current generation is the exact failure
    // this mechanism exists to prevent, introduced by the way it read its own
    // clock.
    const { rows } = await this.opts.pool.query<{ seq: string }>(`SELECT COALESCE(
         pg_sequence_last_value(pg_get_serial_sequence('outbox', 'id')::regclass),
         0
       )::text AS seq`);
    const via: Via = this.started ? 'backstop' : 'start';
    this.started = true;
    this.advance(Number(rows[0]?.seq ?? 0), via);
    return this.value;
  }

  /**
   * What a node has actually seen.
   *
   * `backstop` being non-zero is the number that matters: it means the poll
   * caught a change the event stream did not deliver. On a healthy system it
   * stays at zero for the life of the process, so it is an alert rather than a
   * statistic.
   */
  stats(): {
    generation: number;
    advances: { start: number; event: number; backstop: number };
    lastEventAt: number;
    lastBackstopAt: number;
  } {
    return {
      generation: this.value,
      advances: { ...this.counts },
      lastEventAt: this.lastEventAt,
      lastBackstopAt: this.lastBackstopAt,
    };
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

  private advance(to: number, via: Via): void {
    if (!Number.isFinite(to) || to <= this.value) return;
    const from = this.value;
    this.value = to;
    this.counts[via] += 1;
    if (via === 'event') this.lastEventAt = Date.now();
    if (via === 'backstop') this.lastBackstopAt = Date.now();
    this.opts.onAdvance?.(from, to, via);
  }
}
