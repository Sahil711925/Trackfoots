# CUE CARD — Trackfoots

B3 · "Logs the attacker can't erase"
Read this at 1 a.m. Short lines. Say the answer, then stop.

---

## If you remember three lines

- He owns the server. We can't stop deletion. We make it provable.
- A pass means: this log matches a fingerprint published before the attack.
- Say **local EVM**. Never say **Polygon**.

---

## Numbers you may say

- **183 tests, 20 files** — `npm test` prints `pass 183, fail 0`.
- **1,200 entries · 12 batches · 100 entries per batch.**
- **12/12 roots** read back from the chain match the ledger, 0 differ.
- **34 deleted, 7 rewritten**, batch 3, **10 batches affected** — chain still says *intact*.
- **88,718 entries/s** ingest · **59,000/s** including a root per batch.
- **2.2 s** full audit of 50,000 entries · **204 ms** chain walk.
- **73,905 gas** per anchor · **$2.30 per 100K** events · **$23 per million**.
- **11/11** consistency proofs: each checkpoint extends the one before.
- Drop one receipt of 1,200 → `1199 present, 1200 committed`, **exit 2**.
- Exit codes: auditor **0** genuine / **2** not. Receipts **0/2**. Liveness **0/2**. Retention **0** in window / **3** overdue / **4** refused to prune anchored.

---

## Never say

- "It's on Polygon." → "It's a local EVM; Amoy is one config change and a funded key."
- "Tamper-proof." → "Tamper-evident: detectable and attributable to a batch."
- "Receipts are on another machine." → "Outside `data/`, same box in this build."
- "Every 60 seconds." → "Every completed batch of 100."
- "CERT-In compliant." → "It produces the artifacts; it doesn't file, and it isn't legal advice."
- "Production ready." → "Working prototype, with the gaps written down."

---

# PART 1 — The 12 questions

## 1. "So what does a pass actually prove?"

> "The entries on disk are exactly the ones whose fingerprints were published before the attack, in order, none missing. Nothing more."

**Back:** `npm run auditor -- exports/bundle-250.json` → exit 0; edit one character → exit 2.
**Push:** "Wipe the whole data directory and it says NO DATA, not VERIFIED — absence is never success."

---

## 2. "What if he deletes the logs before you anchor them?"

> "Anything written through the API already left a signed receipt. Lines written straight to disk wait for the next batch; that's the window we disclose."

**Back:** `npm run liveness` → exit 2 past 200 unanchored entries or 3,600 s.
**Push:** "Closing it fully means anchoring per write, or making receipts the only write path. Both cost more."

---

## 3. "Did you build this yourself?"

> "Yes, during the hackathon, with AI coding tools. Our code: chain, Merkle tree, 51-line contract, auditor, UI. Libraries: ethers and solc."

**Back:** `npm test` → 183 pass, 0 fail; `contracts/LogAnchor.sol` is 51 lines.
**Push:** "Point at any file and I'll explain it; the only third-party pieces are ethers, the local chain, and the compiler."

---

## 4. "Isn't this just Certificate Transparency?"

> "The primitive is. CT logs certificates; we log security events and hand you the CERT-In incident page. Same maths, different artifact and buyer."

**Back:** `node --test tests/merkle-incremental.test.js` → 600 prefix sizes, 27 tree shapes, byte-identical.
**Push:** "Trillian, Sigstore Rekor and immudb are the prior art; the contribution is the incident artifact, not the tree."

---

## 5. "Why do you need a blockchain at all?"

> "Because the attacker owns the server. Anything stored only there can be rewritten. The chain is a witness that recorded the fingerprint before he arrived."

**Back:** `node cli.js verify` → hash chain *intact*, verdict **TAMPERED**.
**Push:** "A timestamp authority proves existence, not that the file you hold now is the one that was stamped."

---

## 6. "How is this different from an append-only database with S3 Object Lock?"

> "Object Lock is good storage, but it's still the operator's account. A public chain sits outside it; ours is local today, and I say so."

**Back:** `npm run verify:chain` → 12 match, 0 differ, read from `rootOf(seq)` with no account.
**Push:** "With Object Lock in compliance mode and a separate account, the gap narrows to who can be compelled to produce the key."

---

## 7. "Who holds the private key?"

> "The operator, one wallet, in `.env` today. That's the weakest part: a stolen key can publish new roots, never change old ones."

**Back:** `contracts/LogAnchor.sol` — `owner` is immutable; a second write reverts `AlreadyAnchored`.
**Push:** "A stolen key can lie forward, not backward. Production fix is multisig or an HSM with rotation; I didn't build it."

---

## 8. "Is this production ready?"

> "No. One node, no fsync, receipts on the same box, a local chain, and reads need no login. A working prototype with honest failure modes."

**Back:** `docs/CHECKLIST.md`, section "Open" — three items, written down.
**Push:** "Shortest path: receipts on a second host, fsync per batch, auth on reads, then a public chain."

---

## 9. "How would a company actually deploy this?"

> "Run one Node process, point the shipper at `/var/log/auth.log`, set the ingest key. Ten minutes, no application changes."

**Back:** `npm run shipper -- --file /var/log/auth.log --follow` → 50 sent, 202 accepted.
**Push:** "No container image or Helm chart yet; it's a process plus a JSONL file, which is also why onboarding is fast."

---

## 10. "Does this meet CERT-In?"

> "It produces both artifacts — 180-day retention reporting and a six-hour incident notification built from verifier output. It doesn't file, and it isn't legal advice."

