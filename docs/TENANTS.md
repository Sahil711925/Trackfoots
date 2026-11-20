# Multi-tenancy

One Trackfoots deployment can serve several companies. The unit of isolation is the **process**:

```
tenants.json                      the registry (source of truth)
data/tenants/acme/                acme's own log, ledger, receipts, run namespace
data/tenants/acme.log             acme's server stdout/stderr
data/tenants/fintech/             fintech's own log, ledger, receipts, run namespace
data/tenants/fintech.log          fintech's server stdout/stderr
data/tenants/pids.json            what `up` started, so `down` can stop exactly that
```

Each tenant is a separate `node server.js` child with its own `PORT`, `WITNESS_DATA`,
`INGEST_KEY` and `ORG`. Nothing is shared: not the log file, not the ledger, not the auditor
receipts, not `run.json` (the chain sequence namespace), not the ingest key.

## Why isolation by process

The alternative is row-level tenancy — one log file with a `tenant` column and every read
filtered by it. This codebase is a hash chain with a Merkle ledger and receipts held in a
separate trust domain; one missed filter would serve company A's entries, and worse, company A's
*published root*, to company B. A separate process with a separate `WITNESS_DATA` cannot leak
what it never opens, and it required **zero changes** to `lib/store.js`, `lib/verify.js`,
`scripts/anchor.js` or `server.js`: `store.js` already resolves every path from `WITNESS_DATA` at
require time, and `server.js` already reads `PORT`, `INGEST_KEY` and `ORG` from the environment.

Costs, stated plainly:

- one Node process and one port per tenant (fine for tens of tenants, not thousands)
- no cross-tenant admin view; `status` queries each tenant's own `/api/stats`
- tenants share the same chain contract when anchoring on-chain; they stay distinct because each
  tenant's `run.json` gives it its own sequence block and its own `ORG` label

## Registry

`tenants.json` at the repo root:

```json
{
  "tenants": [
    {
      "name": "acme",
      "port": 5174,
      "org": "ACME Pvt Ltd",
      "dataDir": "data/tenants/acme",
      "keyEnv": "INGEST_KEY_ACME"
    },
    {
      "name": "fintech",
      "port": 5175,
      "org": "Fintech Co",
      "dataDir": "data/tenants/fintech",
      "keyEnv": "INGEST_KEY_FINTECH"
    }
  ]
}
```

| field     | rules                                                                                   |
| --------- | --------------------------------------------------------------------------------------- |
| `name`    | unique, `[a-z0-9][a-z0-9_-]*`; used for the data dir, log file and `TENANT` env var      |
| `port`    | unique integer 1024–65535; `5173` is reserved for the single-tenant server               |
| `org`     | optional label passed as `ORG`; on-chain anchors and the incident report use it          |
| `dataDir` | unique, **relative**, inside the repo, and never the base `data/` directory              |
| `keyEnv`  | unique env var name holding this tenant's ingest key (the key itself is never in git)    |

`lib/tenants.js` validates all of that (`validateRegistry`, pure, returns every error at once).
A data dir equal to `data/` is rejected on purpose: that is the single-tenant log, and sharing it
is the bug this design exists to prevent.

## Quickstart

```bash
export INGEST_KEY_ACME=tf_...acme
export INGEST_KEY_FINTECH=tf_...fintech

node scripts/tenants.js up          # start both, seed 250 entries each if empty, print the table
node scripts/tenants.js status      # entries / batches / unanchored per tenant
node scripts/tenants.js down        # stop everything in data/tenants/pids.json
```

`up` stays in the foreground on purpose: the children live under it, and `Ctrl+C` stops every
tenant (verified — pidfile removed, both ports released). It refuses to start if a pidfile still
points at a live tenant, or if a tenant port is already bound.

Other commands:

```bash
node scripts/tenants.js up acme                # one tenant only
node scripts/tenants.js up --seed=0            # start without seeding
node scripts/tenants.js up --no-anchor         # skip publishing roots at startup
node scripts/tenants.js seed fintech 500       # seed and anchor one tenant
```

Logs: `data/tenants/<name>.log` (stdout and stderr of that child). Ingest as that company:

```bash
curl -X POST http://127.0.0.1:5174/api/log \
  -H "x-api-key: $INGEST_KEY_ACME" -H "content-type: application/json" \
  -d '{"actor":"alice","action":"login success"}'
```

The same key against `:5175` returns `401` — keys do not cross tenants.

## The trap this launcher exists to avoid

`lib/env.js` keeps a `FORCE_FROM_FILE` set: `WITNESS_DATA`, `INGEST_KEY`, `ORG` and others are
re-read from `.env` even when the shell already set them. That was deliberate (a stray
environment variable once redirected the app to a temp dir). For a launcher it is fatal: every
child would land on `data/` and use the single-tenant `INGEST_KEY`, while both still answered
`/api/stats` normally.

`lib/env.js` documents one escape hatch: with `WITNESS_TEST=1`, explicit environment variables win
over the file. `buildChildEnv()` therefore sets `WITNESS_TEST=1`, and `up` proves the result
instead of assuming it:

```
  isolation
    acme      store.DATA = C:\...\witness\data\tenants\acme
              logs.jsonl 45756 B   ledger.jsonl 757 B   receipts.jsonl 25907 B
    fintech   store.DATA = C:\...\witness\data\tenants\fintech
              logs.jsonl 45746 B   ledger.jsonl 757 B   receipts.jsonl 25907 B
    distinct data dirs: yes
```

`store.DATA` is printed by spawning the child's **own** environment through
`require('./lib/store').DATA`, so a mismatch would show up as `MISMATCH` on that line. The
integration test asserts the same thing (`probeStoreData`), so the check cannot rot.

`buildChildEnv()` also strips every `INGEST_KEY*` variable inherited from the parent and then
sets the tenant's own as `INGEST_KEY` — a child never even sees its neighbour's key name.

## What the tests prove

`tests/tenants.test.js` keeps the contract honest without touching the shared `data/` directory:

- registry validation: duplicate names/ports/dataDirs/keyEnv, `dataDir` equal to `data/`,
  absolute or escaping paths, out-of-range and reserved ports
- `buildChildEnv`: per-tenant `PORT`/`WITNESS_DATA`/`INGEST_KEY`/`ORG`, `WITNESS_TEST=1`, no
  neighbour keys, hard failure when the key env var is missing
- integration: two real servers on ephemeral ports with two temp data dirs. A writes with A's key,
  B with B's key; both `/api/stats` report `1`; `GET /api/entries?q=<other marker>` returns `0`
  on each side; A's key is rejected by B with `401`; on disk each `logs.jsonl` contains only its
  own marker at `seq: 1`; both children are killed in teardown

Run just this slice with `node --test tests/tenants.test.js`, or the whole suite with
`node --test tests/*.test.js`.

## Operating notes

- Add a tenant: append to `tenants.json`, export its `keyEnv`, `up` again (existing tenants keep
  their data dirs and continue their chains).
- Reset one tenant without touching the others: `curl -X POST http://127.0.0.1:<port>/api/reset`.
  The blast radius is that tenant's directory.
- Anchoring is per tenant and best effort at startup: if the chain is unreachable, each tenant
  keeps its roots in its own `ledger.jsonl` instead of failing `up`.
- Every tenant inherits `CHAIN` / `RPC_URL` / `ANCHOR_ON_CHAIN` from `.env`; only the four
  per-tenant values are overridden. Ports 5174/5175 belong to the registry — the single-tenant
  demo stays on 5173.
