# Quai Builders Hub — paste-ready submission

Fill these once you are through Google sign-in. Every field is ready to copy.
Nothing here is guessed: numbers come from the repo (`npm test`, `/api/state`, `docs/QUAI.md`).

---

## Project name
```
Trackfoots
```

## Tagline (one line, ~90 chars)
```
Tamper-evident security logs: the fingerprint is on-chain, so deletion becomes provable.
```

## Short description (~50 words)
```
Security logs live on the machine an attacker just took over, so he deletes them. Trackfoots
hash-chains every line, seals each 100-line batch into a Merkle root, and anchors that root
write-once on Quai. Deleting the log no longer deletes the proof that it existed.
```

## Long description (~170 words)
```
After a breach, the only record of what happened is a log file on the attacker's own server.
Root-level attackers delete the incriminating lines and recompute every hash, so the file
looks perfect and every local integrity check passes. That is the case normal log tooling
cannot detect.

Trackfoots publishes the evidence before the attack. Each log line is hashed together with
the previous one; every 100 lines are reduced to one RFC 6962 Merkle root; that root is
written once to a smart contract that refuses to overwrite it. An auditor compares the log
against the published root and gets an exact answer: batch 3, sequences 201-300, 34 entries
missing.

Beyond detection, the system produces the compliance artifacts Indian law requires: a
180-day retention report that refuses to prune anything inside a published batch, and the
CERT-In 6-hour incident report, including a written statement of what the evidence cannot
prove. Applications adopt it with a single shipper command, without changing their code.
```

## Track / category
```
Cybersecurity & Blockchain  (or "Infrastructure / Security" if that is the closest option)
```

## How it uses Quai (if there is a Quai-specific field)
```
Quai is the write-once anchor. Every 100 log lines become one 32-byte Merkle root, and that
root is published to LogAnchor.sol on Quai Orchard (chain 15000). The contract has no update
path: a second write to the same sequence reverts. Quai's own node decoded and priced our
deployment at 333,698 gas; the contract compiles under Quai's 0.8.20 ceiling and uses the
quais SDK with zone-correct Cyprus-1 addresses (9-bit region/zone/ledger prefix).
Deployment is blocked only on testnet funding: the faucet host named in Quai's docs no longer
resolves, and the third-party replacement needs a drop link.
```

## Tech stack
```
Node.js 22+ · Solidity 0.8.20 · quais SDK · RFC 6962 Merkle tree · HMAC receipts · vanilla JS UI
```

## Links
| Field | Value |
|---|---|
| GitHub | https://github.com/Sahil711925/Trackfoots |
| Live demo | https://utils-les-expert-secondary.trycloudflare.com **(temporary — laptop must be awake)** |
| Dashboard | same URL + `/app` |
| Public status | same URL + `/status` |
| Docs | repo `docs/` — architecture, threat model, Quai notes |
| Video | none (skip the field) |

## Team
```
Sahil — solo build (product, contract, verifier, UI)
```

---

## Before you click submit

1. **Demo link is a tunnel.** It dies when the laptop sleeps. If submission is reviewed later, the
   link may be dead — say so in the description field, or omit it and keep GitHub only. GitHub is permanent.
2. **Don't claim a live Quai deployment.** `deployments.json` has no `quai` entry because there is no
   funded account. Write "deploy path implemented and priced", not "deployed".
3. **183 tests, 20 files.** If a field asks for evidence, that is the number.
4. **Never** write "tamper-proof", "on Polygon", or "production ready".
