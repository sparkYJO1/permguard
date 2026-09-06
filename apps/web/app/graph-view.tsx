'use client';

import type { Graph } from '../lib/api';

/**
 * The permission graph, drawn from the same data the check walks.
 *
 * Three columns because the model has three dimensions of inheritance and they
 * compose: a user reaches a team, a team sits inside a team, a grant lands on a
 * resource, and a resource sits inside a resource. Every allow in this system is
 * a path across this picture, and every deny is the absence of one.
 */
export function GraphView({
  graph,
  highlightUser,
  highlightResource,
}: {
  graph: Graph;
  highlightUser: string;
  highlightResource: string;
}) {
  const teamDepth = (id: string): number => {
    let d = 0;
    let cur = graph.teams.find((t) => t.id === id);
    while (cur?.parentId) {
      d += 1;
      cur = graph.teams.find((t) => t.id === cur!.parentId);
    }
    return d;
  };
  const resDepth = (id: string): number => {
    let d = 0;
    let cur = graph.resources.find((r) => r.id === id);
    while (cur?.parentId) {
      d += 1;
      cur = graph.resources.find((r) => r.id === cur!.parentId);
    }
    return d;
  };

  const rowH = 34;
  const users = graph.users;
  const teams = [...graph.teams].sort((a, b) => teamDepth(a.id) - teamDepth(b.id) || a.id.localeCompare(b.id));
  const resources = [...graph.resources].sort((a, b) => resDepth(a.id) - resDepth(b.id) || a.id.localeCompare(b.id));
  const height = Math.max(users.length, teams.length, resources.length) * rowH + 56;

  const userY = (id: string): number => 44 + users.findIndex((u) => u.id === id) * rowH;
  const teamY = (id: string): number => 44 + teams.findIndex((t) => t.id === id) * rowH;
  const resY = (id: string): number => 44 + resources.findIndex((r) => r.id === id) * rowH;

  const X = { user: 70, team: 330, res: 640 };

  return (
    <div className="panel">
      <h2>The graph a check walks</h2>
      <div style={{ overflowX: 'auto' }}>
        <svg width={820} height={height} role="img" aria-label="permission graph">
          <text x={X.user} y={24} textAnchor="middle">users</text>
          <text x={X.team} y={24} textAnchor="middle">teams (nested)</text>
          <text x={X.res} y={24} textAnchor="middle">resources (nested)</text>

          {graph.teams.filter((t) => t.parentId).map((t) => (
            <line key={`tp-${t.id}`} x1={X.team + 46} y1={teamY(t.id)} x2={X.team + 46}
              y2={teamY(t.parentId!)} stroke="#2f3646" strokeWidth={1} />
          ))}
          {graph.resources.filter((r) => r.parentId).map((r) => (
            <line key={`rp-${r.id}`} x1={X.res + 52} y1={resY(r.id)} x2={X.res + 52}
              y2={resY(r.parentId!)} stroke="#2f3646" strokeWidth={1} />
          ))}
          {graph.memberships.map((m) => (
            <line key={`m-${m.userId}-${m.teamId}`} x1={X.user + 34} y1={userY(m.userId)}
              x2={X.team - 46} y2={teamY(m.teamId)}
              stroke={m.userId === highlightUser ? '#6c8cff' : '#2f3646'} strokeWidth={1.5} />
          ))}
          {graph.grants.map((g) => {
            const y1 = g.subjectKind === 'team' ? teamY(g.subjectId) : userY(g.subjectId);
            const x1 = g.subjectKind === 'team' ? X.team + 46 : X.user + 34;
            return (
              <g key={g.id}>
                <line x1={x1} y1={y1} x2={X.res - 52} y2={resY(g.resourceId)}
                  stroke="#3fb27f" strokeWidth={1.5} strokeDasharray="4 3" />
                <text x={(x1 + X.res - 52) / 2} y={(y1 + resY(g.resourceId)) / 2 - 4}
                  textAnchor="middle" fill="#3fb27f">{g.role}</text>
              </g>
            );
          })}

          {users.map((u) => (
            <g key={u.id}>
              <circle cx={X.user} cy={userY(u.id)} r={5}
                fill={u.id === highlightUser ? '#6c8cff' : '#3a4358'} />
              <text x={X.user - 12} y={userY(u.id) + 4} textAnchor="end"
                fill={u.id === highlightUser ? '#e6e9ef' : '#8b93a7'}>{u.id}</text>
            </g>
          ))}
          {teams.map((t) => (
            <g key={t.id}>
              <rect x={X.team - 46} y={teamY(t.id) - 10} width={92} height={20} rx={4}
                fill="#1e2430" stroke="#2f3646" />
              <text x={X.team} y={teamY(t.id) + 4} textAnchor="middle">{t.id}</text>
            </g>
          ))}
          {resources.map((r) => (
            <g key={r.id}>
              <rect x={X.res - 52} y={resY(r.id) - 10} width={104} height={20} rx={4}
                fill={r.id === highlightResource ? '#243049' : '#1e2430'}
                stroke={r.id === highlightResource ? '#6c8cff' : '#2f3646'} />
              <text x={X.res} y={resY(r.id) + 4} textAnchor="middle"
                fill={r.id === highlightResource ? '#e6e9ef' : '#8b93a7'}>{r.id}</text>
            </g>
          ))}
        </svg>
      </div>
      <p className="note">
        Solid blue: the selected user&apos;s memberships. Dashed green: grants, labelled with the
        role. Vertical grey: containment — a team inside a team, a resource inside a resource. A
        grant is inherited <em>down</em> the resource tree and <em>up</em> the team tree.
      </p>
    </div>
  );
}
