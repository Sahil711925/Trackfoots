# DEMO — what to click, what to say

Total: **2 min 30**. Rehearse it four times. Do not improvise.

---

## Before you start (2 min before judging)

```bash
cd C:\Users\sahil\Documents\bighack\witness
node server.js
```

Open `http://localhost:5173` in Chrome — that is the **marketing page**. Click **Open the live dashboard**
(the button goes to `/app`). Confirm the banner is green and the log table shows `ssh login accepted`,
`sudo /usr/bin/apt update` — real-format lines, not fixtures.

> If judges are still walking up, the landing page is the thing to leave on screen: serif, white, calm, and it
> says what the product is before you open your mouth. The moment you start talking, click through to `/app`.

Have the terminal open in a second window, already `cd`-ed into the folder. Have `exports\` open in
Explorer so the incident report is one double-click away.

---

## The script

**[0:00] Point at the green banner.**
> "Every company in India is required to keep security logs for 180 days. When they get hacked, those logs are the only record of what happened. And they sit on the same machine the attacker just took over."

**[0:20] Point at the log table.**
> "Each line is hashed together with the line before it. Change one line and every hash after it breaks. Every hundred lines we squeeze the batch into one fingerprint and publish it — on Polygon. That fingerprint can never be changed again."

**[0:45] Click "Attacker: naive delete".**
> "Our attacker now has root on this box. He deletes the incriminating lines."

**[0:55] The banner turns red.**
> "Caught immediately. That's the easy attacker."

**[1:00] Click "Reset demo", then "Attacker: careful forgery".**
> "Now the real one. He deletes 34 entries and **recomputes every single hash**, so the file is internally perfect."

**[1:15] Point at `Hash chain: intact`.**
> "Look — the chain is intact. Every local check passes. This is the attacker every open-source tool loses to."

**[1:22] Point at the red banner, batch 3.**
> "Still caught, because 34 was published as a different fingerprint three hours ago and he cannot change that number. Batch 3, entries 201 to 300."

**[1:38] Scroll to the receipts line.**
> "These are the deleted lines. Every one came with a receipt signed the moment it was written, with a key that is not on this machine. He can destroy the log. He cannot destroy the proof it existed."

**[1:52] Click "Send a live line".**
> "And this is the part that used to be our gap — a line written *after* the last anchor. Watch: the application posts it and gets a signed receipt back immediately — its sequence number, its hash, its signature. That window is now protected at write time, not at batch time."

**[2:05] Point at the red ALERT line under the banner.**
> "Nobody had to look at a dashboard. The moment verification failed, an alert was raised and dispatched — Slack, PagerDuty, whatever we point it at."

**[2:12] Click "Incident report ↗".**
> "And this is what we file. CERT-In requires notification within six hours. One page: incident ID, detection time, which sequences are gone, the published roots, the contract address, and how they verify it themselves. And a section saying what we **cannot** prove — the content of deleted lines, and who deleted them."

**[2:25] Close.**
> "The attacker owns the server. He still can't rewrite history — and when he tries, we can prove it to someone who doesn't trust us."

---

## Optional beats (only with spare seconds)

**`Prove entry`** — type `250`, click it.
> "An inclusion proof. Seven hashes prove line 250 sat inside batch 3 when its root was published — without shipping the other ninety-nine lines."

**`Evidence bundle`** → open the page.
> "What the company hands the auditor. One entry, its transaction, and the proof they can check themselves."

**`auditor view ↗`** — the strongest 25 seconds you have.
> "A separate verifier. It reads two things: the bundle you hand it, and the root on the blockchain. It never opens our log files, so you don't have to trust our server."
>
> Press **`Tamper with it (demo)`** → **`Verify bundle`** → it refuses. Restore → verifies.

**Search** — press `/`, type `ssh login failed`.
> "1,200 lines and it's a real log browser — 146 matches, filter by actor, paginate. This is what an analyst actually uses at 3 a.m."

**`/status`** — open in a new tab.
> "Same system, no login, no dashboard. A customer or a regulator checks it themselves: root, batches, contract address. If our API were down it would say so — a status page that lies is worse than none."

**Adoption, if they ask "but how would we use this?"**
> "`npm run shipper -- --file /var/log/auth.log --follow`. It tails the file, parses sshd, pushes through the API, resumes from an offset, survives log rotation. No application changes. And `npm run tenants` runs one deployment per company — separate process, separate data, separate roots."

---

## If the demo breaks

| Problem | Do this |
|---|---|
| Page won't load | `node server.js` again, then refresh |
| Banner is red before you attack | Click **Reset demo** |
| Buttons do nothing | Wait 3 seconds (a background anchor is running), or restart the server |
| Log table is empty | Click **Reset demo** — it reseeds from `samples/` |
| `samples/` missing | Falls back to synthetic entries automatically; say "format doesn't matter, the maths does" |
| No internet | Works locally — say "we're on a local EVM now; the same contract is compiled for Amoy" |
| Projector washes out colours | Say "green means verified, red means tampered" out loud |

---

## Questions they will ask — and your answers

**"Isn't this just Certificate Transparency?"**
> "The primitive is, yes — Trillian and Sigstore Rekor do Merkle logging. We're not claiming a new data structure. What's missing in India is the compliance artifact: CERT-In wants 6-hour reporting and 180-day retention, and assumes your logs are intact. CERT-In itself put audit-certificate verification on a blockchain this year. We applied that pattern to the evidence under the certificate."

**"Blockchain is expensive. Why not a timestamp authority?"**
> "A TSA proves a document existed at a time. It doesn't prove the document you hold now is the one that was timestamped. We need integrity, not just existence — that's the Merkle root, and the anchor makes it unforgeable. We write 32 bytes per 100 entries; it costs a fraction of a paisa."

**"Can't he steal the anchor key?"**
> "He can publish new roots. He cannot change roots already published. The damage is bounded to the window where he holds the key, and that window shows up as a gap in sequence numbers."

**"What if he deletes lines before they're anchored?"**
> "That was our gap. It's now closed for anything written through the ingest API — the application gets a signed receipt at write time, so the proof exists off-box before any batch is published. A line written straight to disk by a process we don't control still depends on the next anchor, and that's stated in the README."

**"How does an app actually send you logs?"**
> "POST /api/log with an API key and JSON. Up to a thousand entries per request, 401 without the key, per-index rejection reasons. You get one signed receipt per accepted line."

**"Who gets paged?"**
> "Alerts are raised on tamper, shown under the banner, and POSTed to a webhook if configured. One per minute per type, so a polling page can't turn one incident into a hundred pages."

**"How many lines can it handle?"**
> "About 88,000 entries a second through ingest and batching on this laptop — eleven microseconds each. Fifty thousand lines re-verify in about two hundred milliseconds. The honest limit is single-node, single-threaded."

**"Did you build all of this?"**
> "During the hackathon, with AI pair-programming tools. The hash chain, Merkle tree, contract, auditor and UI are ours; ethers.js and solc are open-source libraries, which the rules allow."

---

## The one page to memorise

> **Hash chain** → any edit breaks everything after it.
> **Merkle root** → 100 lines become 1 fingerprint.
> **Blockchain** → that fingerprint can never be changed again, by anyone.
> **Receipts** → the deleted lines can still be proved to exist.
> **Incident report** → the proof becomes a filing, not a screenshot.
>
> The attacker owns the server. He still can't rewrite history.
