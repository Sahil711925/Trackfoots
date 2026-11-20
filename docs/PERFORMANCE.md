# Performance and cost

Every number below came out of `node scripts/bench.js` on the laptop this repo was built on.
Nothing here is a projection from a spec sheet, and nothing was run against a chain.

**Short answers.** Ingest sustains **~88,000 events/second** in one Node process; a 100-event
batch gets its Merkle root in **0.57 ms**; the whole 50,000-entry log re-verifies in **204 ms**;
anchoring costs **~$2.30 per 100,000 events** at 100-event epochs on an L2 — which is the same
figure the published prior art reports, because the chain's gas price, not our code, sets it.

## Measured

Machine: Intel i5-1135G7 (4 cores / 8 threads, 2.4 GHz mobile part), 7.8 GB RAM, Windows 11,
Node v26.7.0. Single process, default flags.

Command, from the repo root:

```
node scripts/bench.js          # or: node scripts/bench.js --json
```

Each measurement runs 3 times inside the process and reports the median; the whole benchmark
takes ~3.2 s. That whole run was repeated **5 times back to back**, and the table shows the
median of the five per-run medians. The bracket is the range **over every run I made on this
machine** (12 full runs, including a few while other work was going on) — a laptop is not a quiet
machine, so that spread is part of the answer.

| What | Median | Range observed |
|---|---|---|
| Ingest, 1,000 entries | **65,668 entries/s** (15.2 ms) | 50,700 – 74,800 /s |
| Ingest, 10,000 entries | **86,620 entries/s** (115.5 ms) | 71,000 – 100,200 /s |
| Ingest, 50,000 entries | **88,718 entries/s** (563.6 ms) | 84,650 – 99,700 /s |
| Chain re-verify, 50,000 entries | **204.1 ms** (4.08 µs/entry) | 165 – 268 ms |
| Merkle root, 100 leaves | **0.57 ms** (5.7 µs/leaf) | 0.51 – 2.07 ms |
| Merkle root, 10,000 leaves | **43.7 ms** (4.4 µs/leaf) | 41.6 – 114 ms |
| Gas per anchor (static estimate) | **73,905 gas** | — |
| Anchoring, 100K events @ 100-event epochs | **$2.30** | — |

Reproduced on one machine on 2026-11-20. If you re-run it and get 70,000 instead of 88,000 — or
99,000, which I also saw — that is the normal behaviour of this class of measurement on a laptop,
not a regression.

## Method — what is actually inside those numbers

The benchmark writes to a fresh throwaway directory (`WITNESS_DATA` → a temp dir), with
`WITNESS_TEST=1` and `ANCHOR_ON_CHAIN=false` set before any `lib/` module is required. It opens
no socket, starts no server, dials no node, and deletes the directory when it finishes.

An "entry" is a realistic incident-log line — `ts`, `actor`, `action`, `meta{ip, path, status}` —
which serialises to **386 bytes on disk**. Per entry, **ingest** includes: `contentDigest`
(1 SHA-256), `entryDigest` over `prevHash | seq | ts | actor | action | meta` (1 more SHA-256 with
a string join and a `JSON.stringify`), building both JSON lines, and one `appendFileSync` to the
log plus one to the auditor receipts directory. That is the real write path, not a hashing microbenchmark.

**Chain re-verify** is the auditor's walk exactly as `lib/verify.js` does it: read the file, `JSON.parse`
every line, re-derive `entryDigest(entry, prevHash)` and compare. It reported `chain_ok: true` on all reads.

**Merkle root** is `lib/merkle.js` `merkleRoot()` — RFC 6962, `SHA256(0x00 ‖ leaf)` and
`SHA256(0x01 ‖ l ‖ r)` — over 100 and 10,000 pre-generated 32-byte leaf digests.

**Excluded, deliberately:** the HTTP layer (no Express, no TLS, no auth middleware — the server adds
that), `fsync` (see the durability caveat), the per-batch root inside ingest, chain RPC latency, and
the anchoring transaction's own confirmation time.

## Reading the ingest curve

1,000 entries is slower per entry (15.2 µs) than 50,000 (11.3 µs) because a fixed cost — `mkdirSync`,
file opens, the first write to a cold directory — is amortised over fewer entries. The steady-state
figure is **~11.3 µs/entry**, and it is flat from 10k to 50k, which is what you want: no cliff.

