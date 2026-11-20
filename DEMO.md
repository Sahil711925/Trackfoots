# DEMO — what to click, what to say

Total: **2 min 30**. Rehearse it four times. Do not improvise.

---

## Before you start (2 min before judging)

```bash
cd C:\Users\sahil\Documents\bighack\witness
node server.js
```
Open `http://localhost:5173` in Chrome. Click **Reset demo**. Confirm the banner is green.
Have the terminal open in a second window, already `cd`-ed into the folder.

---

## The script

**[0:00] Point at the green banner.**
> "Every company in India is required to keep security logs for 180 days. When they get hacked, those logs are the only record of what happened. And they sit on the same machine the attacker just took over."

**[0:20] Point at the log table.**
> "Each line is hashed together with the line before it. Change one line, and every hash after it breaks. Every hundred lines, we squeeze the whole batch into one fingerprint and publish it — on Polygon. That fingerprint can never be changed again."

**[0:45] Click "Attacker: naive delete".**
> "Our attacker now has root on this box. He deletes the incriminating lines."

**[0:55] The banner turns red.**
> "Caught immediately. That's the easy attacker."

**[1:00] Click "Reset demo", then "Attacker: careful forgery".**
> "Now the real one. This attacker deletes 34 entries and **recomputes every single hash**, so the file is internally perfect."

**[1:15] Point at the stats row: `Hash chain: intact`.**
> "Look — the chain is intact. Every local check passes. This is the attacker every volunteer tool loses to."

**[1:25] Point at the red banner and the mismatched root.**
> "It's still caught, because 34 was published as a different fingerprint three hours ago and he cannot change that number. Batch 3, entries 201 to 300."

**[1:45] Scroll to the receipts panel.**
> "These are the deleted lines. The auditor was handed a receipt the moment each one was written, on a different machine. He can destroy the log. He cannot destroy the proof it existed."

**[2:05] Point at the "Published roots" column, then the on-chain count.**
> "Every root there is a transaction on a real EVM chain — we're running it locally right now, and the same contract is compiled for Polygon. That transaction is public. Anyone can check it without trusting us."

**[2:20] Close.**
> "One gap we haven't closed: entries written since the last batch was published are only protected by the hash chain. That's our next fix — per-write receipts."

---

## Optional beat (only if you have 20 spare seconds)

Type `250` in the entry box, click **`Prove entry`**.

> "This is an inclusion proof. Seven hashes prove that line 250 sat inside batch 3 when its root was published — without shipping the other ninety-nine lines. If he edits that line, the proof stops rebuilding the root, and it tells you the proof failed."

Then click **`Evidence bundle`** and open the page it prints.

> "And this is what the company hands the auditor. One page, one entry, with the transaction and the proof they can check themselves."

---

## If the demo breaks

| Problem | Do this |
|---|---|
| Page won't load | `node server.js` again in the terminal, then refresh |
| Banner is red before you attack | Click **Reset demo** |
| Everything is red and buttons do nothing | `node scripts/reset.js && node scripts/seed.js 1200 && node scripts/anchor.js`, restart server |
| No internet | It still works — anchoring falls back to the local ledger. Say "we're on a local chain right now, the contract is deployed on Amoy, here's the earlier transaction" and show the saved screenshot |
| Projector washes out colours | Say "green means verified, red means tampered" out loud |

---

## Questions they will ask — and your answers

**"Isn't this just Certificate Transparency?"**
> "The primitive is, yes — Trillian and Sigstore Rekor do Merkle logging. We're not claiming a new data structure. What's missing in India is the compliance artifact: CERT-In requires 6-hour reporting and 180-day retention, and assumes your logs are intact. CERT-In itself put audit-certificate verification on a blockchain this year. We applied the same pattern to the evidence under the certificate."

**"Blockchain is expensive. Why not just a timestamp authority?"**
> "A TSA proves a document existed at a time. It doesn't prove the document you hold now is the one that was timestamped. We need integrity, not just existence — that's the Merkle root, and the anchor makes it unforgeable. Also, we write 32 bytes per 100 log entries, which costs a fraction of a paisa."

**"Can't the attacker just replace the contract's key?"**
> "He can publish new roots if he steals the anchor key. He cannot change roots already published. So the damage is bounded to the window where he holds the key — and that window shows up as a gap in sequence numbers."

**"What if he deletes the logs before they're anchored?"**
> "That's our real gap, and it's the last line of our demo. Entries written since the last published batch are protected by the hash chain only. The fix is per-write receipts, which we already do auditor-side — we just haven't made them the primary path yet."

**"Did you build all of this?"**
> "We built it during the hackathon, with AI pair-programming tools. The hash chain, Merkle tree, contract and auditor are ours; ethers.js and solc are open-source libraries, which the rules allow."

**"How many log lines can it handle?"**
> "Anchoring is O(1) in chain writes per batch — one transaction per 100 entries regardless of size. Verification is O(n) locally, or O(log n) to locate a tampered batch, which is what the binary search does."

---

## The one page to memorise

> **Hash chain** → any edit breaks everything after it.
> **Merkle root** → 100 lines become 1 fingerprint.
> **Blockchain** → that fingerprint can never be changed again, by anyone.
> **Receipts** → the deleted lines can still be proved to exist.
>
> The attacker owns the server. He still can't rewrite history.
