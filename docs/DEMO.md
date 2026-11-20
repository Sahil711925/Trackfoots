# DEMO — Trackfoots, 2:30, timed

You have **150 seconds** and **151 words**. That is deliberate: two thirds of this demo is the judge reading the
screen while you keep quiet. If you fill the gaps with talking, you overrun and you start overclaiming.

Rehearse three times with a visible timer. Print the table on one page.

---

## Before you speak (60 seconds, do not improvise)

1. `/app` is open on the projector tab. The banner must be **green: "✓ Logs verified — 1,200 entries, 12 published roots, hash chain intact."** If it is not, click **Reset demo** and wait ~3 s.
2. Scroll so the **action row** (the red/green buttons) sits in the **lower third** of the screen. The receipts report renders *underneath* it — you must not scroll mid-sentence at 1:40.
3. Timer visible to you, not the judges. Start it on your first word.
4. Do **not** restart the server on stage unless a break row below says to.

---

## The first 10 seconds (memorise this exactly)

> **"Every company in India must keep security logs for 180 days."**

- Stand still. **Right hand flat on the green banner** — palm on the screen edge, not pointing at the log table.
- One full second of silence. Then: **"Those logs sit on the machine the attacker just took over."**
- Do not say "so", "um", "this is our project", or "let me show you". Start on the noun.

---

## The clock

| Clock | You click | You say (≤22 words) | The judge sees |
|---|---|---|---|
| **0:00–0:20**<br>*(done by 0:09)* | Nothing. Flat hand on the green banner. | "Every company in India must keep security logs for 180 days. Those logs sit on the machine the attacker just took over." | Green banner: **✓ Logs verified** · 1,200 entries · 12 published roots · hash chain intact |
| **0:20–0:45**<br>*(done by 0:29)* | Point down the log table, then at the **Published roots** card. No clicking. | "Each line is hashed with the one before it, so one edit breaks everything after. Every hundred lines become one published root." | 1,200 real sshd-format lines; 12 root rows `#1…#12`, each with a truncated root hash |
| **0:45–1:00**<br>*(done by 0:50)* | **Attacker: naive delete** | "He has root now. He deletes the incriminating lines and leaves the hashes alone." | Banner flips **red: ✗ Tampering detected**, "Hash chain broken at entry …", red **ALERT** line appears under it |
| **1:00–1:20**<br>*(done by 1:06)* | **Reset demo** → wait for green → **Attacker: careful forgery** | "Now the dangerous one: 34 lines deleted, every hash recomputed. The file is internally perfect." | Green, then red again. Entries drop 1,200 → 1,166. Banner: "34 entries were deleted" |
| **1:20–1:40**<br>*(done by 1:28)* | Point at the **Hash chain** stat (`intact`), then at the banner's "First broken batch" line. | "Chain says intact. Every local check passes. Still caught: batch three was published as a different root three hours ago." | Stat box: **Hash chain: intact**. Banner: "First broken batch: **#3** (entries 201–300) — published root … no longer matches" |
| **1:40–2:00**<br>*(done by 1:47)* | Scroll one notch to **Audit trail recovered from receipts**; point at "34 lost entries". Then **Send a live line**. | "Receipts prove the deleted lines existed. And a line written right now comes back signed, before any batch closes." | 34 missing entries with write-time hashes; then a card: sequence, content hash, **receipt signature** |
| **2:00–2:20**<br>*(done by 2:09)* | Point at the **ALERT** pill. Then **Incident report ↗** (new tab). | "Nobody was watching. The alert fired anyway, and this is the CERT-In filing: six hours, one page, and what we cannot prove." | ALERT: `tamper-detected · 34 entries deleted …` · report page: incident ID, deadline, affected batch, "cannot prove" section |
| **2:20–2:30**<br>*(done by 2:27)* | Hands off. Step back from the laptop. | "He owns the server. He still cannot rewrite history, and we can prove it to a stranger." | Both windows: red banner on `/app`, the filing on `/incident` |

**Two footnotes, say neither out loud.** If the ALERT says *repeat suppressed* instead of *dispatched*, that is the
one-page-per-minute rate limit working — not a failure. And if the incident report says "on **local**", that is the
honest state; see **Do not say**.

---

## Clock discipline

Glance at the timer at these three points only:

- **0:45** — you should be pressing **Attacker: naive delete**. Still explaining the Merkle root? You are 10 s late: drop "every hundred lines become one published root" on the next run.
- **1:40** — you should be scrolling to the receipts. If the clock says **1:50+**, **cut the live-line sentence** ("And a line written right now…") and go straight to the alert. The signature card is on screen anyway.
- **2:00** — you should be opening the incident report. Past **2:10**, jump to the close. Row 8 is never cut.

If you are **early** (clock behind the mark): do not add sentences. Stand still and let the judge read. That pause is
the demo working, not a gap in it.

---

## If it breaks

One action each, under 15 seconds. Nothing here needs a terminal except one command, and only in row 1.

