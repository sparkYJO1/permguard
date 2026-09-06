# permguard

**Somebody was fired at 14:31. At 14:32, can they still read the repository?**

A permission service with grants inherited through nested teams and nested
resources. It answers *can user X do Y on resource Z* — and three questions a
boolean cannot: *why*, *who else*, and *what breaks if I revoke this*.

```
                                    ┌──────────── api ×3 ────────────┐
POST /admin/grants ──┐              │  L1 in-process  →  L2 Redis    │
                     ▼              │        ↓ miss                  │
   ┌──── Postgres ───────┐          │  recursive CTE  ── /check      │
   │  grants + outbox    │          └────────────────────────────────┘
   │  kg_nodes/kg_edges  │                     ▲        ▲
   │  audit_log          │                     │        │ generation++
   └─────────────────────┘                     │        │
        │ one transaction                      │   Redpanda
        │                                      │        ▲
        └── outbox relay ──────────────────────┴────────┘
                                               │
                        worker ── projects ──► Neo4j ── /explain /reachable
                              └── audit_log
```

```bash
docker compose up -d --wait     # no API keys, nothing to configure
open http://localhost:3900
```

Three API nodes, a worker, Postgres, Neo4j, Redis and Redpanda. The first run
builds the images and takes a few minutes; after that it is seconds.

Two things are measured rather than asserted, and both are on this page: how
long a revoke takes to reach every node, and which of two knowledge graphs
answers a traversal faster. The second one deleted a database and then put it
back.

## The window

A cached permission check that is stale is not a performance problem. Somebody
was fired at 14:31 and could still read the repository at 14:32.

So this repository publishes a number rather than an adjective:

```
--- invalidation window: revoke committed -> every node denies ---
rounds      40
nodes       3
p50         40 ms
p95         66 ms
max         96 ms
min         14 ms
relay poll  50 ms (OUTBOX_POLL_MS; the largest term below)

Backstop, if the event is lost entirely: 5000 ms.
```

`pnpm run bench:window` reproduces it. The full output is committed at
[`ops/measurements/invalidation-window.txt`](ops/measurements/invalidation-window.txt).

**It will not reproduce exactly.** Across runs on the same laptop p50 lands
between 28 and 43ms and p95 between 61 and 68ms. That spread is the point of
publishing the script rather than only the number: what is stable is the shape —
p50 near half the relay poll interval, p95 a little over one interval, and a
floor around 10ms that is the pipeline itself. The default is 40 rounds because
at 20 a single scheduling hiccup moves p95 by 70ms.

**What it measures.** Three API nodes are each asked the same question in a tight
loop. A grant is revoked. The window is the distance from the write committing to
the **last** node returning a deny — not the first and not the average, because a
revoked user only needs one node that still says yes.

**What it does not.** It is one laptop, one broker, three nodes, no network
between them. The shape of the result would survive a real deployment; the
constants would not. Run it with the API containers stopped
(`docker compose stop api1 api2 api3 worker web`) or the benchmark's own nodes
compete with them for the same cores and the numbers drift upward as the run
goes on — which is visible in the `resolution` line when it happens.

**Where the time goes.** The window is roughly *U(0, relay poll interval) + 4 ms*:

| `OUTBOX_POLL_MS` | p50 | p95 |
|---|---|---|
| 5 | 9 ms | 15 ms |
| 50 (default) | 40 ms | 66 ms |
| 200 | 121 ms | 201 ms |

Measured with the whole stack running on one laptop, which is also why these are
a few milliseconds worse than an earlier run taken before Neo4j was part of it.
The store is not in the invalidation path; it is in the CPU.

The floor — 10ms in the run above, 4ms when the machine is otherwise idle — is the pipeline itself — relay publish, Redpanda, consumer,
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

## Two knowledge graphs, and which one answers what

Permission inheritance is a graph, so a graph database is the obvious choice —
which is exactly why it needed measuring. This repository measured it, removed
Neo4j, and then put it back when the measurement turned out to be wrong three
times over. [ADR-0007](docs/decisions/0007-two-knowledge-graphs-measured-properly.md)
has the full account; [ADR-0005](docs/decisions/0005-the-graph-store-had-to-earn-it.md)
is the superseded decision, kept rather than quietly rewritten.

