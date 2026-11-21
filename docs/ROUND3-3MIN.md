# Round 3 — 3 minutes on stage, 2 minutes of questions

**180 seconds. About 320 spoken words.** That is on purpose: roughly half the time the judge is
looking at the screen, not listening to you.

Open `/app` before you start. Banner must be green. Timer where only you can see it.

---

## The 3-minute script

| Clock | You do | You say |
|---|---|---|
| **0:00** | Hand flat on the green banner. One second of silence first. | "Every company in India must keep security logs for 180 days. Those logs sit on the machine the attacker just took over." |
| **0:12** | Point at the log table. | "He has root. He deletes the lines that show what he did. Now the company can prove nothing — not to CERT-In, not to a court." |
| **0:28** | Point at the roots column. | "Each line carries the fingerprint of the line before it. Every hundred lines become one fingerprint, and we write that fingerprint on a blockchain." |
| **0:45** | Point at the chain stat. | "Normal tools stop there. A careful attacker deletes lines and recalculates every hash. The file looks perfect. Every local check passes." |
| **1:00** | **Click Attacker: careful forgery.** | "That's him. Thirty-four lines deleted, every hash recomputed." |
| **1:12** | Point at `Hash chain: intact`, then the red banner. | "Chain says intact. Still caught — because those thirty-four lines were published as a different fingerprint three hours ago. Batch three." |
| **1:30** | Scroll to receipts. | "And every deleted line had a signed receipt, saved the moment it was written. He can delete the log. He cannot delete the proof it existed." |
| **1:48** | **Click Send a live line.** | "A line written right now gets a receipt instantly. So even the last second before an attack is covered." |
| **2:00** | **Click Incident report ↗.** | "This is what we hand CERT-In. One page: what happened, when, which lines, and how anyone can verify it." |
| **2:15** | Point at the table at the bottom of that page. | "And it says what we cannot prove — the content of a deleted line, and who deleted it. That honesty is the product." |
| **2:30** | Back to dashboard. | "183 tests. Twelve of twelve roots match on chain. About two dollars thirty per hundred thousand lines." |
| **2:45** | Stand still. | "He owns the server. He still cannot rewrite history. Thank you." |

**If you are running late at 1:30, cut the live line beat.** It is the least important 18 seconds.

---

## Panel Q&A — the six that will come

**1. "What did you invent?"**
> "Not the maths — that's Google's Certificate Transparency. We built the product on top: automatic
> CERT-In reporting, a receipt at write time, and the defence against the attacker who recomputes hashes."

**2. "Give a real-world use case."**
> "An employee resigns and deletes forty auth-log entries showing he pulled customer records. Today the
> log looks clean. With this, the check fails the same day and names the batch."

**3. "Why blockchain and not a database?"**
> "Because the database is on the machine he owns. The chain is the only copy written before he arrived."

**4. "What is Quai doing here?"**
> "It's where we pin the fingerprint. Write-once, so nobody can erase it, including us. The contract is
> built for Quai Orchard; testnet funding is the one thing blocking a live deployment."

**5. "Is it production ready?"**
> "It's a working prototype. Single node, no replication, receipts on the same box. All three are in the README."

**6. "Who pays for it?"**
> "The company that must file the report. Anchoring costs about two dollars thirty per hundred thousand
> lines — cheaper than one audit finding."

---

## Two questions you must answer without bluffing

| If they ask | Say exactly this |
|---|---|
| **"Is it on a real chain?"** | "The demo runs a local EVM. The Quai contract compiles and the node priced the deployment at 333,698 gas — we could not fund the testnet account because the faucet link moved. The attempt is documented." |
| **"Do you store customer data on chain?"** | "No. Only a 32-byte fingerprint per hundred lines. No names, no IPs, no log text ever leaves the server." |

---

## Timing discipline

- **0:45** — if you have not started the attacker yet, skip the explanation at 0:45 and click.
- **1:30** — if the banner is still green after the attack, the page is stale: click **Reset demo**, then attack once. Do not debug live.
- **2:30** — if you are past this and still talking, go straight to the closing line.

## Never say

"On Polygon" · "tamper-proof" · "receipts on another machine" · "production ready" · "CERT-In compliant"
