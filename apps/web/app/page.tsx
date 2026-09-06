'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NODES, check, grant, loadGraph, revoke, type Decision, type Graph } from '../lib/api';
import { GraphView } from './graph-view';
import { ExplainPanel } from './explain-panel';

interface Sample {
  readonly node: string;
  readonly at: number;
  readonly allowed: boolean;
  readonly source: string;
}

const PERMISSIONS = ['read', 'write', 'delete', 'grant'];

/**
 * The demo's starting state. `grant` is idempotent on the server — re-adding an
 * existing grant is a no-op and publishes nothing — so this restores whatever
 * is missing without disturbing what is not.
 */
const SEED_GRANTS = [
  { subjectKind: 'team', subjectId: 'engineering', role: 'editor', resourceId: 'repo-core' },
  { subjectKind: 'team', subjectId: 'platform', role: 'owner', resourceId: 'repo-core-secrets' },
  { subjectKind: 'team', subjectId: 'security', role: 'owner', resourceId: 'acme' },
  { subjectKind: 'team', subjectId: 'contractors', role: 'viewer', resourceId: 'repo-web' },
  { subjectKind: 'user', subjectId: 'grace', role: 'owner', resourceId: 'repo-web' },
] as const;

export default function Page() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [userId, setUserId] = useState('mallory');
  const [permission, setPermission] = useState('read');
  const [resourceId, setResourceId] = useState('repo-web');
  const [live, setLive] = useState<Record<string, Decision | null>>({});
  const [samples, setSamples] = useState<Sample[]>([]);
  const [t0, setT0] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);

  useEffect(() => {
    void loadGraph().then(setGraph).catch(() => undefined);
  }, []);

  // Poll every node continuously. The three answers are shown separately
  // because during an invalidation window they disagree, and that disagreement
  // is the thing worth looking at.
  useEffect(() => {
    let stopped = false;
    const loop = async (): Promise<void> => {
      while (!stopped) {
        const results = await Promise.all(
          NODES.map(async (n) => {
            try {
              return [n.id, await check(n.url, userId, permission, resourceId)] as const;
            } catch {
              return [n.id, null] as const;
            }
          }),
        );
        if (stopped) return;
        setLive(Object.fromEntries(results));
        if (polling.current) {
          const at = Date.now();
          setSamples((prev) => [
            ...prev,
            ...results
              .filter((r): r is readonly [string, Decision] => r[1] !== null)
              .map(([id, d]) => ({ node: id, at, allowed: d.allowed, source: d.source })),
          ]);
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }, [userId, permission, resourceId]);

  const activeGrant = graph?.grants.find(
    (g) => g.resourceId === resourceId && (g.subjectId === userId || g.subjectKind === 'team'),
  );

  const runRevoke = useCallback(async () => {
    if (!activeGrant) return;
    setBusy(true);
    setSamples([]);
    polling.current = true;
    await new Promise((r) => setTimeout(r, 250)); // let the pollers get in flight
    const { committedAt } = await revoke(activeGrant.id);
    setT0(committedAt);
    setTimeout(() => {
      polling.current = false;
      setBusy(false);
      void loadGraph().then(setGraph);
    }, 1500);
  }, [activeGrant]);

  // Restores every seeded grant, not just the one the demo revokes by default.
  // Restoring one of five meant anyone who revoked something else could not get
  // back to the starting state from the UI at all.
  const restore = useCallback(async () => {
    setBusy(true);
    for (const g of SEED_GRANTS) await grant(g);
    setTimeout(() => {
      void loadGraph().then(setGraph);
      setSamples([]);
      setT0(null);
      setBusy(false);
    }, 800);
  }, []);

  return (
    <main>
      <h1>permguard</h1>
      <p className="lede">
        A permission is revoked. Every node is being asked the same question, continuously. The
        window below is the distance from the write committing to the <em>last</em> node returning a
        deny — not the first, because a revoked user only needs one node that still says yes.
      </p>

      <div className="panel">
        <h2>Ask a question</h2>
        <div className="controls">
          <div>
            <label htmlFor="u">user (arrives as a header — this service does not log anyone in)</label>
            <select id="u" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {graph?.users.map((u) => (
                <option key={u.id} value={u.id}>{u.id}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="p">permission</label>
            <select id="p" value={permission} onChange={(e) => setPermission(e.target.value)}>
              {PERMISSIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="r">resource</label>
            <select id="r" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              {graph?.resources.map((r) => (
                <option key={r.id} value={r.id}>{r.id}</option>
              ))}
            </select>
          </div>
        </div>

        <table style={{ marginTop: 18 }}>
          <thead>
            <tr>
              <th>node</th><th>verdict</th><th>served from</th><th>generation</th><th className="num">µs</th>
            </tr>
          </thead>
          <tbody>
            {NODES.map((n) => {
              const d = live[n.id];
              return (
                <tr key={n.id}>
                  <td>{n.id}</td>
                  <td className={`verdict ${d?.allowed ? 'allow' : 'deny'}`}>
                    {d ? (d.allowed ? 'ALLOW' : 'DENY') : '—'}
                  </td>
                  <td><span className="tag">{d?.source ?? '—'}</span></td>
                  <td>{d?.atSeq ?? '—'}</td>
                  <td className="num">{d?.latencyMicros ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">
          <code>source</code> is where the answer came from: <code>l1</code> in-process,{' '}
          <code>l2</code> shared Redis, <code>relational</code> a fresh recursive CTE against
          Postgres. <code>generation</code> is the outbox id this node has caught up to — when
          two nodes show different generations, they are about to disagree.
        </p>
      </div>

      <div className="panel">
        <h2>Revoke, and watch the window</h2>
        <div className="controls">
          <button className="primary" onClick={() => void runRevoke()} disabled={busy || !activeGrant}>
            revoke {activeGrant ? `${activeGrant.subjectId} → ${activeGrant.role} on ${activeGrant.resourceId}` : '(nothing to revoke)'}
          </button>
          <button onClick={() => void restore()} disabled={busy}>restore all demo grants</button>
        </div>
        <Timeline samples={samples} t0={t0} />
      </div>

      <ExplainPanel
        userId={userId}
        permission={permission}
        resourceId={resourceId}
        activeGrant={
          activeGrant
            ? {
                subjectId: activeGrant.subjectId,
                role: activeGrant.role,
                resourceId: activeGrant.resourceId,
              }
            : undefined
        }
      />

      {graph ? <GraphView graph={graph} highlightUser={userId} highlightResource={resourceId} /> : null}
    </main>
  );
}

function Timeline({ samples, t0 }: { samples: readonly Sample[]; t0: number | null }) {
  if (t0 === null || samples.length === 0) {
    return <p className="note" style={{ marginTop: 16 }}>Press revoke to record a window.</p>;
  }
  const span = 400; // ms shown either side is enough; the window is tens of ms
  const start = t0 - 120;
  const pos = (at: number): number => Math.max(0, Math.min(100, ((at - start) / span) * 100));

  const flips = NODES.map((n) => {
    const after = samples.filter((s) => s.node === n.id && s.at >= t0 && !s.allowed);
    return { node: n.id, at: after.length > 0 ? after[0]!.at : null };
  });
  const worst = flips.reduce((m, f) => (f.at !== null && f.at - t0 > m ? f.at - t0 : m), 0);

  return (
    <>
      <div className="timeline" style={{ marginTop: 18 }}>
        <div className="t0" style={{ left: `calc(96px + ${pos(t0)}% * (100% - 112px) / 100)` }} />
        {flips.map((f, i) => (
          <div key={f.node}>
            <div className="tname" style={{ top: 12 + i * 30 }}>{f.node}</div>
            <div className="track" style={{ top: 12 + i * 30 }}>
              {f.at !== null ? (
                <div className="flip" style={{ left: `${pos(f.at)}%`, position: 'absolute', top: 0, bottom: 0 }} />
              ) : null}
            </div>
          </div>
        ))}
        <div className="axis"><span>t0 − 120ms</span><span>t0 + 280ms</span></div>
      </div>
      <p className="note">
        Window: <strong className={worst > 0 ? 'stale' : 'allow'}>{worst} ms</strong> from commit to
        the last node denying. Blue line is the commit; red lines are each node flipping. The bar
        before the red line is time that node was still answering ALLOW to a permission that no
        longer existed.
      </p>
    </>
  );
}