The same graph is held twice, in the same shape: a generic property graph in
Postgres (`kg_nodes` / `kg_edges`, traversed by recursive CTE, written in the
grant's own transaction) and a Neo4j projection of the same nodes and edges.
`bench/kg-engines.ts` asks both four questions and asserts they agree before
timing anything.

**Three runs, all committed**, because one run of this benchmark is not a
result — cell to cell the numbers move by a factor of two. What reproduces
across all three at the largest shape (180 users, 25,001 grants):

| | Neo4j | Postgres KG | |
|---|---|---|---|
| **Q2 why** | 0.82 – 1.56 ms | 3.26 – 3.44 ms | Neo4j wins, 2–4x |
| **Q4 blast** | 32.2 – 34.0 ms | 81.0 – 92.6 ms | Neo4j wins, ~2.5x |
| Q3 who | 20.3 – 21.4 ms | 21.7 – 23.8 ms | tie |
| Q1 check | 0.95 – 2.29 ms | 1.90 – 2.09 ms | noise — and the relational schema beats both at 0.9–1.1 ms |

The first of those runs, quoted in an earlier version of this file, had Neo4j
winning Q1 and Q3 as well. The next two did not reproduce it. Both are in
[`ops/measurements/`](ops/measurements/) along with a note saying so.

**The slope is the robust finding, not the cells.** From the smallest shape to
the largest the graph grows 50x:

| | Postgres KG | Neo4j |
|---|---|---|
| **Q4 blast** | 2.5 → 81–93 ms (~30x) | 2.9 → 32–34 ms (~6–11x) |
| **Q2 why** | 1.2 → 3.3–3.4 ms (~2.6x) | 1.3 → 0.8–1.6 ms (flat or better) |

Traversal cost tracking the neighbourhood rather than the database is the thing
a graph store claims, and across three runs that is what shows up. The recursive
CTE cannot do it, because every level of the recursion is a join against a table
that is still growing.

So the answers are split by question rather than by preference:

| endpoint | engine | why |
|---|---|---|
| `/check` | normalized relational | Fastest at every size, is the source of truth, and sits behind two cache tiers |
| `/explain` | Neo4j | Q2, where it wins 2–4x and its lead grows with the graph |
| `/reachable` | Neo4j | Q3, where the two are **tied**. Routed here for consistency with `/explain`, not because the numbers demand it — said plainly rather than dressed up |
| `/impact` | Postgres property graph | Q4, where Neo4j is 2.5x faster and still the wrong choice: this answer is acted on *immediately*, and a projection can be tens of ms behind the graph being changed |

Every response names the engine that answered and whether it could have been
stale.

### The three mistakes are the useful part

| | cost | what it was |
|---|---|---|
| Walking from the wrong end | **60x** | The same check is 142ms from the resource, 2.3ms from the user. Neo4j walks whatever you point it at; the resource end has hundreds of incoming edges per node. `pnpm run bench:direction` re-runs it |
| Adding a property index | **35x, backwards** | An index on `GRANTED.role`, added for fairness, made the check 1.34 → 47ms. The planner pulled 175,008 relationships and filtered them against a nine-element set. In a graph store adjacency *is* the index |
| A projection that only added | wrong answers | `syncTopology` merged and never deleted, so one benchmark shape's data survived into the next. The agreement assertion caught it |

None of these were findings about Neo4j. All three were mine, and the first
benchmark shipped a conclusion built on the first of them.

### What each technology is for

| | |
|---|---|
| **Postgres** | Grants, identity, audit, the outbox, and a property graph written in the same transaction as the grant. The only source of truth |
| **Neo4j** | A projection of that graph, and the fastest way to walk it. Allowed to lag; never asked a question where lag would be wrong |
| **Redis** | L2 decision cache, shared between nodes. Losing it costs latency and never correctness |
| **Redpanda** | Invalidation fan-out to every node, plus the audit and projector consumers. Three nodes needing the same message is what a log is for |
| **NestJS** | Module boundaries that hold the bounded contexts apart. Nothing outside a context can reach its `Pool` |
| **Next.js** | The window is a claim about time across three processes, and `why` is a claim about paths. Neither is a table of numbers |

## The decisions worth arguing about

| | |
|---|---|
| [ADR-0001](docs/decisions/0001-active-invalidation-with-a-ttl-backstop.md) | Events for speed, a poll for the floor. Precise eviction was rejected — it needs the check query run backwards over a graph that no longer exists |
| [ADR-0002](docs/decisions/0002-fail-closed-and-what-it-costs.md) | Fail closed when Postgres is gone, and never cache an `unavailable` deny |
| [ADR-0003](docs/decisions/0003-postgres-is-the-only-truth.md) | No read model, so no projection lag. Includes the ordering bug the removed design had to work around |
| [ADR-0004](docs/decisions/0004-every-answer-says-where-it-came-from.md) | Every answer carries its source and generation, on every response, not behind a flag |
| [ADR-0005](docs/decisions/0005-the-graph-store-had-to-earn-it.md) | **Superseded.** Neo4j removed on a benchmark that measured one question and got the query direction wrong. Kept intact |
| [ADR-0006](docs/decisions/0006-no-negative-permissions-in-v1.md) | No `deny` rules in v1. Writing down what was left out and why |
| [ADR-0007](docs/decisions/0007-two-knowledge-graphs-measured-properly.md) | Four questions, two knowledge graphs, and the three errors that made the first answer wrong |

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

### The questions a boolean cannot answer

```bash
# why — every path, not the first one. ada reaches this two ways.
curl -H 'x-user-id: ada' 'localhost:3901/explain?permission=read&resource=repo-core-secrets'
  → paths: 2   via platform/owner, and via engineering/editor on the parent

# who — the traversal runs backwards
curl 'localhost:3901/reachable?permission=read&resource=repo-core-secrets'
  → ada (2 paths), grace (1), linus (1)

# impact — what a revoke would actually take away, before doing it
curl 'localhost:3901/impact/engineering/editor/repo-core?permission=write'
  → ada loses repo-core; grace loses repo-core and repo-core-secrets
  → ada keeps repo-core-secrets, because platform owns it outright
```

That last exclusion is why `/impact` is a subtraction and not a listing, and it
is the single most common surprise when someone tries to take access away.

## Tests

```bash
pnpm install
pnpm test                    # 13 unit tests, no Docker, no stores

pnpm run infra:up            # Postgres, Neo4j, Redis, Redpanda
pnpm build
pnpm run bootstrap           # schema + seed
pnpm run test:integration    # 28 tests against the real stores
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
entry outlives the grant row, that a node which never receives the event still
converges via the backstop, and that the two graph implementations agree on
every inheritance rule.

Each suite builds its own org and tears it down. They used to assert against the
demo seed, which meant clicking "revoke" in the UI broke the suite — with a bare
`expected false to be true` pointing nowhere near the cause, and CI never seeing
it because CI gets a fresh database.

## Deliberately not here

Kubernetes. Multi-tenancy. Internationalisation. Login. A configurable rule
engine — the role lattice is code, so "who can read this" has an answer you can
read off the source. Negative permissions, for the reasons in
[ADR-0006](docs/decisions/0006-no-negative-permissions-in-v1.md).

Per-resource-subtree invalidation is the obvious next step and is **not** claimed
as done: today one grant change cold-starts the whole decision cache, which is
invisible at this scale and would not be at a high write rate.

## Built with Claude

Claude wrote most of this code. The architecture, the trade-offs in
`docs/decisions/`, and the choice of what to leave out are mine.

The part worth reading is where a proposal was rejected or a measurement was
wrong. ADR-0001 records the precise-eviction design that does not work, ADR-0002
the last-known-good fallback that turns an outage into an incident, and ADR-0005
and ADR-0007 together record a database that was built, deleted on a benchmark,
and reinstated when the benchmark turned out to be measuring one question with
the query written backwards.

ADR-0005 is left intact rather than edited. A decision record that quietly
rewrites itself is worth less than one that shows what it got wrong.

## Licence

MIT.
