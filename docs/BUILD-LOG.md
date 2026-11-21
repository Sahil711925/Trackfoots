# Build log

**Event:** The Big Hack 2.0 · AIT Bengaluru · 20–21 November 2026
**Problem:** Track 02 (Cybersecurity & Blockchain) · **B3 — logs the attacker can't erase**
**Window:** hacking opened 13:00, 20 Nov. First commit 17:19, last 14:19 the next day.
**Repo:** github.com/Sahil711925/Trackfoots · **Final:** 183 tests, 120 tracked files, tag `v1.0.0`

Everything below is from `git log`, not from memory. Commit hashes are real and resolvable.

---

## Phases

| Phase | Time | What landed | First commit |
|---|---|---|---|
| **0. Problem selection** | 13:00–17:15 | Read all nine problem statements, verified their claims online, chose B3 over B1 (duplicates shipped products) and B2 (crowded, and the chain is decorative) | — |
| **1. Working core** | 17:19–18:03 | Hash chain, Merkle batching, `LogAnchor.sol`, deploy + anchor scripts, attacker simulator, dashboard | `3b13c74` |
| **2. Proof, not just detection** | 18:03–19:36 | Inclusion proofs, evidence bundle export, prior-art research, UI honesty fix (`on-chain` vs `local only`) | `bd6f578` |
| **3. Standards compliance** | 20:40 | RFC 6962 rewrite: domain-separated leaves/nodes, correct proof paths, consistency proofs | `fd55d1f` |
| **4. Tier 1 — product surface** | 20:50–20:56 | Signed receipts, independent auditor, retention policy, real log parsers, benchmark | `bdeb6c5` |
| **5. Ingest + operations** | 21:09–21:33 | Real-log seeding, ingest API with API key and write-time receipt, alerting, CERT-In 6-hour report | `901f487` → `eba02cf` |
| **6. Performance** | 22:02 | Incremental RFC 6962 accumulator: audit 107 s → 2.2 s at 50k entries, roots byte-identical | `88fd0c9` |
| **7. Tier 2 — adoption** | 22:35 | Shipper, multi-tenant process isolation, searchable log, public status page | `fdca7eb` |
| **8. Presentation** | 23:08–00:31 | Marketing page at `/`, dashboard moved to `/app`, generated SVG artwork, dark redesign with real automations | `9db057b` → `6e3d2de` |
| **9. Hardening + Quai** | 00:15–02:35 | Empty store no longer verifies, annotated five-stage flowchart, Quai address derivation + `quais` SDK + 0.8.20 compile | `663cbfc`, `c8a423b` |
| **10. Judge prep + polish** | 01:28–14:19 | Cue cards, timed scripts, real-world Q&A, repo badges, SECURITY.md, CI tracked, 3-minute Round-3 script | `df088f8` → `94c902c` |

---

## Decisions that changed the design

1. **The chain stores a cumulative checkpoint root, not a per-batch root.** Per-batch roots are
   independent trees; you cannot prove one extends the other. Switching to cumulative roots is what
   makes the append-only claim provable (`11/11` checkpoint pairs).
2. **Two digests per entry.** `entryDigest` includes `prevHash` for chaining; `contentDigest` excludes
   position for receipts. An attacker who renumbers would otherwise make 1,000 honest receipts look
   missing.
3. **A per-run sequence namespace on the contract.** The contract refuses to overwrite a sequence, so
   a demo reset must anchor into a fresh slot. "That's not a bug, that's the product."
4. **An empty store is `NO DATA`, never `VERIFIED`.** Deleting the data directory used to pass every
   local check — the cleanest attack available.
5. **Multi-tenancy by process, not by row.** Separate data dir, key and sequence namespace per tenant;
   a shared-rows design would put one company's evidence inside another's Merkle tree.
6. **Saffron for brand, green/red only for state.** A saffron tick on a failed verification would be a
   lie in colour.

---

## Bugs found and fixed (all reproduced first)

| Bug | How it showed up | Fix |
|---|---|---|
| Reset raced itself | Two `/api/reset` calls interleaved; ledger pointed at batches whose entries were gone | `withLock` → HTTP 409 |
| Contract reverted on demo reset | `AlreadyAnchored(seq)` on the second run | per-run `runBase()` sequence namespace |
| Reset took 18 s | Ethers polling + 1,200 individual appends | static network + `appendMany()` → 1.8 s |
| Root check gated on the last batch | Tampering confined to batch 3 reported `badBatches: 0` | binary search only when the last batch is bad, else linear scan |
| Subagent env leak | Server wrote to a temp dir with anchoring off, and still showed green | `.env` wins over inherited env; amber `CHAIN DEGRADED` banner |
| Suite hung 2 runs in 3 | No failing assertion, just a hang | `WITNESS_TEST` guard; 57/57 twice |
| Merkle proof wrong for non-powers-of-two | `proof.js` threw `rootFromProof is not a function` | RFC 6962 `PATH(m, D[n])` rewrite with `{hash, side}` |
| Empty data dir verified as clean | `verdict: VERIFIED, entries: 0` | `noData` → `NO DATA`; receipts surviving a wipe escalate to `TAMPERED` |
| Sample logs 404'd on GitHub | `.gitignore` had `*.log` | `!samples/*.log` exception |
| CI never reached GitHub | `.git/info/exclude` contained `.github/` | rule removed; workflow committed |
| Test count drifted across docs | README said 61 while the suite said 183 | single source: `npm test` output |

---

## Test count over time

```
55  → 57 → 90 → 107 → 129 → 174 → 178 → 183
```

Each jump is a new area of behaviour: formats, retention, alerts, receipt-set commitment, ingest,
incremental Merkle equivalence, Quai port.

---

## What was deliberately not built

| Not built | Why |
|---|---|
| Public-testnet deployment | Amoy faucets want a captcha or a mainnet balance; Quai's documented faucet host no longer resolves (NXDOMAIN, verified). Both attempts are documented with literal errors. |
| Receipts on a second host | Time. The key is outside `data/`, in `.env`; production would use a KMS. |
| Replication / fsync / HA | Availability, not integrity. Stated in `docs/PERFORMANCE.md`. |
| Multi-signer anchoring | A stolen anchor key can publish false roots going forward. Disclosed, not hidden. |

---

## Verification a judge can run in two minutes

```bash
npm test                 # 183 passing, 20 files, fully offline
npm run verify:chain     # 12 match, 0 differ
npm run incident         # writes exports/incident-<id>.html
npm run quai:check       # compiles for Quai 0.8.20, prices the deploy, spends nothing
```