**Back:** `npm run retention` → exit 0 inside the window, 3 overdue, 4 refused to prune anchored entries.
**Push:** "Refusing to prune anchored entries is the point: retention must not become a way to cover tracks."

---

## 11. "What happens when someone asks you to delete their data under DPDP?"

> "Only 32-byte roots go on-chain, never personal data. Deleting the log row is a normal delete; the root still proves something existed."

**Back:** `contracts/LogAnchor.sol` stores one `bytes32` per sequence; no payload, no PII.
**Push:** "Our content hash is unsalted today, so a low-entropy field could be guessed. A KMS-held salt is the fix; it isn't shipped."

---

## 12. "What does this cost at scale?"

> "$2.30 per 100,000 events at 100-event batches on an L2. Loosen to 1,000-event batches and it's $0.23."

**Back:** 73,905 gas per anchor; 1,000 anchors per 100K events; $23 per million.
**Push:** "The chain's gas price sets the bill; the same gas on L1 is about $4,434 per 100K."

---

# PART 2 — The three you must not bluff

Concede the limit first. Then say what closing it takes.
The concession is what makes the other 12 answers believable.

---

## A. The Amoy faucet block

**If asked:** "Is this actually on Polygon?"

**Concede, exactly:**
"We are not on Polygon Amoy. The contract is on a local EVM — chainId 31337, address `0x93C6b8B06Ab9FFeAa46Cdcb39ea9A0E43a2949b3` — and 12 of 12 roots read back from it match the ledger. The Amoy path is implemented: the RPC answered on chainId 80002, the contract compiled, the transaction was signed and broadcast, and the node rejected it because the wallet holds 0 POL and the transaction cost 0.0069 POL. Every faucet wanted a captcha or a mainnet balance."

**Close it, exactly:**
"Fund that address with about 0.007 POL, deploy with `WITNESS_TEST=1 CHAIN=amoy node scripts/deploy.js`, anchor the 12 existing batches, and `verify-chain.js` should print *12 match, 0 differ* against Amoy — same code."

**Then the part that hurts:**
"A local chain is a trust domain the attacker may also own. The independent-witness property is demonstrated, not deployed."

**Do not say:** "It's on Polygon." / "We deployed to testnet." / "It's basically mainnet-ready."

---

## B. Receipts are co-located

**If asked:** "Aren't the receipts on the same machine?"

**Concede, exactly:**
"Yes. They're in `data/auditor/receipts.jsonl`, a different directory on the same laptop. Worse, the signing key is in `.env` on that laptop. That's a trust-domain simulation, not separation — wipe the box and both are gone."

**What still holds, exactly:**
"A receipt can't be forged without that key, and the receipt set is committed to its own Merkle root: drop one of 1,200 and it fails with `1199 present, 1200 committed`, exit 2. But with the key on the box, root can mint receipts for the unanchored tail. It still cannot rewrite an anchored root."

**Close it, exactly:**
"Move the key to a KMS or HSM, move the receipt writer to a second host, and have the emitter keep its own copy. The crypto doesn't change — only where the key lives."

**Do not say:** "The attacker can't touch the receipts." / "Receipts bring the deleted text back." They hold `seq`, `chash`, `ts` — proof a line existed, not its words.

---

## C. Single node, no fsync

**If asked:** "What happens if the box dies?" or "How does this scale?"

**Concede, exactly:**
"One Node process, one core, `appendFileSync` into the OS page cache. It survives a process crash, not a power cut. No replication, no failover, no fsync. The 88,000 a second is one laptop core, not a service level."

**Close it, exactly:**
"fsync per batch is a few milliseconds on NVMe, and a second node with a replicated log is the real fix. Neither is in the benchmark, so I don't claim either."

**Do not say:** "It's durable." / "It scales horizontally." / "The benchmark is production throughput."

---

## If you blank

Say these three, in this order, then stop:

1. "The attacker owns the server. He can delete the log; he can't delete a fingerprint published before he arrived."
2. "The remaining gap is the anchor window, and we show it rather than hide it."
3. "It's a local chain today. Amoy is a config change and a funded key."

---

## If he asks what a word means

- **Hash chain** — each line is hashed with the line before it; edit one, every hash after breaks.
- **Merkle root** — 100 hashes squeezed into one 32-byte fingerprint.
- **Checkpoint** — fingerprint of every entry so far, not just this batch; that's what goes on-chain.
- **Receipt** — signed slip issued at write time: sequence number, content hash, signature.
- **Anchor window** — entries written since the last published root; chained, not yet witnessed.
- **L2** — a cheaper chain that settles on Ethereum; same contract, lower gas.
- **fsync** — forcing bytes onto disk instead of leaving them in the OS cache.

---

## Traps in your own docs

- Counts are current: **183 tests, 20 files**. If a slide or old doc quotes another number, offer `npm test`.
- `docs/DEMO.md` says a receipt is "off-box". Not in this build — say "outside `data/`, same host". (Its Polygon line is already fixed.)
- `README.md` says the receipt key is "outside `data/` (environment/KMS)". True that it's not in `data/`; it is still in `.env` on the same box. Don't stretch that to "off-box".
- An empty data directory now returns **NO DATA**, not VERIFIED. If an older doc says otherwise, the test wins.
- `docs/JUDGE-QA.md` Q8 says 88,700/s; `PERFORMANCE.md` says 88,718. Same number, rounded. Either is safe.
