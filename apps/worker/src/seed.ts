import type { Pool } from 'pg';
import { PostgresIdentityRepository } from '@permguard/identity';
import { PostgresGrantRepository } from '@permguard/authorization';

/**
 * A small software company. Deliberately not a healthcare org, and deliberately
 * not generated — the shape is chosen so that every inheritance rule in the
 * model is exercised by at least one user, and so that the demo revoke has a
 * visible consequence.
 *
 *   everyone
 *   ├── engineering        editor on repo-core
 *   │   ├── platform       owner  on repo-core/secrets
 *   │   └── product-eng
 *   └── contractors        viewer on repo-web        <- the one that gets revoked
 *   security               owner  on acme (the root, so: everything)
 *
 *   acme
 *   ├── repo-core
 *   │   └── repo-core-secrets
 *   ├── repo-web
 *   └── billing
 */
export const TEAMS = [
  { id: 'everyone', displayName: 'Everyone', parentId: null },
  { id: 'engineering', displayName: 'Engineering', parentId: 'everyone' },
  { id: 'platform', displayName: 'Platform', parentId: 'engineering' },
  { id: 'product-eng', displayName: 'Product Engineering', parentId: 'engineering' },
  { id: 'security', displayName: 'Security', parentId: 'everyone' },
  { id: 'contractors', displayName: 'Contractors', parentId: 'everyone' },
] as const;

export const USERS = [
  { id: 'ada', displayName: 'Ada' },
  { id: 'grace', displayName: 'Grace' },
  { id: 'linus', displayName: 'Linus' },
  { id: 'mallory', displayName: 'Mallory' },
] as const;

export const MEMBERSHIPS = [
  { userId: 'ada', teamId: 'platform' },
  { userId: 'grace', teamId: 'product-eng' },
  { userId: 'linus', teamId: 'security' },
  { userId: 'mallory', teamId: 'contractors' },
] as const;

export const RESOURCES = [
  { id: 'acme', kind: 'org', parentId: null },
  { id: 'repo-core', kind: 'repo', parentId: 'acme' },
  { id: 'repo-core-secrets', kind: 'path', parentId: 'repo-core' },
  { id: 'repo-web', kind: 'repo', parentId: 'acme' },
  { id: 'billing', kind: 'service', parentId: 'acme' },
] as const;

export const GRANTS = [
  { subjectKind: 'team', subjectId: 'engineering', role: 'editor', resourceId: 'repo-core' },
  { subjectKind: 'team', subjectId: 'platform', role: 'owner', resourceId: 'repo-core-secrets' },
  { subjectKind: 'team', subjectId: 'security', role: 'owner', resourceId: 'acme' },
  { subjectKind: 'team', subjectId: 'contractors', role: 'viewer', resourceId: 'repo-web' },
  { subjectKind: 'user', subjectId: 'grace', role: 'owner', resourceId: 'repo-web' },
] as const;

/** The grant the demo and the window benchmark take away. */
export const DEMO_REVOKE = {
  userId: 'mallory',
  permission: 'read',
  resourceId: 'repo-web',
  grant: GRANTS[3],
} as const;

export async function seed(pool: Pool): Promise<void> {
  const identity = new PostgresIdentityRepository(pool);
  const grants = new PostgresGrantRepository(pool);

  for (const u of USERS) await identity.addUser(u);
  // Parents before children, so the foreign key holds without a deferred check.
  for (const t of TEAMS) await identity.addTeam({ ...t });
  for (const m of MEMBERSHIPS) await identity.addMembership(m);
  for (const r of RESOURCES) {
    await pool.query(
      'INSERT INTO resources (id, kind, parent_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [r.id, r.kind, r.parentId],
    );
  }
  for (const g of GRANTS) await grants.grant({ ...g });
}
