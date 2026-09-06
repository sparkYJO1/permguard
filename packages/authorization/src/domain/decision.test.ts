import { describe, expect, it } from 'vitest';
import { decisionKey } from './decision';

const q = { userId: 'u1', permission: 'read' as const, resourceId: 'r1' };

describe('decisionKey', () => {
  it('changes when the generation changes', () => {
    // This is the invalidation mechanism, so it gets a test of its own rather
    // than being covered incidentally by the service tests.
    expect(decisionKey(q, 7)).not.toEqual(decisionKey(q, 8));
  });

  it('is stable for the same inputs', () => {
    expect(decisionKey(q, 7)).toEqual(decisionKey({ ...q }, 7));
  });

  it('separates permissions and resources', () => {
    expect(decisionKey(q, 1)).not.toEqual(decisionKey({ ...q, permission: 'write' }, 1));
    expect(decisionKey(q, 1)).not.toEqual(decisionKey({ ...q, resourceId: 'r2' }, 1));
  });
});
