/**
 * The role lattice.
 *
 * This is deliberately code, not configuration. A configurable rule engine is
 * the single fastest way to make a permission system impossible to reason
 * about: the question "who can read this" stops having an answer you can read
 * off the source. Three roles and four permissions cover the demo, and adding a
 * fourth role is a pull request — which is the point, because it is reviewable.
 */
export const PERMISSIONS = ['read', 'write', 'delete', 'grant'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['viewer', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const isPermission = (v: string): v is Permission =>
  (PERMISSIONS as readonly string[]).includes(v);
export const isRole = (v: string): v is Role =>
  (ROLES as readonly string[]).includes(v);

/** Each role absorbs the one below it. `owner` ⊃ `editor` ⊃ `viewer`. */
const ROLE_PARENT: Record<Role, Role | null> = {
  owner: 'editor',
  editor: 'viewer',
  viewer: null,
};

/** Permissions a role adds on top of its parent. */
const ROLE_ADDS: Record<Role, readonly Permission[]> = {
  viewer: ['read'],
  editor: ['write'],
  owner: ['delete', 'grant'],
};

/** Everything `role` can do, walking the chain down to `viewer`. */
export function permissionsOf(role: Role): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  let cur: Role | null = role;
  while (cur !== null) {
    for (const p of ROLE_ADDS[cur]) out.add(p);
    cur = ROLE_PARENT[cur];
  }
  return out;
}

/**
 * The inverse: every role that confers `permission`.
 *
 * Both the Cypher traversal and the recursive CTE need this set, and neither
 * one is allowed to re-derive it. If the lattice were encoded a second time in
 * SQL it would drift from the Cypher copy, and the two stores would start
 * disagreeing about the same question — which is exactly the bug the fallback
 * in `DecisionService` is supposed to protect against, not cause.
 */
export function rolesGranting(permission: Permission): readonly Role[] {
  return ROLES.filter((r) => permissionsOf(r).has(permission));
}
