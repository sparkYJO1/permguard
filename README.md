# permguard

A permission service that answers one question — *can user X do Y on resource
Z?* — with permissions inherited through nested teams and nested resources.

The interesting part is not the question. It is what happens after you take a
permission away.

```bash
docker compose up -d --wait     # no API keys, nothing to configure
open http://localhost:3900
```

Three API nodes, a worker, Postgres, Redis and Redpanda. First run builds the
images, so it takes a few minutes; after that it is seconds.

## The window

A cached permission check that is stale is not a performance problem. Somebody
was fired at 14:31 and could still read the repository at 14:32.

So this repository publishes a number rather than an adjective:

```
--- invalidation window: revoke committed -> every node denies ---
rounds      30
nodes       3
p50         34 ms
p95         51 ms
max         54 ms
min          9 ms
relay poll  50 ms (OUTBOX_POLL_MS; the largest term below)

Backstop, if the event is lost entirely: 5000 ms.
```

`npm run bench:window` reproduces it. The full output is committed at
[`ops/measurements/invalidation-window.txt`](ops/measurements/invalidation-window.txt).

**What it measures.** Three API nodes are each asked the same question in a tight
loop. A grant is revoked. The window is the distance from the write committing to
the **last** node returning a deny — not the first and not the average, because a
revoked user only needs one node that still says yes.

**What it does not.** It is one laptop, one broker, three nodes, no network
between them. The shape of the result would survive a real deployment; the
constants would not.

**Where the time goes.** The window is roughly *U(0, relay poll interval) + 4 ms*:

| `OUTBOX_POLL_MS` | p50 | p95 |
|---|---|---|
| 5 | 9 ms | 15 ms |
| 50 (default) | 34 ms | 51 ms |
| 200 | 121 ms | 201 ms |

The floor of 4 ms is the pipeline itself — relay publish, Redpanda, consumer,
generation advance. Everything above it is waiting for the next poll.

**And when the event is lost.** 5000 ms, the backstop poll. Active invalidation
is the fast path; a node also re-reads the current generation from Postgres on a
timer, so a dropped message is a delay rather than a permanent hole. Both numbers
are published because only quoting the first would describe a system that has
never lost a message. [ADR-0001](docs/decisions/0001-active-invalidation-with-a-ttl-backstop.md).

## How invalidation works

The mechanism is one idea. Every cache key contains a **generation** — the outbox
id of the most recent authorization write:

```
pg:d:g<generation>:<user>:<permission>:<resource>
```

A node that has learned generation *N+1* cannot construct a key that reaches
anything cached under *N*. Nothing is evicted, nothing is enumerated, no reverse
traversal runs. The stale entries are still in memory and are simply no longer
addressable.

So the window is exactly one thing: **how long it takes a node to learn a
number.**

```
POST /admin/grants ──┐
                     │  one transaction: the grant row and its event
                     ▼
                 Postgres ──── outbox relay ──▶ Redpanda ──┬──▶ api1 ┐
                     ▲                                     ├──▶ api2 ├─ generation++
                     │                                     ├──▶ api3 ┘
                     │                                     └──▶ worker ──▶ audit_log
                     │
             GET /check ── L1 (in-process) ── L2 (Redis) ── recursive CTE
```

Each API node consumes into a consumer group **of its own**, so every node sees
every message. A shared group would hand each invalidation to exactly one node
and leave the other two serving stale allows — the bug this whole design exists
to prevent, and a one-word difference in a config string.

## The grant and its event are one transaction

