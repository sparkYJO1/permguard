/**
 * Audit keeps its own record of what happened, built from the event stream.
 *
 * It deliberately does not read the `grants` table. A revoke deletes that row,
 * and the question audit exists to answer — "who had this, and when was it
 * taken away" — is about a row that no longer exists. Deriving the answer from
 * the current state would make it unanswerable at exactly the moment it is
 * asked.
 *
 * Append-only. There is no update method on this interface and there should
 * never be one.
 */
export interface AuditEntry {
  readonly eventType: string;
  /** The outbox id the event came from. Unique, and what makes replay safe. */
  readonly outboxId: number;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly role: string;
  readonly resourceId: string;
  readonly occurredAt: string;
}

export interface AuditLog {
  /** Idempotent on `outboxId`: at-least-once delivery must not double-write. */
  append(entry: AuditEntry): Promise<void>;
  forResource(resourceId: string, limit?: number): Promise<readonly AuditEntry[]>;
  count(): Promise<number>;
}
