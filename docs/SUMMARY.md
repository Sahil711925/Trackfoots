# Trackfoots — summary, in four lengths

Copy whichever fits the field. All numbers are from the repo.

---

## One line (18 words)

> Tamper-evident security logs: the fingerprint is published on-chain, so deleting the log no longer
> deletes the proof.

## One paragraph (55 words)

> Security logs sit on the machine an attacker just took over, so he deletes them. Trackfoots
> hash-chains every line, seals each 100-line batch into a Merkle root, and anchors that root
> write-once on a blockchain. Deletion becomes provable instead of invisible — and the system writes
> the CERT-In incident report from the failure itself.

## Short submission text (110 words)

> **The problem.** When a company is breached, the only record of what happened is a log file on the
> attacker's own server. He deletes the incriminating lines and recomputes every hash, so the file
> passes every local integrity check.
>
> **What we built.** Every log line is hashed with the line before it. Every 100 lines become one
> RFC 6962 Merkle root, written once to a smart contract that refuses to overwrite it. An auditor
> compares the log with the published root and gets an exact answer: batch 3, entries 201–300,
> 34 missing.
>
> **Why it matters.** CERT-In requires 180-day retention and reporting within six hours. Both assume
> the logs are intact. This makes that assumption checkable — by someone who does not trust the
> company or us.

## Full summary (200 words)

> **Trackfoots — logs the attacker can't erase.**
>
> After a breach, the evidence lives on the attacker's machine. Root access means he can delete the
> lines that show what he did, then recompute every hash so the file looks perfect. Every local check
> passes. Existing log tooling has nothing to compare against.
>
> Trackfoots publishes the comparison before the attack. Lines are hash-chained; each batch of 100 is
> reduced to one Merkle root; that root is written once to a smart contract with no update path. When
> an attacker deletes 34 entries and rebuilds every hash, the chain still reports intact — and the
> published root catches him, naming batch 3 and the exact sequence range.
>
> Around that core: a signed receipt returned at write time, so a deletion seconds later is already
> provable; an offline verifier that never touches our log files; a public status page that needs no
> account; a 180-day retention report that refuses to prune inside a published batch; and the CERT-In
> six-hour incident report, generated from the failure, including a written statement of what the
> evidence cannot prove.
>
> Built on Node and Solidity, 183 automated tests, adoptable with one shipper command and no
> application changes.

---

## The facts, if a form asks

| | |
|---|---|
| Problem | The Big Hack 2.0 · Track 02 · **B3 — logs the attacker can't erase** |
| Tests | 183 passing, 20 files |
| Stack | Node.js, Solidity 0.8.20, quais, RFC 6962 Merkle tree, HMAC receipts |
| Chain | local EVM in the demo · contract compiles for Quai Orchard (15000) and Polygon Amoy |
| Repo | github.com/Sahil711925/Trackfoots |
| Size | 116 tracked files |
| Honest gap | testnet faucets blocked on both chains; receipts co-located; single node |
