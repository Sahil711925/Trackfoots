# WITNESS

**Tamper-evident security logs — the proof survives the attacker.**

The Big Hack 2.0 · Track 02 (Cybersecurity & Blockchain) · Problem **B3 — "Logs the attacker can't erase"**

---

## The problem in three lines

When a company is breached, investigators reconstruct the attack from its logs. CERT-In requires Indian
organisations to keep logs for **180 days** and report certain incidents within **6 hours**.

But the logs live on the same machine the attacker now controls. With root access he deletes the
incriminating lines, and the company can no longer prove what happened — to a court, an auditor, or a regulator.

**WITNESS makes the logs destructible but the proof indestructible.**

## Why the blockchain is load-bearing

A hash chain alone fails against a root-level attacker: he edits an entry, then recomputes every hash
downstream. The file becomes internally perfect and every local check passes. We built that attacker —
`npm run attack smart` — and a hash chain alone cannot catch him.

What he cannot do is change a fingerprint that was already **published**:

1. every entry is hashed together with the entry before it → editing one breaks all later hashes
2. every 100 entries are reduced to a single **Merkle root**
3. that root is written to `LogAnchor` on **Polygon Amoy** — replicated across every node on the network
4. the write is one-way: the contract refuses to overwrite an existing `seq`

The server operator cannot rewrite the chain. The attacker cannot reach it. That asymmetry is the product.
Remove the chain and there is no independent witness — which is exactly the test the track rule sets.

## Live verification, in three commands

```bash
npm run seed        # 1,200 synthetic log entries
npm run anchor      # Merkle roots published
npm run attack smart   # attacker deletes 34 entries and rebuilds every hash
npm run verify      # -> TAMPERED, batch 3, 34 deleted entries recovered
```

The smart attacker leaves an **internally perfect** file. `verify` still catches him, because the root
published at the time no longer matches the data. The deleted lines are recovered from receipts the
auditor was handed at write time — copies that were never on the compromised server.

## Architecture

```
  app ──write──► logs.jsonl        hash-linked, append-only
                    │
                    ├─► auditor/receipts.jsonl     content hash per entry, kept off the server
                    │
                    └─► Merkle root per 100 entries
                              │
                              ▼
                        LogAnchor.sol  (Polygon Amoy)
                        mapping(seq => bytes32 root)
```

| Piece | File | Purpose |
|---|---|---|
| Hash chain | `lib/store.js` | each entry binds the previous entry's hash |
| Merkle tree | `lib/merkle.js` | N leaves → 1 root, plus inclusion proofs |
| On-chain anchor | `contracts/LogAnchor.sol`, `lib/chain.js` | one root per batch, immutable, public |
| Auditor | `lib/verify.js` | chain check, root check, receipt check |
| Attacker | `lib/attack.js` | naive and sophisticated tampering |
| UI | `public/index.html`, `server.js` | what the presenter shows |

## Running it

```bash
npm install
node scripts/wallet.js     # creates a testnet wallet, saves key to .env
# fund the printed address from a Polygon Amoy faucet, then:
npm run deploy             # compiles + deploys LogAnchor
echo "ANCHOR_ON_CHAIN=true" >> .env
npm run seed && npm run anchor
node server.js             # http://localhost:5173
```

No wallet funds? Set `ANCHOR_ON_CHAIN=false` (default). Roots are written to `data/ledger.jsonl`
instead — the same fingerprints, a local witness. The rules allow a local blockchain; the on-chain
path is a config change, not a rewrite.

## Data

All 1,200 log entries are **synthetic**. No real user data, no real company logs, no personal
information touches the chain — only Merkle roots, which are one-way fingerprints.

## What this does not protect against

- **The anchor window.** Entries written since the last batch was published are
  protected by the hash chain only. A root-level attacker inside that window can still delete them.
  Closing it needs immediate anchoring (more gas) or per-write receipts — we implement receipts
  auditor-side and disclose the gap rather than hide it.
- **Anchoring liveness.** An attacker who blocks outbound traffic stops new anchors. He cannot rewrite
  history, but he can stop new entries from being witnessed; this is detectable as a missing `seq`
  and should raise an alarm (not yet implemented).
- **The signing key.** If the server's anchor key is stolen, the attacker can publish *new* roots.
  He still cannot alter old ones, so the damage is bounded to the window in which he held the key.
- **Compromised receipts.** We assume the auditor store is on a different machine with a different trust
  boundary. If the attacker reaches both, deleted content is provable as missing but not recoverable.

## Prior art, and what is different

Merkle-logging is not new: Certificate Transparency (RFC 6962), Trillian, Sigstore Rekor and immudb all
anchor append-only trees. WITNESS is not a new primitive.

What is missing in practice is the **compliance artifact**: CERT-In's 6-hour reporting and 180-day
retention duties assume logs are trustworthy, and in 2026 CERT-In itself moved audit-certificate
verification onto a blockchain (AMBAK). WITNESS applies the same pattern one level down — from the
certificate to the evidence behind it — and produces an auditor-ready bundle instead of a research log.

## Honest scoring note

The pattern is established; the framing, the incident-evidence workflow, and the attack demonstration
are ours. Judges should discount Innovation accordingly and weigh Technical depth and Evidence.