Two costs hide inside that 11.3 µs, and they matter at scale:

- **Disk.** 386 B/entry at 88.7k events/s is **32.7 MB/s** of sustained append. Trivial on NVMe,
  a problem on a network filesystem or spinning disk.
- **A second hash chain**: `appendMany` keeps the whole batch in memory as strings (50k entries ≈ 20 MB).
  Writing 1M events in a single call would need ~400 MB of transient memory. Chunk at 10k and it is fine.

## The batch root is a third of your budget

A 100-event batch takes 1.127 ms to ingest and another **0.57 ms** to root, so the pipeline —
ingest plus root, the actual unit of work before an anchor — costs **1.70 ms per 100 events,
≈ 59,000 events/s**. The root is ~34% of that. Enlarging the batch does not buy throughput back
(a 1,000-leaf root costs ~5.7 ms against 11.3 ms of ingest for the same 1,000 events), because the
tree cost is linear in leaves. Batch size is an **anchoring-cost** dial, not a throughput dial:

| Epoch size | Anchors per 100K events | Cost per 100K events | Cost per event |
|---|---|---|---|
| 100 events | 1,000 | **$2.30** | $0.000023 |
| 1,000 events | 100 | **$0.23** | $0.0000023 |
| 10,000 events | 10 | **$0.023** | $0.00000023 |

The trade is latency: a longer epoch means a longer window in which the newest entries are chained
but not yet anchored — the race the README already discloses.

## What anchoring costs, and why it is not our number

`contracts/LogAnchor.sol`'s `anchor(seq, root, org)` writes three storage slots and emits one event.
The estimate below is a **derivation from the contract source plus the EIP-2929 cold-SSTORE schedule**,
not a measurement — measuring it would mean dialling a chain, which this benchmark deliberately never does.

| Component | Gas |
|---|---|
| Transaction base | 21,000 |
| Calldata (selector + 3 words + `org`) | ~1,300 |
| `roots[seq] = root` — zero → nonzero, cold | 22,100 |
| `publishedAt[seq] = block.timestamp` — zero → nonzero, cold | 22,100 |
| `count += 1` — nonzero → nonzero, cold | 5,000 |
| `emit Anchored` — LOG2, 160 bytes of data | ~2,030 |
| **Total per anchor** | **≈ 73,905** |

Now the honest part. arXiv **2609.01931** reports anchoring 100,000 events on an L2 for **$2.30** at
100-event epochs — i.e. 1,000 anchors, **$0.0023 each**. Working backwards at ETH ≈ $3,000, that
implies a gas price of about **0.0104 gwei**. Price *our* 73,905 gas at that same rate and you get
**$2.30 per 100K events** — we land on their number, not below it. We are not claiming to be cheaper
than the prior art; both designs write one 32-byte root per epoch, so both pay one cold SSTORE pair
per epoch. The difference between a cheap deployment and an expensive one is the chain and the epoch
size, not the contract.

Sensitivity, per 100K events at 100-event epochs (1,000 anchors), ETH $3,000:

| Gas price | Network class | Per anchor | Per 100K events | Per event |
|---|---|---|---|---|
| 0.001 gwei | cheap L2 | $0.00022 | $0.22 | $0.0000022 |
| 0.005 gwei | L2, typical | $0.0011 | $1.11 | $0.000011 |
| 0.01 gwei | L2, implied by the paper | $0.0022 | $2.22 | $0.000022 |
| 0.05 gwei | busy L2 | $0.011 | $11.09 | $0.00011 |
| 1 gwei | L2 congestion event | $0.22 | $221.72 | $0.0022 |
| 20 gwei | Ethereum L1 | $4.43 | **$4,434** | $0.044 |

That last row is the whole argument for an L2: the same contract, the same 73,905 gas, is ~2,000×
dearer on L1. Cost is a function of where you anchor, which is exactly why the chain is configurable.

## Verify scaling, including the part that does not scale

The **chain walk** is linear and single-pass: 4.08 µs/entry, so 1M entries re-verify in ~4 s and
100M in ~7 minutes on one core. That is the number to quote for "can an auditor check this".

