# Trackfoots

**Tamper-evident security logs — the proof survives the attacker.**

A log store whose integrity can be *proved* after a breach, even when the attacker has root on the server.
Built for **The Big Hack 2.0**, Track 02 (Cybersecurity & Blockchain), problem **B3 — "Logs the attacker can't erase."**

![Trackfoots demo](docs/screenshot.png)

---

## The problem

CERT-In requires Indian organisations to keep security logs for **180 days** and report specified incidents
within **6 hours**. Those logs are the only record of how a breach happened and what was taken.

They also live on the same machine the attacker now controls. With root access he deletes the incriminating
lines, and the company can prove nothing — not to a court, not to an auditor, not to the regulator.

**Hashing the logs locally does not fix this.** A capable attacker edits an entry and then recomputes every
hash downstream. The file becomes internally perfect and every local check passes. We built that attacker and
we demonstrate him.

---

## How it works

```
   write                      seal                       publish                    verify
┌───────────┐   ┌──────────────────────┐   ┌────────────────────┐   ┌──────────────────────────┐
│ log entry │──▶│ hash chain           │──▶│ Merkle root / 100  │──▶│ LogAnchor.sol (EVM)      │
│  + receipt│   │ H(prev ‖ this)       │   │ 100 leaves → 32 B  │   │ one root per batch,      │
└───────────┘   └──────────────────────┘   └────────────────────┘   │ write-once, public       │
                                                                     └──────────────────────────┘
                                                                              │
                                          ┌───────────────────────────────────┘
                                          ▼
                              ┌────────────────────────────┐
                              │ auditor: three checks      │
                              │ 1 chain  2 root  3 receipt │
                              └────────────────────────────┘
```

1. **Every entry is chained.** `hash = sha256(prevHash ‖ seq ‖ ts ‖ actor ‖ action ‖ meta)`. Change one line and
   every hash after it breaks.
2. **Every 100 entries become two fingerprints.** A **batch root** (this batch only — finds the tampered batch)
   and a **checkpoint root** (every entry so far — CT-style, and what the chain stores).
3. **The checkpoint root is published on-chain.** `LogAnchor.anchor(seq, root, org)` stores it and **refuses to
   ever overwrite that sequence number**. Not by the operator, not by the attacker.
4. **Every write also issues a receipt.** The content fingerprint goes to the auditor at write time, outside the
   server, so deleted lines can later be proven to have existed.

Verification then compares four things: the recomputed chain, the recomputed batch roots, the recomputed
checkpoint roots, and the receipts. Consistency proofs additionally link checkpoint N to checkpoint N+1, so the
log is provably **append-only across time** — not just tamper-evident within a batch.

The Merkle implementation follows **RFC 6962** (Certificate Transparency): `SHA256(0x00 ‖ leaf)` for leaves,
`SHA256(0x01 ‖ l ‖ r)` for nodes, subtrees split at the largest power of two, and `MTH({}) = SHA256()`. The
test suite recomputes every expected root from the RFC's formulas rather than from the implementation.

---

## Why the blockchain is load-bearing

Remove the chain and the design fails its own threat model: the attacker owns the server, so anything stored
only on the server can be rewritten. The chain supplies the one property a compromised server cannot manufacture —
**an independent witness that recorded the value before the attack.**

That is the test the track rule sets, and it is the reason `LogAnchor` exists rather than a database row.

---

## Quick start

```bash
npm install
node scripts/wallet.js          # creates a testnet wallet (optional)
npm run deploy                  # compile + deploy LogAnchor
npm run seed && npm run anchor  # 1,200 entries, roots published
node server.js                  # http://localhost:5173
```

On Windows, double-click **`START_DEMO.bat`** — it starts a local EVM chain, deploys the contract if missing,
starts the server and opens the browser.

---

## Repository map

