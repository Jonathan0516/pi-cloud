# @earendil-works/pi-session-backend-postgres

PostgreSQL Session backend for `@earendil-works/pi-agent-core`.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  applyInitialSchema,
  createPostgresClient,
  createSchemaIfMissing,
  PostgresSessionRepo,
} from "@earendil-works/pi-session-backend-postgres";

const sql = createPostgresClient({ url: process.env.PI_PG_URL!, schema: "pi_sessions" });
await createSchemaIfMissing(sql, "pi_sessions");
await applyInitialSchema(sql);

const repository = new PostgresSessionRepo({ sql });
const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
await main.appendMessage(
  { role: "user", content: "hello", timestamp: Date.now() },
  BACKGROUND_CONTEXT,
);
await session.close(BACKGROUND_CONTEXT);
await repository.close(BACKGROUND_CONTEXT);
await sql.end();
```

One schema is a Session container: any number of Sessions share its tables and every durable row is scoped by `session_id`. `createPostgresClient` places the schema alone on `search_path`, so the backend's unqualified table names resolve there; pass a dedicated schema rather than `public` when the database hosts other tables. The client is caller-owned. Closing the repository closes its open Sessions but leaves the client for the caller to `end()`.

Each commit runs in one transaction that locks the Session row, validates ids and parents against existing rows, writes entries, values, lists, and ledger rows in write order, and advances the sequence and stats projection together. Commits from one repository are additionally serialized in-process. JSON payloads use the `json` type so every value round-trips exactly, including strings with U+0000; range-scanned keys use `COLLATE "C"` so prefix scans order by code point like the other backends.

Pass `lease` to make ownership durable across processes:

```ts
const repository = new PostgresSessionRepo({
  sql,
  lease: {
    owner: { node: hostname(), addr: "10.0.0.5:7000", proc: `${process.pid}:${bootId}` },
    ttlSeconds: 30,
    heartbeatIntervalMs: 5000,
    onFenced: (sessionId, error) => process.exit(75),
  },
});
```

Opening a Session acquires its row in `session_leases` with one `INSERT ... ON CONFLICT DO UPDATE ... WHERE state = 'free' OR expires_at < now()`: exactly one acquirer wins, and the loser gets a `SessionLeaseHeldError` naming the live holder's `owner.addr` so a router can forward to it. A holder that released hands over immediately (`lease.predecessor === "released"`); one that went silent hands over after the TTL (`"expired"`), and the new owner should fence that holder's side effects, for example by killing its sandbox. Every commit runs the fence as the first statement of its own transaction: `UPDATE session_leases ... WHERE session_id = $1 AND epoch = $2`. A zero row count means another process owns the Session now; the commit rolls back with a `FencedError`, the storage rejects every later commit without touching the database, and `onFenced` fires so the host can exit. A connection failure is a different error and is retryable. Commits renew the lease, so only idle Sessions depend on the batched heartbeat, which renews every held lease in one statement and fences the ones missing from the result. Expiry compares database `now()` only; node clocks never enter it. A supervisor that watched a worker die can call `expireSessionLease` with the dead worker's epoch: the lease becomes takeable immediately while the taker still sees an `"expired"` predecessor and fences the dead worker's side effects.

Without `lease`, the repository rejects overlapping local create/open/fork/delete for one id but implements no cross-process lease, fence, heartbeat, or takeover, and the host lifecycle guarantees one writable owner. A fork of a source open in the same repository queues its snapshot on that source's commit queue; any other source is read in one `REPEATABLE READ` read-only transaction, which needs no lease.

Tests require a disposable database in `PI_TEST_PG_URL`; each case creates and drops its own schema. Without the variable the PostgreSQL suites are skipped.
