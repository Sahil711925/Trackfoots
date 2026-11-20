# Public status page (`/status`)

A login-free page for customers, auditors and regulators: it reads only public read-only
endpoints, needs no credentials, and is a single self-contained file
(`public/status.html` — inline CSS + vanilla JS, no CDN, no build step).

`server.js` serves it at **`/status`** and **`/status.html`** with `cache-control: no-store`.

## What it shows

| Block | Source | Notes |
|---|---|---|
| Verdict (VERIFIED / TAMPERED / UNREACHABLE) | `report.verdict` | Anything other than `VERIFIED` renders as **TAMPERED** in red, with the raw verdict in parentheses. A failed fetch renders **UNREACHABLE** — never green. |
| Entry / batch counts | `report.entriesOnDisk`, `report.batchesPublished` | Secondary signals (`chainOk`, `badBatches`, `corruptLines`, invalid receipts, `consistency.ok`, `chain.degraded`) are surfaced as caveats but can never *upgrade* the verdict. |
| Latest published root | `ledger[0].root`, `.checkpointRoot`, `.batch`, `.fromSeq`, `.toSeq`, `.txHash` | Explorer links are emitted only for networks with a known explorer (`amoy` → amoy.polygonscan.com, `polygon`/`mainnet` → polygonscan.com). `local` is labelled **local EVM (demo)** with no link. Unknown networks get no invented URL. |
| Batches table | `ledger` (newest first, as the API returns it) | `#`, sequence range, first 16 chars of the root, on-chain vs local, UTC timestamp. |
| Check an entry | `ledger` ranges only | Reports which published batch covers a sequence number, or that it is in the unanchored tail. It deliberately does **not** reveal log contents and does **not** compute proofs; it links to `/auditor` for those. |

## Contract address

`/api/state`'s `chain` object on this build exposes `network`, `onChain`, `total`, `degraded`
— **no `address` field**. The page therefore:

1. uses `chain.address` if the API ever starts returning it;
2. otherwise reads the address from the existing public `/api/incident-report` page
   (the only public surface that publishes it — a single `0x…{40}` match), still read-only;
3. otherwise prints `not published by this deployment`.

No endpoint was added or invented for this.

## Refresh behaviour

- Fetches `/api/state` on load, then every 10 s (`next in Ns` in the footer).
- Pauses while the tab is hidden and refreshes immediately when it becomes visible again.
- On failure, every value that could read as a live claim is cleared to `unavailable` and the
  error text (`HTTP 503 …`, `network error: …`) is shown verbatim in the error box.

## Layout

Single column at ≤700px: the key/value grid stacks (labels above values) and the batches table
becomes label/value rows, so nothing scrolls horizontally.

## Manual check

```bash
# dedicated instance, own data dir, no chain writes — never the demo on :5173
PORT=5198 WITNESS_DATA=/tmp/witness-status CHAIN=local ANCHOR_ON_CHAIN=false node server.js
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5198/status   # expect 200
```

`server.js` routes are `GET`-only, so `curl -I` (HEAD) returns 404 even when the page is live —
probe with GET, or a 200 check will read as an outage.

To exercise the failure path end-to-end, serve the same file from any throwaway static server
that answers `/api/state` with a 5xx: the page must show UNREACHABLE in red.
