# Architecture

## Data model

```
data/
├── logs.jsonl              the diary — one JSON object per line, hash-chained
├── ledger.jsonl            one record per published batch: {batch, seq, fromSeq, toSeq, root, txHash, chain}
├── auditor/
│   └── receipts.jsonl      content fingerprint per entry, held "outside" the server
└── run.json                per-run sequence namespace so resets never collide on-chain
```

### One entry

```json
{
  "ts": "2026-11-20T11:43:34.627Z",
  "actor": "priya",
  "action": "cat /etc/passwd",
  "meta": { "ip": "103.181.182.148", "session": 17843 },
  "seq": 250,
  "prevHash": "cb08864f…",
  "chash": "…",             // sha256(ts|actor|action|meta)  — identity, independent of position
  "hash": "706a1257…"       // sha256(prevHash|seq|ts|actor|action|meta) — the chain link
}
```

Two digests, on purpose:

- `hash` binds the entry to its position in the chain, so an edit invalidates everything downstream.
- `chash` binds the entry to its *content*, so a receipt still identifies the line after an attacker renumbers
  everything following a deletion.

## Write path

1. `POST /log` (or `store.appendLog`) computes `chash`, then `hash`, then appends.
2. A receipt `{seq, chash, ts}` goes to the auditor store — a different directory, standing in for a different
   trust domain.
3. When 100 entries exist, `anchorAll()` computes the Merkle root and submits one transaction.

## Anchor path

```
root = merkleRoot(entries[batch].map(e => e.hash))
tx   = LogAnchor.anchor(chainSeq, root, org)      // reverts if chainSeq already written
ledger.append({batch, seq: chainSeq, fromSeq, toSeq, root, txHash, chain})
```

`chainSeq = runBase + batch`, where `runBase = Date.now()` at first anchor of a run. The contract is write-once,
so a reset must not reuse a sequence number — that is why the namespace exists.

## Verify path (three independent checks)

| # | Check | Catches | Cost |
|---|---|---|---|
| 1 | Recompute every `hash` from `prevHash` + content | naive attacker (deleted / edited, hashes untouched) | O(n) |
| 2 | Recompute each batch's Merkle root, compare to the published root | careful attacker who rebuilt every hash | O(n) + O(log b) to locate |
| 3 | Every receipt's `chash` must still exist somewhere on disk | deletions — and lets us name what was lost | O(n) |

Additional reports: `alteredEntries` (content that no longer matches its own stored `chash`) and
`unwitnessedEntries` (content the auditor never issued a receipt for).

### Why the search is conditional

Damage normally propagates forward: if entry 250 changes, every later hash changes. So when the **last** batch is
bad, "is this batch bad" is monotone (false…false,true…true) and the first bad batch can be found by binary search
in O(log b).

An attacker who edits one early batch and stops breaks monotonicity. The auditor therefore tests the assumption —
if the last batch is clean it falls back to a linear scan. `report.rootCheckMethod` records which path ran, so the
report never claims a guarantee it did not use.

## Threat model

| Adversary | Capability | Result |
|---|---|---|
| Lazy attacker | deletes lines, leaves hashes | chain check fails at the edited entry |
| Careful forger | deletes, renumbers, recomputes every hash | file is internally perfect; root check fails, batch named |
| Forger + receipt deletion | also deletes `data/auditor/` | tampering still proven by root mismatch; deleted *content* not recoverable |
| Anchor blocker | blocks outbound traffic | history intact, new entries unwitnessed — gap in `seq` (alarm pending) |
| Key thief | steals the anchor private key | can publish new roots; **cannot** alter published ones |
| Chain-colluding operator | deploys a fresh contract | new contract starts empty; the old published history still stands |

## Why not a database

A database row can be updated by whoever holds credentials — including the attacker. The chain's value is not
"immutability" in the abstract; it is that *the record exists outside the blast radius*, so verification does not
depend on trusting the party under investigation.

## Failure modes we know about

- Anchor interval leaves a tail of unwitnessed entries (documented, not fixed).
- Receipts are a directory, not a separate host.
- No automated liveness alert when anchoring stops.
- The demo chain is local; the contract is chain-agnostic.
