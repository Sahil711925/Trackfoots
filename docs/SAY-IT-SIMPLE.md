# Everything, in simple words

How to explain Trackfoots to a judge without using words you can't define.
Read this once slowly. Then read it out loud once.

---

## 1. The problem (20 seconds)

Every company in India must keep security logs for 180 days. The log is the only record of what a hacker did.

But the log sits on the same computer the hacker broke into. So he deletes the lines that show what he did.

Now the company has nothing to show a court, an auditor, or CERT-In.

**One line:** the log is on his computer, so he can erase it.

---

## 2. What we built (30 seconds)

Five pieces. Each one is simple.

1. **Chain** — every line carries a fingerprint of the line before it. Change a line, everything after it stops matching.
2. **Root** — every 100 lines are squeezed into one fingerprint. One number for 100 lines.
3. **Anchor** — that one fingerprint is written on a blockchain. After that, nobody can change it. Not the hacker. Not us.
4. **Receipt** — when an app sends us a line, we send back a signed receipt immediately. So the proof exists even if the line is deleted one second later.
5. **Checker** — a separate program that looks at the log and the blockchain and says: "this is the same" or "this was changed".

**One line:** we can't stop him deleting the log. We make the deletion provable.

---

## 3. How one log line travels (40 seconds)

Think of a shop keeping a receipt book.

- **Step 1.** A line is written: `rahul logged in from 103.21.44.9`.
- **Step 2.** We make a fingerprint of that line, and mix in the fingerprint of the line before it. So every line is tied to the last one. Like a chain.
- **Step 3.** After 100 lines, we make **one** fingerprint for all 100. That is the root.
- **Step 4.** We write that root on a blockchain. The blockchain is a public notebook that nobody can erase or edit. So the root is now permanent.
- **Step 5.** Later, we take the log on the server, make the fingerprint again, and compare it with the one on the blockchain.

If they match → nothing was touched.
If they don't → somebody changed the log, and we can say exactly which 100 lines.

---

## 4. Why hash-chaining alone is not enough (20 seconds)

Most tools do only step 1 and 2. Then a smart hacker does this:

1. He deletes the bad lines.
2. He recalculates the fingerprints of every line after them.

Now the file looks perfect. Every local check passes. The tool says "all good".

This is the attacker most people lose to. **We built that attacker into the demo** and showed he is still caught — because he cannot change the fingerprint that was already on the blockchain.

---

## 5. What is on the screen (walk through it)

Open `/app`. Top to bottom:

- **Pill (top right)** — green = "integrity verified", red = "integrity failed", amber = "no data".
- **Banner** — one plain sentence about the state. Green: logs verified. Red: tampering detected, and how many lines.
- **Four numbers** — entries on disk, entries at write time, batches anchored, hash chain (intact or broken).
- **Log table** — real log lines: `ssh login accepted`, `sudo /usr/bin/apt update`. Each row shows its fingerprint.
- **Published roots** — 12 rows. Each row is one fingerprint written on the blockchain. Green text = on-chain.
- **Receipts box** — how many receipts we hold, and how many are valid.
- **Buttons** — the attack buttons, reset, prove, bundle, live line, incident report.

Say this while pointing: *"Green means the log matches the blockchain. Red means it doesn't."*

---

## 6. The demo, step by step (what you click, what you say)

**0:00 — do nothing yet.**
> "Every company in India must keep security logs for 180 days. Those logs sit on the machine the attacker just took over."

**0:20 — point at the log table.**
> "Each line is tied to the line before it. Every hundred lines become one fingerprint, and we write that fingerprint on a blockchain."

**0:45 — click "Attacker: naive delete".**
> "Our attacker now has full control of this server. He deletes the lines that show what he did."

**0:55 — the banner turns red.**
> "Caught immediately. But that was the easy attacker."

**1:00 — click "Reset demo", then "Attacker: careful forgery".**
> "Now the smart one. He deletes 34 lines and recalculates every fingerprint, so the file looks perfect."

**1:20 — point at "Hash chain: intact".**
> "Look — the chain says intact. Every local check passes. This is the attacker that beats normal tools."

**1:25 — point at the red banner.**
> "Still caught. Because 34 lines were written on the blockchain as a different fingerprint three hours ago, and he cannot change that."

**1:40 — scroll to receipts.**
> "These 34 lines were deleted. But we hold a signed receipt for each one, saved the moment it was written. He can delete the log, not the proof."

**1:52 — click "Send a live line".**
> "Here is a line written right now. The app sends it, and gets a receipt back instantly. So even a line written one second ago is already protected."

**2:00 — point at the red ALERT line.**
> "And nobody had to watch a screen. When it failed, an alert went out."

**2:10 — click "Incident report".**
> "This is what we hand over. One page: what happened, when, which lines, and how anyone can check it themselves."

**2:25 — close.**
> "He owns the server. He still cannot rewrite history."

---

## 7. Words a judge will use — and your answer

- **Hash** → "A fingerprint of a line. Change one letter, the fingerprint changes."
- **Merkle root** → "One fingerprint for 100 lines. Like sealing an envelope with 100 pages inside."
- **Anchor** → "Writing that fingerprint on a blockchain so nobody can change it later."
- **Inclusion proof** → "A small set of fingerprints that proves one line was inside the batch. Four hashes instead of sixteen lines."
- **Tamper-evident** → "We can't stop editing. We can prove it happened." (Not "tamper-proof".)
- **Append-only** → "You can add new lines. You cannot remove old ones without it showing."

---

## 8. What we honestly don't have (say it before they find it)

1. **Not on Polygon.** The demo uses a local blockchain. The same contract is ready for Polygon Amoy, but the testnet wallet had no free coins — every faucet wanted a captcha or a mainnet balance. Written in `docs/AMOY-ATTEMPT.md`.
2. **Receipts are on the same server.** The signing key is in a file on this machine, not in the log folder. In production it goes into a key service.
3. **One server only.** No backup, no second machine. Fine for a demo, not for a bank.

Say this line after: *"We wrote every gap in the README instead of hiding it."*

---

## 9. Five numbers to remember

1. **1,200** lines, **12** fingerprints on the chain.
2. **34** lines deleted by the attacker, **7** rewritten.
3. **178** tests, all passing.
4. **88,000** lines per second.
5. **$2.30** per 100,000 lines.

---

## 10. If your mind goes blank

Say this, slowly:

> "The hacker can delete the logs. He cannot delete the fingerprint we already saved. So we can prove what he deleted — and that proof works for someone who doesn't trust us."

Then click **Attacker: careful forgery** and stop talking. The screen will do the rest.