The **full auditor run** — `lib/verify.js`, which also recomputes each batch's cumulative checkpoint
root — is not linear, and this is worth knowing before someone points it at a year of logs. Measured
on the same machine:

| Entries | Batches (100/epoch) | `verify()` |
|---|---|---|
| 1,000 | 10 | 60 ms |
| 2,000 | 20 | 124 ms |
| 4,000 | 40 | 382 ms |
| 10,000 | 100 | 2.55 s |
| 20,000 | 200 | 7.75 s |

It grows with **batches × entries**, because the checkpoint pass rebuilds the prefix root for every
published batch. Extrapolating the measured curve, 50,000 entries is on the order of a minute. The fix
is straightforward and not yet implemented: the checkpoint roots are already published and immutable,
so verification should recompute only the newest prefix instead of all of them. Until then, quote the
4.08 µs/entry chain-walk figure and treat the full `verify()` as an auditor-side batch job.

## These numbers are from a laptop, not a server

Read the table as an order of magnitude, not a service-level commitment. Specifically:

- **Mobile CPU.** An i5-1135G7 at 2.4 GHz thermally throttles; a recent server core is roughly 1.5–2.5×
  faster per core at the same work. Expect higher, not lower, on real hardware — but that is an
  expectation, and I did not measure it.
- **One core.** Everything here is one thread. SHA-256 is embarrassingly parallel and the log is
  shardable, so worker threads or multiple processes should scale close to core count. Untested,
  so unclaimed.
- **No `fsync`.** `appendFileSync` puts bytes in the OS page cache. These numbers therefore describe
  durability against a *process* crash, not a *power* loss. Adding an `fsync` per batch is a few
  milliseconds on NVMe and much worse on spinning or network storage; that is the honest cost of
  hardening the write path and it is not in any number above.
- **Windows filesystem timings.** Appends on Linux ext4/XFS are usually comparable or faster; the
  benchmark does not tune for either.
- **Anchoring is not measured at all.** Gas is derived from the source. The dollar figures inherit a
  gas price inferred from a paper's published total, at an assumed ETH price of $3,000. Both assumptions
  are printed in the output so a reader can re-price them.
- **Small batches dominate the root cost at high rates.** At 59k events/s sustained, one core is
  saturated by ingest plus roots. Nothing here was tested above ~100k events/s.

## The audit rewrite (checkpoint roots, before vs after)

The first version re-derived every checkpoint's cumulative root from scratch, so an audit was
O(batches × entries). At 1,200 entries nobody notices; at 50,000 it took **107 seconds**.

`createMerkleAccumulator()` in `lib/merkle.js` keeps the RFC 6962 frontier instead, so each checkpoint costs
O(log n) to report. Measured by `npm run bench` over identical leaves:

| entries | checkpoints | before | after | speedup | roots |
|---|---|---|---|---|---|
| 1,000 | 10 | 32 ms | 4 ms | 7.6× | identical |
| 10,000 | 100 | 4,331 ms | 56 ms | 77× | identical |
| 20,000 | 200 | 17,294 ms | 197 ms | 88× | identical |
| 50,000 | 500 | 107,506 ms | 438 ms | **246×** | identical |

Full `verify()` on 50,000 anchored entries: **2.2 s** (44 µs/entry), verdict VERIFIED.

The only reason this was safe to ship: the incremental root is **byte-identical** to the naive one.
`tests/merkle-incremental.test.js` checks 600 prefix sizes and 27 tree-shape boundaries against
`merkleRoot()`, and the 12 live checkpoints were re-derived both ways before and after the change.
A left-fold accumulator agrees with the naive version for k ≤ 6 and diverges at k = 7 — which would have
silently broken every on-chain comparison while passing every small-batch test. That case is now pinned.

## Answering the question out loud

- *"How many events per second?"* — **~88,000/s** ingesting on one laptop core, **~59,000/s** sustained
  including a Merkle root per 100-event batch, and **1M events re-verified in ~4 seconds**.
- *"What does it cost?"* — **$0.0023 per anchor**, i.e. **$2.30 per 100,000 events** at 100-event
  epochs on an L2, **$23 per million**. Loosen the epoch to 1,000 events and it drops to $0.23 per
  100K. The ceiling is the chain's gas price, not this codebase.