This uses [nestjs-outbox](https://github.com/sparkYJO1/nestjs-outbox) — a library
extracted from an earlier repository — because a revoke that commits without its
event is a user who keeps their access, and an event published without its revoke
committing is a cache that denies something the database still allows.

`enqueue` takes the caller's transaction client and refuses one with no `BEGIN`
on it. [`test/outbox-atomicity.integration.test.ts`](test/outbox-atomicity.integration.test.ts)
rolls a transaction back and asserts that the row and the event disappear
together.

## Five technologies, not six

The plan for this repository named six. Neo4j was removed after it was measured.

Permission inheritance is a graph, so a graph database is the obvious choice —
which is exactly why it needed measuring rather than asserting.
`bench/graph-vs-cte.ts` runs both implementations behind the same interface, on
the same generated data, checking that they agree before timing either:

```
                                            allow (p50/p95)     deny (p50/p95)
shape    depth   grants        cte            graph          cte          graph
shallow    2/2    1,000    0.51/0.87       1.66/3.10     0.40/0.56    1.06/2.19
medium     5/6   10,000    0.43/0.52       1.02/1.63     0.38/0.51    0.89/1.33
deep     10/12   40,000    0.58/0.95       0.79/1.30     0.36/0.46    0.96/1.76
unreal   20/25  200,000    0.94/1.10       0.65/0.95     0.38/0.51    1.33/2.05
```

The curves cross. At `unreal` — teams 20 deep, resources 25 deep — Cypher wins
the allow case. That shape is not one an organisation produces. At every shape
that does occur, the recursive CTE wins or ties on allow and wins the deny case
outright, and deny is both the common case and the expensive one.

So the graph store bought nothing and would have cost a projection, a projection
lag, an ordering constraint on invalidation, and a container. It was cut. The
losing implementation is still in the tree and still runnable —
`npm run bench:graph` — because a decision you cannot re-derive in one command
gets re-argued from memory later. [ADR-0005](docs/decisions/0005-the-graph-store-had-to-earn-it.md).

What remains, and why:

| | |
|---|---|
| **Postgres** | Grants, identity, audit, and the outbox. The only source of truth, and after the measurement above, the thing that answers the check |
| **Redis** | L2 decision cache, shared between nodes. Losing it costs latency and never correctness — every call falls through to computing the answer |
| **Redpanda** | Invalidation fan-out to every node, plus the audit consumer. Three nodes needing the same message is what a log is for |
| **NestJS** | Module boundaries that hold the bounded contexts apart. Nothing outside a context can reach its `Pool` |
| **Next.js** | The window is a claim about time across three processes. A table of numbers does not show that; the timeline does |

## The decisions worth arguing about

| | |
|---|---|
| [ADR-0001](docs/decisions/0001-active-invalidation-with-a-ttl-backstop.md) | Events for speed, a poll for the floor. Precise eviction was rejected — it needs the check query run backwards over a graph that no longer exists |
| [ADR-0002](docs/decisions/0002-fail-closed-and-what-it-costs.md) | Fail closed when Postgres is gone, and never cache an `unavailable` deny |
| [ADR-0003](docs/decisions/0003-postgres-is-the-only-truth.md) | No read model, so no projection lag. Includes the ordering bug the removed design had to work around |
| [ADR-0004](docs/decisions/0004-every-answer-says-where-it-came-from.md) | Every answer carries its source and generation, on every response, not behind a flag |
| [ADR-0005](docs/decisions/0005-the-graph-store-had-to-earn-it.md) | Neo4j measured against a recursive CTE, and removed |
| [ADR-0006](docs/decisions/0006-no-negative-permissions-in-v1.md) | No `deny` rules in v1. Writing down what was left out and why |

## The model

```
everyone
├── engineering          editor on repo-core
│   ├── platform         owner  on repo-core/secrets
│   └── product-eng
└── contractors          viewer on repo-web
security                 owner  on acme  (the root — so: everything)

acme
├── repo-core
│   └── repo-core-secrets
├── repo-web
└── billing
```

Grants inherit **down** the resource tree and **up** the team tree: a member of
`platform` is a member of `engineering`, and a grant on `repo-core` reaches
`repo-core-secrets`. Roles absorb downward — `owner` ⊃ `editor` ⊃ `viewer` —
defined once in the domain, in code rather than configuration, and passed into
the query so neither implementation can keep a second copy of the lattice.

Three bounded contexts, each with `domain / application / infrastructure`. The
domain layer imports nothing from NestJS, Redis or Redpanda, which is why
`DecisionService` is unit-tested with no Docker running. Contexts talk only
through domain events.

```
packages/identity        users, teams, membership
packages/authorization   roles, grants, inheritance, the check, the caches
packages/audit           append-only record, built from the event stream
packages/shared-kernel   ids, the event envelope. Deliberately tiny
packages/platform        connection factories. Not domain
apps/api                 NestJS. Runs three times in compose
apps/worker              outbox relay + audit writer
apps/web                 Next.js. The graph, live per-node answers, the timeline
```

Audit keeps its own table rather than reading `grants`. That is the one place a
fact is stored twice, and it is on purpose: a revoke deletes the grant row, and
"who held this, and when was it taken away" has to outlive the row it describes.

## Authorization, not authentication

The user arrives in an `x-user-id` header. There is no login, and adding one
would be scope that teaches nothing about the hard part.

```bash
curl -H 'x-user-id: mallory' \
  'localhost:3901/check?permission=read&resource=repo-web'

{"allowed":true,"reason":"granted","source":"l2","atSeq":5,
 "path":[{"kind":"granted","subject":"contractors","role":"viewer","resource":"repo-web"}],
 "node":"api1","latencyMicros":1073}
```

`source` is which tier answered, `atSeq` is the generation. Two nodes reporting
different `atSeq` for the same question are two nodes about to disagree — which
is what the UI draws. [ADR-0004](docs/decisions/0004-every-answer-says-where-it-came-from.md).

## Tests

```bash
pnpm install
pnpm test                    # 13 unit tests, no Docker, no stores

pnpm run infra:up            # Postgres, Redis, Redpanda
pnpm build
pnpm run bootstrap           # schema + seed
pnpm run test:integration    # 18 tests against the real stores
```

`pnpm build` is not optional before the last two: the integration tests spawn the
compiled binaries rather than importing them, so there has to be something
compiled to spawn.

They are also safe to run while a full `docker compose up` stack is going. That
took a fix — the harness used to name its nodes `api1`, which put them in the
same Kafka consumer group as the running containers, so each invalidation went
to one cluster or the other and the tests failed with stale allows. Exactly the
failure [ADR-0001](docs/decisions/0001-active-invalidation-with-a-ttl-backstop.md)
is about, caused by a name collision.

The integration tests spawn the real compiled binaries as separate processes.
Importing the worker into the test process would share a Redis client, a Kafka
connection and an event loop with the code under test, and would quietly measure
something faster than what ships.

They assert the properties, not the numbers: that every node denies within a
second, that no node is still serving a cached allow afterwards, that the audit
entry outlives the grant row, and that a node which never receives the event
still converges via the backstop.

## Deliberately not here

Kubernetes. Multi-tenancy. Internationalisation. A dark-mode toggle. Login. A
configurable rule engine — the role lattice is code, so "who can read this" is a
question with an answer you can read off the source. Negative permissions, for
the reasons in [ADR-0006](docs/decisions/0006-no-negative-permissions-in-v1.md).

Per-resource-subtree invalidation is the obvious next step and is **not** claimed
as done: today one grant change cold-starts the whole decision cache, which is
invisible at this scale and would not be at a high write rate.

## Built with Claude

Claude wrote most of this code. The architecture, the trade-offs in
`docs/decisions/`, and the choice of what to leave out are mine.

The part worth reading is where an agent's proposal was rejected. ADR-0001
records the precise-eviction design that does not work, ADR-0002 the
last-known-good fallback that turns an outage into an incident, and ADR-0005 the
database that was built, wired up, working, and then deleted because the
benchmark said it was not earning its place.

## Licence

MIT.
