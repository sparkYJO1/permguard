/**
 * The browser talks to each API node directly on its published port.
 *
 * Proxying through Next would average the three nodes into one answer, and the
 * disagreement between them during an invalidation window is the entire thing
 * this page exists to show.
 */
export const NODES = (
  process.env.NEXT_PUBLIC_API_NODES ??
  'http://localhost:3901,http://localhost:3902,http://localhost:3903'
)
  .split(',')
  .map((url, i) => ({ id: `api${i + 1}`, url: url.trim() }));

export interface Decision {
  allowed: boolean;
  reason: string;
  source: string;
  atSeq: number;
  node: string;
  latencyMicros: number;
  observedAt: number;
}

export interface Graph {
  users: Array<{ id: string; displayName: string }>;
  teams: Array<{ id: string; displayName: string; parentId: string | null }>;
  memberships: Array<{ userId: string; teamId: string }>;
  resources: Array<{ id: string; kind: string; parentId: string | null }>;
  grants: Array<{
    id: string;
    subjectKind: string;
    subjectId: string;
    role: string;
    resourceId: string;
  }>;
}

export async function check(
  nodeUrl: string,
  userId: string,
  permission: string,
  resourceId: string,
): Promise<Decision> {
  const res = await fetch(
    `${nodeUrl}/check?permission=${permission}&resource=${encodeURIComponent(resourceId)}`,
    { headers: { 'x-user-id': userId }, cache: 'no-store' },
  );
  return res.json();
}

export async function loadGraph(): Promise<Graph> {
  const res = await fetch(`${NODES[0]!.url}/graph`, { cache: 'no-store' });
  return res.json();
}

export async function revoke(grantId: string): Promise<{ committedAt: number }> {
  const res = await fetch(`${NODES[0]!.url}/admin/grants/${grantId}`, {
    method: 'DELETE',
    cache: 'no-store',
  });
  return res.json();
}

export async function grant(body: {
  subjectKind: string;
  subjectId: string;
  role: string;
  resourceId: string;
}): Promise<unknown> {
  const res = await fetch(`${NODES[0]!.url}/admin/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return res.json();
}
