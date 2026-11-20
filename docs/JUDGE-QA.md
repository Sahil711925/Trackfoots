# Judge Q&A — one page

## Say this first (8 words)

> "Logs that a hacker with admin access can't erase."

Then, if they want more:

> "Companies must keep security logs for 180 days — those logs are how anyone proves what a hacker did.
> But they sit on the machine he just took over, so he deletes them and walks free. We make the logs
> deletable but the proof permanent."

---

## The six questions you will actually get

**1. "Why do you need a blockchain? Can't you just hash the logs?"**
> "A hash chain catches a lazy attacker. A capable one edits the line and recomputes every hash downstream, so the
> file is internally perfect — we built that attacker and it passes every local check. What he cannot do is change a
> fingerprint that was published before he got in. That's the only property a compromised server can't fake."

**2. "Isn't this just Certificate Transparency? / Isn't this already solved?"**
> "The primitive is — Certificate Transparency has run Merkle logs at internet scale for a decade, immudb ships it as
> a database, and there's a Sept 2026 paper doing exactly this for AI agents. What changed is the market: AWS retired
> QLDB in July 2025 and pointed customers at Aurora PostgreSQL, which has no tamper evidence at all. And in India
> nothing connects this to CERT-In's 180-day duty — CERT-In's own blockchain covers audit certificates, not the
> evidence behind them. We're not inventing Merkle logs; we're building the incident-evidence artifact for that
> regulation, with the trust root outside the operator. The closest commercial product, Sigilbase, signs its
> checkpoints with a key it holds — an auditor still trusts the vendor. Ours anchors where the operator can't reach."

**3. "You control the contract. Can't you redeploy it and rewrite history?"**
> "I can deploy a new contract, and it starts empty. What I cannot do is change a root inside a contract that already
> published it — that sequence number is write-once, the call reverts. So the history that exists is fixed. That's the
> property, not ownership of the contract."

**4. "What if he deletes the logs before they're anchored?"**
> "That's our real gap and it's the last line of the demo. Entries written since the last published batch are protected
> by the hash chain only. The fix is per-write receipts — we already do them auditor-side, we just haven't made them
> the primary path." *(Volunteering this scores; almost nobody does.)*

**5. "Why is binary search valid for finding the bad batch?"**
> "Because damage is monotone when it reaches the last batch — one changed hash invalidates every later hash, so
> 'is this batch bad' is false-then-true, which is exactly what binary search needs. We don't assume it: the auditor
> tests whether the last batch is bad, and falls back to a linear scan when an attacker tampers with one early batch
> and stops. The report records which method ran."

**6. "Did you build this?"**
> "We built it during the hackathon with AI pair-programming tools. The hash chain, Merkle tree, contract, auditor and
> UI are ours; ethers.js and solc are open-source libraries, which the rules allow."

---

## What NOT to claim

| Don't say | Say instead |
|---|---|
| "It's on Polygon" | "It's a local EVM chain; the same contract compiles for Polygon Amoy — one env variable" |
| "Receipts are on a different machine" | "Receipts are kept outside the server's data directory — separate trust domain in production" |
| "Every 60 seconds we anchor" | "Each completed batch of 100 entries is anchored" |
| "It's completely tamper-proof" | "Tampering is detectable and attributable to a batch; that's what an auditor needs" |

---

## The 2:30 demo

| Time | Action | Line |
|---|---|---|
| 0:00 | point at the green banner | 180-day requirement; logs are how you prove what happened; they live on his machine |
| 0:20 | point at the log table | every line hashed with the previous one; 100 lines → one fingerprint → on-chain |
| 0:45 | `Attacker: naive delete` | he deletes the incriminating lines |
| 0:55 | banner goes red | caught immediately — that's the easy attacker |
| 1:00 | `Reset`, then `Attacker: careful forgery` | the real one: deletes 34 entries and recomputes every hash |
| 1:15 | point at `Hash chain: intact` (green) | every local check passes — this is the attacker local hashing loses to |
| 1:25 | point at the red banner, batch 3 | still caught: that root was published three hours ago |
| 1:45 | scroll to receipts | the deleted lines, recovered from receipts held off-server |
| 2:05 | point at roots column, `12 on-chain` | every root is a real chain transaction |
| 2:20 | close | the one gap we haven't closed: the anchor window |

Optional +20s: type `250` → **Prove entry** → "seven hashes prove this line sat inside batch 3"; then
**Evidence bundle** → "and this is what you hand the auditor."

---

## If it breaks

| Symptom | Fix |
|---|---|
| Page blank | `START_DEMO.bat` again, wait 10s, refresh |
| Banner red before you start | click `Reset demo` |
| Amber "CHAIN DEGRADED" | the chain process died — the demo still runs on the local ledger; don't claim on-chain |
| No internet | nothing here needs internet once `npm install` is done |
| Everything fails | play the backup recording: `C:\Users\sahil\Videos\Captures\` |