| Folder / file | What it is |
|---|---|
| `contracts/LogAnchor.sol` | The entire on-chain half: one mapping, one write-once `anchor()` |
| `lib/merkle.js` | SHA-256, Merkle root, inclusion proof, proof verification |
| `lib/store.js` | Append-only log, hash chaining, receipts, batch size |
| `lib/verify.js` | The auditor: chain check, root check, receipt check, bad-batch search |
| `lib/attack.js` | Two attacker profiles — naive deletions and a careful forger |
| `lib/proof.js` | Inclusion proof for a single entry |
| `lib/bundle.js` | Printable auditor evidence bundle (single entry, A4, self-contained) |
| `lib/liveness.js` | Detects anchoring that has silently stopped |
| `lib/consistency.js` | Proves checkpoint N+1 extends checkpoint N (append-only across time) |
| `lib/receipts.js` | HMAC-signed write receipts — the attacker can't mint one |
| `lib/auditor.js` | Independent verifier: bundle + chain, no access to `data/` |
| `public/auditor.html` | The auditor's own screen — never touches the operator's logs |
| `lib/chain.js` | Contract compile, deploy, anchor, read-back |
| `lib/seed.js` | Synthetic log generator (1,200 demo entries) |
| `lib/env.js` | Config loader — `.env` always wins over inherited shell values |
| `server.js` | Web server + JSON API (`/api/state`, `/api/verify`, `/api/attack`, `/api/proof`, `/api/bundle`) |
| `public/index.html` | The demo UI — one file, no build step |
| `cli.js` | Terminal auditor (`node cli.js verify`) |
| `scripts/` | Entry points: seed, anchor, attack, deploy, wallet, prove, bundle, chain verification |
| `tests/` | 61 automated tests (`npm test`), CI on every push |
| `docs/` | Architecture, demo script, judge Q&A, **prior art**, build checklist |
| `LICENSE` | MIT |
| `START_DEMO.bat` / `VERIFY_CHAIN.bat` | One-click launch and one-click chain proof |

---

## Prove it yourself

```bash
node scripts/attack.js smart 3    # attacker deletes 34 entries and rebuilds every hash
node cli.js verify                # -> TAMPERED, batch 3 named, 34 entries recovered
node scripts/verify-chain.js      # -> re-reads roots from the chain: 12 match, 0 differ
node scripts/prove.js 250         # -> inclusion proof: entry 250 was inside the published batch
node scripts/export-bundle.js 250 # -> exports/bundle-250.html, the auditor artifact
npm test                          # -> 61 passing
npm run liveness                  # -> HEALTHY / STALE, detects anchoring that stopped
npm run consistency               # -> APPEND-ONLY: 11/11 checkpoint pairs extend
npm run bundle -- 250             # -> exports/bundle-250.html + .json (the exhibit)
npm run auditor -- exports/bundle-250.json   # -> verifies from the chain alone
```

### Verify without trusting us

The auditor is a separate verifier. It reads **two things**: the bundle and the root published on-chain.

```bash
npm run bundle -- 250
npm run auditor -- exports/bundle-250.json
```

```
✔ entry digest
✔ inclusion proof rebuilds the checkpoint root
✔ checkpoint root matches the chain
VERDICT: the bundle is genuine
```

Edit the bundle by one character and the same command fails — the digest and the proof both stop
matching, while the chain root is unchanged. You can also open `/auditor` in the web UI and paste a
bundle, or press **Tamper with it** to watch the verification break.

Receipts are signed with HMAC-SHA256 using a key held **outside** `data/` (environment/KMS). An intruder
with root can read every log file and still cannot forge a receipt for a line that was never written.

Expected output of the middle step, which is the whole point:

```
✗ LOG INTEGRITY: TAMPERED
  entries on disk      1166
  entries at write time 1200
  hash chain            intact          ← the file is internally consistent
  root check            binary-search
  MISMATCH AGAINST PUBLISHED ROOTS
   batch 3  entries 201-300
  DELETED ENTRIES RECOVERED FROM AUDITOR RECEIPTS  34
```

The chain says **intact** and the verdict says **TAMPERED**. Both are true — he rebuilt every hash, and the
published root still disagrees.

---

## Honest limitations

- **Anchor window.** Entries written since the last batch was published are protected by the hash chain only.
  Closing it needs immediate anchoring (more gas) or per-write receipts promoted to the primary path.
- **Anchoring liveness.** An attacker who blocks outbound traffic stops new anchors. History cannot be rewritten,
  but new entries go unwitnessed. `npm run liveness` detects this (unanchored backlog, anchor age, sequence gaps)
  and exits non-zero; it is not yet wired to paging or email.
- **Signing key.** If the anchor key is stolen, the attacker can publish *new* roots. He can never alter old ones.
- **Receipts.** In this build they live in a separate directory on the same machine — a trust-domain simulation,
  not real isolation.
- **Chain.** The demo runs against a local EVM chain; the same contract compiles and deploys to Polygon Amoy
  unchanged (`CHAIN=amoy`). No public-chain deployment is presented as done.
- **Data.** All 1,200 log entries are synthetic. No personal data is written to the chain — only Merkle roots.

## Prior art

Merkle logging is established: Certificate Transparency (RFC 6962), Trillian, Sigstore Rekor, immudb. Trackfoots
is not a new primitive. The contribution is the **incident-evidence workflow** for CERT-In-style obligations —
a write-once anchor, a three-way auditor, a single-entry inclusion proof and a court-ready bundle — together with
a demonstration that a careful forger defeats local hashing and does not defeat this.

---

*Track 02 · B3 · The Big Hack 2.0 · Acharya Institute of Technology, Bengaluru*