| What you see | What you do |
|---|---|
| Page won't load, or is blank | Refresh once. Still blank → one command: `node server.js`, then refresh. Say "one moment, the local node" — nothing else. |
| Banner is **red before you attack** | Click **Reset demo**, wait for green (~3 s), continue. Do not explain it. |
| Amber **⚠ Nothing to verify** | Click **Reset demo**. That is the wiped-directory state, not a bug — if judges ask, that amber screen *is* the product. |
| Buttons greyed out, nothing happens | Wait 3 seconds — a background anchor is running and the action row locks. Press **once**. Never double-click. |
| Incident report says "No integrity failure detected" | You are on a clean state; it regenerates on every load. Click **Attacker: careful forgery**, reopen **Incident report ↗**. |
| Amber **CHAIN DEGRADED** banner | Say "roots are in the local ledger only" and keep going. Do **not** say on-chain. Nothing else in the demo is affected. |

---

## Do not say

Five phrases that will cost you the room. Left is banned; right is the same claim without the overreach.

| Never say | Say this instead |
|---|---|
| "production ready" | "working end-to-end on one node — single-node, single-threaded" |
| "on Polygon mainnet" / "on-chain in production" | "on a local EVM right now; the same contract compiles for Amoy" — the anchor row itself says `local only` |
| "tamper-proof" / "immutable logs" | "tamper-**evident**: he can rewrite the file, he cannot rewrite the published root" |
| "AI-powered" | "hash chain, Merkle tree, contract, auditor" — name the parts, not the buzzword |
| "bank-grade" / "enterprise-grade" | "CERT-In 6-hour notification and 180-day retention, as a filing you can hand over" |

---

## If they ask (one breath each)

**"Isn't this just Certificate Transparency?"** — "Same primitive. What is missing in India is the compliance artifact:
CERT-In wants 6-hour reporting and assumes your logs are intact."

**"Why not a timestamp authority?"** — "A TSA proves a document existed. It does not prove the document you hold now is
the one that was stamped. We need integrity, not just existence."

**"Can't he steal the anchor key?"** — "He can publish new roots. He cannot change ones already published. The damage is
bounded to that window, and it shows up as a gap in sequence numbers."

**"What about lines deleted before they were anchored?"** — "Closed for anything through the ingest API: a signed
receipt at write time, outside `data/`, before any batch. A process writing straight to disk still waits for the next
anchor — that is stated in the README."

**"Did you build this?"** — "During the hackathon, with AI pair-programming. Chain, tree, contract, auditor and UI are
ours; ethers.js, solc and the RFC 6962 rules are not."

---

## Optional beats — only if the clock is behind the mark

Each is outside the 150 seconds. Use **at most one**, and only if you are ahead at 1:40.

- **Forge a receipt** (8 s) — "A receipt for a line that never existed. Rejected: 1,200 valid, one bad MAC." It appends a
  bad receipt that stays until **Reset demo**, so never press it before 1:40.
- **Prove entry** (10 s; number box already at `250`) — "Seven hashes show line 250 sat in batch three when it was
  published, without shipping the other ninety-nine."
- **auditor view ↗** (15 s) — "A separate verifier: it reads the bundle and the published root, never our log files."
  Then **Tamper with it (demo)** → **Verify bundle** → it refuses.
- **`/status`** (8 s) — "No login, no dashboard. A regulator checks the root and the contract address themselves."

---

## The one page to memorise

> **Hash chain** → any edit breaks everything after it.
> **Merkle root** → 100 lines become one fingerprint.
> **Published root** → that fingerprint can never be changed again, by anyone.
> **Receipts** → the deleted lines can still be proved to exist.
> **Incident report** → the proof becomes a filing, not a screenshot.
>
> He owns the server. He still can't rewrite history.

---

## Timing sanity (computed, not estimated)

Method: words split on whitespace in each *say* cell, punctuation-only tokens excluded; speech time = words ÷
**2.4 words/second**.

| Clock | Beat | Budget | Words | Speech @2.4 w/s | Idle (click + judge reading) |
|---|---|---|---|---|---|
| 0:00 | hook | 20 s | 22 | 9.2 s | 10.8 s |
| 0:20 | what it is | 25 s | 22 | 9.2 s | 15.8 s |
| 0:45 | naive attack | 15 s | 14 | 5.8 s | 9.2 s |
| 1:00 | reset + forgery | 20 s | 15 | 6.2 s | 13.8 s |
| 1:20 | the catch | 20 s | 20 | 8.3 s | 11.7 s |
| 1:40 | receipts + live line | 20 s | 19 | 7.9 s | 12.1 s |
| 2:00 | alert + incident report | 20 s | 22 | 9.2 s | 10.8 s |
| 2:20 | close | 10 s | 17 | 7.1 s | 2.9 s |
| **Total** | | **150 s** | **151** | **62.9 s** | **87.1 s** |

- **Total words: 151. Total seconds: 150. Speech: 62.9 s (42%).** Longest row: 22 words (cap is 22). No row exceeds its budget.
- Effective delivery is **~60 words/minute** — a third of normal speech. Every row carries 3–16 s of deliberate silence;
  that silence is where the judge reads the banner. Talk through it and you run over.
- If you speak at a normal 3.5 w/s instead, each row finishes ~3 s early: **hold the pause**, do not add a sentence.
- Rehearsal check: a take under **2:10** means you cut something; over **2:35** means you ad-libbed.
