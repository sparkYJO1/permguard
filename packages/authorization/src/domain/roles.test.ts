import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, permissionsOf, rolesGranting } from './roles';

describe('role lattice', () => {
  it('absorbs the role below', () => {
    expect([...permissionsOf('viewer')].sort()).toEqual(['read']);
    expect([...permissionsOf('editor')].sort()).toEqual(['read', 'write']);
    expect([...permissionsOf('owner')].sort()).toEqual(['delete', 'grant', 'read', 'write']);
  });

  it('rolesGranting is the exact inverse of permissionsOf', () => {
    // The two stores each take `rolesGranting` as input. If this inverse ever
    // stopped holding, Cypher and SQL would still agree with each other and
    // both would be wrong, which is the hardest version of this bug to find.
    for (const permission of PERMISSIONS) {
      const claimed = new Set(rolesGranting(permission));
      for (const role of ROLES) {
        expect(claimed.has(role)).toBe(permissionsOf(role).has(permission));
      }
    }
  });

  it('read is granted by every role, grant only by owner', () => {
    expect(rolesGranting('read')).toEqual(['viewer', 'editor', 'owner']);
    expect(rolesGranting('grant')).toEqual(['owner']);
  });
});
