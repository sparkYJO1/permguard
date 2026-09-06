'use client';

import { useEffect, useState } from 'react';
import {
  explain,
  impact,
  reachable,
  type ExplainResult,
  type ImpactResult,
  type PathEdge,
  type ReachableResult,
} from '../lib/api';

/**
 * The three questions a boolean cannot answer.
 *
 * `/check` returns one bit and is the thing the service is for. These are the
 * things a *person* asks when the bit surprises them, and they are the reason
 * the graph store is in this repository at all — each one is a traversal that
 * cannot stop at the first path it finds.
 */
export function ExplainPanel({
  userId,
  permission,
  resourceId,
  activeGrant,
}: {
  userId: string;
  permission: string;
  resourceId: string;
  activeGrant: { subjectId: string; role: string; resourceId: string } | undefined;
}) {
  const [why, setWhy] = useState<ExplainResult | null>(null);
  const [who, setWho] = useState<ReachableResult | null>(null);
  const [blast, setBlast] = useState<ImpactResult | null>(null);

  useEffect(() => {
    let stale = false;
    void Promise.all([
      explain(userId, permission, resourceId).catch(() => null),
      reachable(permission, resourceId).catch(() => null),
      activeGrant ? impact(activeGrant, permission).catch(() => null) : Promise.resolve(null),
    ]).then(([w, r, b]) => {
      if (stale) return;
      setWhy(w);
      setWho(r);
      setBlast(b);
    });
    return () => {
      stale = true;
    };
  }, [userId, permission, resourceId, activeGrant]);

  return (
    <div className="panel">
      <h2>Why, who else, and what breaks</h2>

      <div className="row">
        <div style={{ flex: '1 1 320px' }}>
          <h3>
            why <Engine r={why} />
          </h3>
          {why === null ? (
            <p className="note">—</p>
          ) : why.paths === 0 ? (
            <p className="note">No path. {userId} cannot {permission} {resourceId}.</p>
          ) : (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                {why.paths} independent path{why.paths === 1 ? '' : 's'}. Revoking one of several
                changes nothing — the most common surprise when taking access away.
              </p>
              {why.explanations.map((e, i) => (
                <div key={i} className="chain">
                  {e.edges.map((edge, j) => (
                    <Edge key={j} edge={edge} last={j === e.edges.length - 1} />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ flex: '1 1 240px' }}>
          <h3>
            who else <Engine r={who} />
          </h3>
          {who === null ? (
            <p className="note">—</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>user</th>
                  <th className="num">paths</th>
                </tr>
              </thead>
              <tbody>
                {who.users.map((u) => (
                  <tr key={u.userId}>
                    <td className={u.userId === userId ? 'allow' : undefined}>{u.userId}</td>
                    <td className="num">{u.paths}</td>
                  </tr>
                ))}
                {who.users.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="note">nobody</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ flex: '1 1 240px' }}>
          <h3>
            what breaks <Engine r={blast} />
          </h3>
          {activeGrant === undefined ? (
            <p className="note">Nothing selected to revoke.</p>
          ) : blast === null ? (
            <p className="note">—</p>
          ) : (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                If <code>{activeGrant.subjectId}</code> loses <code>{activeGrant.role}</code> on{' '}
                <code>{activeGrant.resourceId}</code>, these lose <code>{permission}</code>:
              </p>
              <table>
                <tbody>
                  {blast.lost.map((l, i) => (
                    <tr key={i}>
                      <td>{l.userId}</td>
                      <td className="deny">{l.resourceId}</td>
                    </tr>
                  ))}
                  {blast.lost.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="note">nobody — another grant still covers it</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <p className="note">
        <code>why</code> and <code>who else</code> are answered by Neo4j, which wins those
        traversals and wins by more as the graph grows. <code>what breaks</code> is answered by the
        property graph inside Postgres even though Neo4j is faster at it — that answer is acted on
        immediately, and Postgres writes the graph in the same transaction as the grant, so it
        cannot be behind.
      </p>
    </div>
  );
}

function Engine({ r }: { r: { engine: string; authoritative: boolean } | null }) {
  if (!r) return null;
  return (
    <span className="tag" style={{ marginLeft: 8 }}>
      {r.engine}
      {r.authoritative ? ' · authoritative' : ' · projection'}
    </span>
  );
}

function Edge({ edge, last }: { edge: PathEdge; last: boolean }) {
  const label =
    edge.rel === 'GRANTED'
      ? `── ${edge.role} ─▶`
      : edge.rel === 'MEMBER_OF'
        ? '── member of ─▶'
        : '── inside ─▶';
  return (
    <>
      <span className="node">{edge.from}</span>
      <span className={edge.rel === 'GRANTED' ? 'rel granted' : 'rel'}>{label}</span>
      {last ? <span className="node">{edge.to}</span> : null}
    </>
  );
}
