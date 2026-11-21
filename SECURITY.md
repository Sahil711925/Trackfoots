# Security policy

Trackfoots is a security product, so the way it fails matters as much as the way it works.

## Reporting a vulnerability

Open a private security advisory on this repository (Security → Advisories → New draft) rather than a
public issue. Include the command you ran, the output, and the version (`git rev-parse --short HEAD`).

## What is in scope

- The hash chain, Merkle construction and checkpoint derivation (`lib/merkle.js`, `lib/verify.js`)
- The auditor's trust boundary: it must never read `data/` (`lib/auditor.js`)
- Receipt signing and the committed receipt set (`lib/receipts.js`, `lib/receipt-tree.js`)
- The anchoring contract's write-once guarantee (`contracts/LogAnchor.sol`)
- Ingest authentication and input validation (`lib/ingest.js`)

## Known and disclosed limits

These are deliberate, documented in the README, and not vulnerabilities in the sense above:

| Limit | Why it exists |
|---|---|
| Demo anchors to a local EVM | Testnet faucets for Amoy and Quai Orchard are blocked; both attempts are in `docs/` |
| Receipt key lives in `.env` on the same host | Outside `data/`, but co-located; production uses a KMS |
| Single node, no `fsync`, no replication | Availability, not integrity — stated in `docs/PERFORMANCE.md` |
| Lines written straight to disk wait for the next anchor | Anything through the ingest API is covered at write time |
| Read endpoints are unauthenticated | Deliberate: an auditor cannot verify what it cannot read |

## What a passing verification does not prove

That the record is intact — not that what it recorded was true, nor who recorded it. A deleted line's
content cannot be recovered from a hash. The incident report states this on the page it hands over.
