# TRACKFOOTS — build checklist

Status: **feature-complete for B3.** Everything marked ✅ was verified by running it, not by reading the code.

---

## Core (the product)

- [x] Hash chain over log entries — any edit breaks every hash after it
- [x] RFC 6962 Merkle tree: domain-separated leaves/nodes, inclusion proofs, consistency proofs
- [x] Cumulative checkpoint roots (not per-batch trees) — required for append-only proofs
- [x] `LogAnchor.sol` deployed on a local EVM, write-once `anchor(seq, root, org)`
- [x] 12/12 batches anchored · `verify-chain.js` → **12 match, 0 differ**
- [x] Naive attacker caught (deletes lines, leaves hashes)
- [x] Careful attacker caught (deletes 34, recomputes every hash) — chain reports *intact*, published root catches him
- [x] Batch and sequence range identified (batch 3, entries 201–300)
- [x] Web UI: green verified / red tampered / amber degraded
- [x] `START_DEMO.bat`, `VERIFY_CHAIN.bat` — double-click cold start

## Product surface (what makes it deployable)

- [x] **Ingest API** — `POST /api/log`, `x-api-key`, 1,000 entries/request, 2 MB cap, per-index rejection
- [x] **Signed receipt returned at write time** — seq + content hash + HMAC, held by the emitter
- [x] `GET /api/stats` — entries, batches, **unanchored backlog** (the anchor window, exposed)
- [x] **Real log parsers** — OpenSSH auth.log, nginx combined, RFC 3164 syslog; junk refused, not mangled
- [x] Demo seeds from real sample lines by default (falls back to synthetic if `samples/` is gone)
- [x] **Alerts** — raised on tamper, shown under the banner, POST to `ALERT_WEBHOOK`, one-per-minute guard
- [x] **CERT-In 6-hour incident report** — `npm run incident` / `/incident`, built from verifier output
- [x] Retention: 180-day policy, prune **refuses** to delete anything inside a published batch
- [x] Independent auditor view — bundle + chain only, never reads `data/`; tamper → refuses
- [x] Evidence bundle export (HTML exhibit + machine-checkable JSON)
- [x] **Receipt-set commitment** — Merkle root over receipts; truncated set fails (`1199 present, 1200 committed`, exit 2)
- [x] Liveness check — stale anchoring exits non-zero
- [x] **Shipper** — `npm run shipper --file … --follow`: resume offsets, rotation, retries, batch receipts
- [x] **Multi-tenant** — `npm run tenants up`: one process, data dir, key and root namespace per company
- [x] **Search + pagination** — free text, actor filters, `1–50 of 146`, survives refresh
- [x] **Public status page** — `/status`, no login, says UNREACHABLE rather than lying

## Engineering

- [x] **174 tests, 174 pass, 0 fail** across 18 test files
- [x] Audit is **O(n log n)** — incremental RFC 6962 accumulator; 50k entries in 2.2 s (was 107 s), roots byte-identical
- [x] Benchmark: 88,700 entries/s ingest · $2.30 per 100K events at 100-event epochs
- [x] Zero runtime dependencies beyond `ethers`/`solc` (hash chain and Merkle are ours)

## Docs

- [x] README — architecture, threat model, honest limitations, performance
- [x] `docs/DEMO.md` — 2:30 script with the new beats (live line, alert, incident report)
- [x] `docs/JUDGE-QA.md` — 12 answers, including the ones that hurt
- [x] `docs/PERFORMANCE.md`, `docs/PRIOR-ART.md`, `docs/ARCHITECTURE.md`
- [x] `docs/AMOY-ATTEMPT.md` — the failed testnet attempt, with literal errors
- [x] Submission PDF regenerated from `submission.html`

## Repo

- [x] Pushed to `github.com/Sahil711925/Trackfoots`
- [x] Sample log fixtures tracked (`.gitignore` exception for `samples/*.log`)
- [x] 88 files, ~12,300 lines

---

## Open — and disclosed everywhere it matters

- [ ] **Polygon Amoy deployment** — blocked: deployer holds 0 POL, every faucet needs captcha/mainnet/social.
      Evidence in `docs/AMOY-ATTEMPT.md`. Demo runs a local EVM.
- [ ] **Receipt store is local**, not a second host. Signed and committed, but co-located.
- [ ] **Single node** — no replication, no fsync, no HA.

## Yours, not the code's

- [ ] Rehearse the 2:30 out loud, three clean passes
- [ ] Read `exports/incident-*.html` once — it's the artifact a judge will hold
- [ ] Sleep
