# WITNESS — build checklist

Status as of Fri 20 Nov, 17:20 · ~19h40m to submission.

## ✅ DONE (verified by running it)

- [x] Hash chain over log entries
- [x] Merkle tree + root per 100 entries + inclusion proof functions
- [x] `LogAnchor.sol` compiles (855 bytes, 5 functions: anchor, rootOf, timeOf, count, owner)
- [x] Contract deployed to a local EVM chain
- [x] Anchoring writes real transactions — 12/12 batches
- [x] `verify-chain.js` re-reads roots from the chain — 12 match, 0 differ
- [x] Naive attacker caught (chain broken at entry 202)
- [x] Careful attacker caught (chain intact, root mismatch) — the key demo
- [x] 34 deleted entries recovered from content-hash receipts
- [x] Web UI with green/verified and red/tampered states
- [x] Receipts panel showing recovered entries
- [x] `START_DEMO.bat` — cold start: chain → auto-deploy → server → browser (~10s)
- [x] `VERIFY_CHAIN.bat` — one double-click chain proof
- [x] Reset works repeatably (1.5–2s, fresh seq namespace per run)
- [x] README with threat model + honest limitations
- [x] DEMO.md with timed script and judge Q&A
- [x] Idea submission text prepared
- [x] Supporting PDF (`Documents/bighack/WITNESS_submission.pdf`, 84 KB)

## ⬜ NOT DONE — in execution order

- [x] **1. Idea form submitted** — done, form submitted with PDF attached
- [x] **2. Git repo + first commit** — done: commit `1f72c51`, 28 files tracked, no junk
- [ ] **3. Push to GitHub** (10 min) — needs your GitHub login
- [x] **4. "Every 60 seconds" was a lie** — fixed: claim removed from UI, README, DEMO.md and Q&A. Anchoring is now described accurately as per-completed-batch
- [ ] **5. Code walkthrough** (30 min) — you must be able to answer "how does this work?"
- [ ] **6. Inclusion-proof button** (45 min) — "prove entry 1544 existed", currently CLI-only
- [ ] **7. Court/auditor bundle export** (60 min) — PDF with tx hash + proof + verify steps
- [ ] **8. Backup demo video** (15 min) — laptop death insurance
- [ ] **9. Rehearse 2:30 ×3** (30 min) — the highest-value item on this list
- [ ] **10. Sleep 4 hours** before 07:00

## ⚠️ KNOWN WEAKNESSES (disclose, don't hide)

- Blockchain is a **local EVM chain**, not Polygon Amoy. Faucet needed a funded mainnet wallet.
- "Receipts on a different machine" is a **separate folder on the same laptop**. Simulation, not isolation.
- No anchor **liveness alarm** if an attacker blocks outbound traffic.
- No automated tests.
- All log data is synthetic (allowed by the track rule; declared in README).
- I wrote ~95% of the code. You must be able to explain it, or the depth score collapses under questioning.
