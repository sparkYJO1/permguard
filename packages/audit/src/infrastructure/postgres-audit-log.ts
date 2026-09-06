import type { Pool } from 'pg';
import type { AuditEntry, AuditLog } from '../domain/model';

export class PostgresAuditLog implements AuditLog {
  constructor(private readonly pool: Pool) {}

  async append(entry: AuditEntry): Promise<void> {
    // The unique index on outbox_id is what makes this idempotent. The relay
    // delivers at least once by design, so the second delivery has to be
    // harmless rather than merely unlikely.
    await this.pool.query(
      `INSERT INTO audit_log
         (event_type, outbox_id, subject_kind, subject_id, role, resource_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (outbox_id) DO NOTHING`,
      [
        entry.eventType,
        entry.outboxId,
        entry.subjectKind,
        entry.subjectId,
        entry.role,
        entry.resourceId,
        entry.occurredAt,
      ],
    );
  }

  async forResource(resourceId: string, limit = 50): Promise<readonly AuditEntry[]> {
    const { rows } = await this.pool.query<{
      event_type: string;
      outbox_id: string;
      subject_kind: string;
      subject_id: string;
      role: string;
      resource_id: string;
      occurred_at: Date;
    }>(
      `SELECT event_type, outbox_id::text, subject_kind, subject_id, role, resource_id, occurred_at
         FROM audit_log WHERE resource_id = $1 ORDER BY id DESC LIMIT $2`,
      [resourceId, limit],
    );
    return rows.map((r) => ({
      eventType: r.event_type,
      outboxId: Number(r.outbox_id),
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      role: r.role,
      resourceId: r.resource_id,
      occurredAt: r.occurred_at.toISOString(),
    }));
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_log');
    return Number(rows[0]?.n ?? 0);
  }
}
