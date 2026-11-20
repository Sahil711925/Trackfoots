# CONTENT PACK — Trackfoots landing page

Source-backed copy for the redesign. Every factual claim carries the file it came from.
Where a number is not in the repo it says **not measured** rather than guessing.

Product: tamper-evident security logs. Built for The Big Hack 2.0, Track 02, problem B3
("Logs the attacker can't erase"). Repo: `C:\Users\sahil\Documents\bighack\witness`.

---

## 1. THREAT MODEL

The assumed attacker has root on the box that holds the logs. The claim under test is not
"he cannot delete the log". It is "he cannot delete the proof that the log existed".

| Attacker capability | Detected? | What detects it | What it cannot tell you |
|---|---|---|---|
| **Delete lines**, leaves hashes alone | Yes, immediately | Next entry's `prevHash` no longer matches, so the chain check fails at the first broken entry (`lib/verify.js` check 1). The recomputed batch root also disagrees with the published one (`lib/verify.js` check 2), and every receipt whose `chash` is gone from disk is listed in `missingEntries` (`lib/verify.js` check 3). | The text of the deleted lines. A receipt holds `seq`, `chash`, `ts` and nothing else (`lib/receipts.js`). Also not who deleted them. |
| **Edit lines in place** | Yes | `chainOk: false` with `firstBrokenEntry` set; the stored `chash` no longer matches the recomputed content digest, so the entry lands in `alteredEntries` (`lib/verify.js`). The batch root mismatches (`lib/verify.js`). | The original text, and whether the edit was malicious or a normal correction. No shadow copy is kept. |
| **Reorder lines** | Yes | `prevHash` breaks at the first moved line (`lib/verify.js`). If the attacker also rebuilds the hashes, leaf order changes, so the batch root no longer matches the published root (`scripts/anchor.js`, `lib/merkle.js`). | The original order. It proves the published order differed, not what the order was. |
| **Truncate the tail** | Partly | If the cut removes entries inside a published batch, the batch root and the cumulative checkpoint root both mismatch, and receipts show the count (`lib/verify.js`). If the cut stays inside the **unanchored tail**, nothing published covers it; the only signal is `entriesOnDisk` versus `entriesExpected` from receipts (`lib/verify.js`), and receipts live on the same host. Delete both and it is silent. | How many lines were in the unwitnessed tail, and what they said. This is the anchor window and it is disclosed, not solved (`README.md`, `docs/JUDGE-QA.md` Q5). |
| **Rewrite every hash** | Yes, and this is the case the product exists for | The chain reports **intact** (the file is internally perfect). The cumulative checkpoint root stored on-chain does not match the recomputed one, so the batch is named with its sequence range (`lib/verify.js`), e.g. batch 3, entries 201-300. `report.rootCheckMethod` records whether binary search or a linear scan found it (`lib/verify.js`, `docs/ARCHITECTURE.md`). | Which individual lines were removed (only the count, from receipts), what they said, or who did it. The report says so explicitly (`lib/incident-report.js`, "Cannot prove" rows). |
| **Steal the anchor key** | No, for anything published from then on | History is safe: `anchor()` reverts with `AlreadyAnchored(seq)` on any second write to a sequence number, and `owner` is immutable with no transfer function (`contracts/LogAnchor.sol`). The thief can publish **new** roots for sequence numbers not yet used. | Whether a newly published root is honest. There is no key rotation, no multi-sig and no revocation, so a stolen key can anchor junk forward until someone compares a bundle against the root (`docs/ARCHITECTURE.md` threat table; `docs/JUDGE-QA.md` Q3). |
| **Block outbound network** | Partly, and never by `verify()` | History is untouched and still verifies. New entries stop being witnessed. `npm run liveness` exits **2** when the unanchored backlog exceeds 200 entries, or the last batch is older than 3600 s while fresh entries keep arriving, or the ledger `seq` fails to advance by 1 (`lib/liveness.js`). Nothing pages anyone automatically (`README.md`, "Honest limitations"). | Whether it was the attacker or a dead RPC endpoint. It also cannot tell you what was written during the outage beyond what is on disk. |
| **Replace the whole data dir** | Partly | An **empty** replacement (no `logs.jsonl`, no `ledger.jsonl`, no receipts) is internally consistent: `verify()` returns `VERIFIED` over zero entries, because there is no local published root left to compare against (`lib/verify.js` reads only local files). A **fabricated ledger** is caught: `npm run verify:chain` reads `rootOf(seq)` from the contract and gets zero for sequence numbers that were never anchored (`scripts/verify-chain.js`). | Everything that was in the old directory, and the fact that it existed, unless someone holds an exported bundle or reads the chain's sequence range independently (`lib/bundle.js`). |
| **Backdate timestamps** | Yes for post-hoc edits, no for lies at write time | `ts` is inside `chash`, which is SHA-256 over `ts`, `actor`, `action` and `meta` joined by a pipe character, and inside the chain hash, which adds `prevHash` and `seq` to that string, so changing it breaks both (`lib/store.js`). Anchor time is `block.timestamp`, independent of the entry's own `ts` (`contracts/LogAnchor.sol`). | Whether the `ts` was true when the line was written: `POST /api/log` accepts a client-supplied timestamp and only checks that it parses (`lib/ingest.js`). The proof is "this entry existed before block N", not "this happened at the time it claims". |
| **Malicious operator** | Partly | An operator can deploy a fresh contract, but it starts empty and the old published history still stands (`docs/JUDGE-QA.md` Q3). Serving two different histories fails the consistency proofs, since two histories cannot both extend the same published checkpoint (`lib/consistency.js`). Pruning anchored entries is refused with `RETENTION_BLOCKED`, exit 4 (`lib/retention.js`, `scripts/retention.js`). | Whether the operator or an outside attacker performed a deletion. There is no identity, no signed operator action log, and no access control on the read endpoints (`server.js`). |

Standing caveat: no row above recovers **content**. A one-way hash proves existence, not text
(`lib/incident-report.js`, section 3).

---

## 2. API REFERENCE

All routes are handled in one file, `server.js` (422 lines, zero web framework). Responses are
JSON unless noted. `json()` sets `cache-control: no-store` on every JSON response (`server.js`).

| Method | Path | Auth | Request | Response | Failure codes |
|---|---|---|---|---|---|
| GET | `/` | none | — | `public/landing.html` (`text/html`, `no-store`). Falls through if the file is missing. | 404 `{error:"not found"}` if `landing.html` is absent (`server.js`) |
| GET | `/app`, `/index.html` | none | — | `public/index.html`, the dashboard (`server.js`) | 500 if the file is unreadable |
| GET | `/status`, `/status.html` | none | — | `public/status.html`, public status page (`server.js`) | 404 `status page not built yet` if missing (`server.js`) |
| GET | `/auditor` | none | — | `public/auditor.html`, the independent verifier screen (`server.js`) | — |
| GET | `/fonts/*`, `/img/*` | none | — | Static asset, extension whitelist `.woff2 .woff .ttf .svg .png .jpg .webp`, path-traversal guarded (`server.js`) | 404 `not found` for any other extension or a path outside `public/` (`server.js`) |
| GET | `/dashboard.png` | none | — | Screenshot, `image/png`, `max-age=300` (`server.js`) | 404 `not found` (`server.js`) |
| GET | `/api/state` | none | — | `{entries[≤250, newest first], total, ledger[newest first], consistency{ok,verifiedPairs,totalPairs}, alerts[≤5], chain{expected,network,onChain,total,degraded,dataDir}, report{full verify() output}}` (`server.js` `state()`) | 200 always; `consistency` carries `{ok:false,error}` if the check throws (`server.js`) |
| POST | `/api/log`, `/api/ingest` | `x-api-key` must equal `INGEST_KEY` | One entry, an array, or `{"entries":[…]}` up to 1,000. Entry: `{ts?, actor?, action, meta?}`. `action` required (≤500 chars), `actor` default `"unknown"` (≤120), `ts` must parse, `meta` must be an object ≤4,000 bytes (`lib/ingest.js`) | `202` `{accepted, rejected:[{index,reason}], receipts:[{seq,chash,sig,sigAlg:"hmac-sha256",ts}], ingestedAt, maxBatch:1000, …full state()}` (`server.js`, `lib/ingest.js`) — note the response embeds a full `/api/state` payload | `400` nothing accepted, or bad JSON (`{error, maxBatch}`); `401` `invalid or missing x-api-key`; `409` another mutation is running; `413` body over 2 MB; `503` `ingest disabled: set INGEST_KEY` (`server.js`) |
| POST | `/api/demo/emit` | localhost only (`::1`, `127.0.0.1`) | Empty body; the server picks one of four canned lines and runs it through `ingest()` (`server.js`) | `202` `{line, …ingest result}` (`server.js`) | `403` `localhost only`; `400` on ingest error (`server.js`) |
| GET | `/api/entries` | none | Query: `q` (substring over actor + action + JSON meta), `actor`, `from`, `to` (string compare on `ts`), `limit` 1-500 default 50, `offset` ≥0 (`server.js`) | `{total, matched, offset, limit, entries[newest first], filters:{q,actor,from,to}}` (`server.js`) | 200 always |
| GET | `/api/stats` | none | — | `{entries, batches, unanchored, oldest, newest, ingest:{endpoint:"/api/log",auth:"x-api-key",maxBatch:1000,enabled}}` (`server.js`) | 200 always |
| GET | `/api/alerts` | none | — | `{alerts[≤50], webhook:boolean}` (`server.js`, `lib/alerts.js`) | 200 always |
| GET | `/api/consistency`, `/api/append-only` | none | — | `{pairs[{from,to,oldSize,newSize,oldRoot,newRoot,proofLength,verified,reason}], totalPairs, verifiedPairs, ok, leaves, batches}` (`lib/consistency.js`) | `500 {error}` if the check throws (`server.js`) |
| GET | `/api/proof` | none | `?seq=<n>` | Inclusion proof: `{batch, index, proof[…], root, txHash}` (`lib/verify.js` `proveEntry`) | `404 no proof for entry N`; `400 {error}` (`server.js`) |
| POST | `/api/bundle` | none | `{"seq":250}` | `{path, url:"/bundle/250"}`; writes HTML + JSON into `exports/` (`server.js`, `lib/bundle.js`) | `400 {error}`; `409` if another mutation is running |
| GET | `/bundle/<seq>` | none | path parameter | The printable evidence bundle as `text/html` (`server.js`, `lib/bundle.js`) | `404 {error}` (`server.js`) |
| GET | `/api/incident-report`, `/incident` | none | — | The CERT-In style notification page as `text/html`; built from `verify()` output, chain address and ledger (`server.js`, `lib/incident-report.js`) | 200 always (a clean log yields "No integrity failure detected") |
| GET | `/api/auditor/latest` | none | — | `{file, payload}` from the newest `exports/bundle-<n>.json` (`server.js`) | `404 no exports directory yet`; `404 no bundle exported yet — run: npm run bundle -- 250`; `500 {error}` (`server.js`) |
| POST | `/api/auditor/verify` | none | `{"payload":<bundle json>}` | `verifyPayload()` result; reads the chain root when a deployment exists, otherwise verifies offline (`server.js`, `lib/auditor.js`) | `400 {error}` (`server.js`) |
| POST | `/api/verify` | none | Empty body | `{report:{…verify()}}` (`server.js`, `lib/verify.js`) | — |
| POST | `/api/attack` | none | `{"mode":"naive","batch":3}`, where `mode` is `naive` or `smart` (`server.js`) | `{result{deleted,edited,remaining,batch,fromSeq,toSeq,mode}, …full state()}`; raises an alert when the verdict is not `VERIFIED` (`server.js`) | `400 {error}` e.g. `batch 3 is not anchored yet` (`lib/attack.js`) |
| POST | `/api/forge-receipt` | none | Empty body | Appends one receipt signed with an attacker-chosen key for invented content, returns full `state()` so the verifier can reject it (`server.js`, `lib/receipts.js` `makeForged`) | `400 no entries to forge a receipt for`; `500 {error}` |
| POST | `/api/reset` | none | Empty body | Wipes `store.DATA`, reseeds 1,200 real-format lines, re-anchors, returns `state()` (`server.js`) | `409` if another mutation is running |
| any other | any other | — | — | `{error:"not found"}` (`server.js`) | 404 |

Operational notes visible in the code, worth stating on a page that lists an API:

- **Read routes are unauthenticated.** Only the write path checks `x-api-key` (`server.js`).
- **One mutation at a time.** `withLock()` returns `409` while an anchor or reset is running (`server.js`).
- **`POST /api/log` runs a full `verify()` inside the response payload**, because it spreads `state()`
  (`server.js` line 163). Fine at 1,200 entries, expensive at 50,000.
- **`GET` only.** `HEAD` returns 404 because routes test `req.method === 'GET'`; documented in
  `docs/STATUS-PAGE.md`.

---

## 3. COMPLIANCE MAP

CERT-In's directions are the stated reason the product exists (`README.md`). What follows separates
what the code does from what it does not, with the artifact that proves each line.

| Obligation | What this product does | What it does NOT do | Artifact that proves it |
|---|---|---|---|
| **180-day retention** | Reports the policy window and the store's position in it: `policyDays` (default 180, `lib/retention.js`), cutoff timestamp, total entries, `inPolicy`, `expired`, oldest/newest, `oldestAgeDays`, a per-day histogram, `compliant` (`lib/retention.js` `retentionReport`). Refuses to prune any entry covered by a published batch: `pruneExpired()` throws `RETENTION_BLOCKED`, the CLI exits 4 (`lib/retention.js`, `scripts/retention.js`). | Does not delete anything by default (`--dry-run` is the default; `--prune` alone deletes, `scripts/retention.js`). Does not enforce retention on log sources it was never pointed at. `compliant` means "no entry in this store has aged past the boundary", not "the organisation is compliant". Does not schedule itself. | `npm run retention` → exit 0 compliant, 3 overdue, 4 blocked (`scripts/retention.js`). `npm run retention -- --prune --dry-run` lists what deletion would destroy, marking `[ANCHORED]` (`scripts/retention.js`). |
| **6-hour incident reporting** | Generates the notification page from verifier output: incident id `TF-YYYYMMDD-HHMM-<batches>`, detection timestamp, the literal line "Notification deadline: 6 hours from detection (CERT-In Directions, 28 Apr 2022)", affected batches with sequence ranges and published roots, contract address and network, receipt counts, and four verification steps for the recipient (`lib/incident-report.js`). | Does not submit anything to CERT-In. No email, portal, webhook or API integration exists. The "detected at" value is generation time, not a forensically established first-observation time (`lib/incident-report.js`). Not legal advice; the HTML says so. No sign-off workflow. | `npm run incident` writes `exports/incident-TF-….html` (`README.md`); live at `GET /api/incident-report` or `/incident` (`server.js`). |
| **Logs sufficient for specified offences** | Preserves whatever it is given, in three grammars: OpenSSH `auth.log`, nginx combined, RFC 3164 syslog (`lib/formats.js`), via importer or shipper (`docs/SHIPPER.md`). Every accepted line is chained and receipted at write time (`lib/store.js` `appendLog`, `lib/ingest.js`). Proves a given line existed before a given anchor, and names the sequence range that no longer matches (`lib/verify.js`). | Does not decide which events are in scope for a given offence, does not collect from hosts it is not installed on, does not reconstruct the content of deleted lines, and does not attribute actions to a person (`lib/incident-report.js`). Skip rates are real: 52 of 56 lines parsed in the auth.log sample, 4 skipped (`README.md`). | `npm run import -- samples/auth.log`, then `npm run verify`; `npm run prove -- 250` for a single entry; `npm run bundle -- 250` for the exhibit. |
| **DPDP Act erasure versus immutability** | Nothing DPDP-specific is implemented. There is no `dpdp`, `erasure` or `salt` string anywhere in the repo (verified by grep across `*.md` and `*.js`). The design answer is stated below and must be read as design, not shipped feature. | See below. | `lib/store.js` `contentDigest` (unsalted), `contracts/LogAnchor.sol` (roots only, no payload). |

### DPDP Act erasure versus immutability

The objection is fair: if a data principal asks for erasure, an immutable log looks like a
conflict. It is not, provided the chain never holds personal data. `LogAnchor.sol` stores one
`bytes32` per batch, a Merkle root over entry hashes, and the contract comment says it plainly:
"No log data, no user data, no personal information ever touches the chain" (`contracts/LogAnchor.sol`).
Personal data stays in `logs.jsonl` on the operator's disk, where erasure is an ordinary delete.
What survives is a one-way commitment that a record existed, which is exactly what an auditor
needs and not what a data principal's request reaches.

The mechanism that makes that defensible is **hash before ingest, with an organisation-held salt**.
If the digest that enters the log is `sha256(salt ‖ ts ‖ actor ‖ action ‖ meta)` and the salt is
kept outside the log store (KMS or HSM), then deleting the plaintext and destroying the salt
makes the commitment non-invertible: the on-chain root still proves a record existed at a time,
and no one can recover the fields behind it. The same salt design also closes the dictionary
attack that an unsalted hash invites when the rest of a batch is known.

Status, stated honestly: **this build does not implement that.** `contentDigest` is unsalted
SHA-256 over `ts|actor|action|meta` (`lib/store.js`), and no salt parameter exists in `lib/ingest.js`.
So the current chain commitment is not erasure-safe against a determined dictionary attack on a
low-entropy field, and no claim of DPDP compliance should be made. The paragraph above is the
answer to "how would you", not "what we shipped".

---

## 4. OPERATIONS

One line of what each command proves, and the exact invocation. All are run from the repo root;
`npm run <x>` maps to the script in `package.json`.

| Operation | What it proves | Command |
|---|---|---|
| **Retention report** | How much history sits inside the 180-day window, whether anything has aged past it, and what a prune would destroy without destroying it. Exit 0 compliant, 3 overdue, 4 blocked. | `npm run retention` (`scripts/retention.js`) |
| **Liveness check** | That anchoring is still happening: counts unwitnessed entries past the last batch, measures anchor age, flags ledger sequence gaps. Exit 0 healthy, 2 stale. | `npm run liveness` (`scripts/check-liveness.js`; thresholds `--max-unanchored 200`, `--max-age 3600`) |
| **Chain verification** | That each root in `ledger.jsonl` equals the value read back from the contract with `rootOf(seq)`. Prints `<n> match, 0 differ`. | `npm run verify:chain` (`scripts/verify-chain.js`) |
| **Consistency proof** | That checkpoint N+1 is an extension of checkpoint N, using RFC 6962 §2.1.3 proofs against the two published roots only. Exit 0 all pairs, 2 otherwise. | `npm run consistency` (`scripts/check-consistency.js`) |
| **Receipt verification** | Two claims at once: every receipt signature is valid, and the receipt set reproduces the committed receipt root. Exit 0 verified, 2 incomplete or invalid. | `npm run verify:receipts -- --bundle exports/bundle-250.json` (`scripts/verify-receipts.js`) |
| **Tenant launcher** | That tenants are isolated by process: distinct `store.DATA`, distinct ingest keys, cross-key writes rejected with 401, no shared roots. | `npm run tenants -- up` then `npm run tenants -- status` (`scripts/tenants.js`, registry `tenants.json`) |
| **Shipper** | That an existing log file reaches the store at least once, resuming from a byte offset, retrying transient failures, restarting on truncation or rotation, and only advancing the offset after a 2xx. | `npm run shipper -- --file /var/log/auth.log --url http://localhost:5173 --key $INGEST_KEY --follow` (`scripts/shipper.js`) |
| **Inclusion proof** | That one entry sat inside a specific published batch, without shipping the batch. | `npm run prove -- 250` (`scripts/prove.js`; or `GET /api/proof?seq=250`) |
| **Auditor verification** | That a bundle is genuine using only the bundle and the chain root, with no read of `data/`. Exit 0 genuine, 2 otherwise. | `npm run bundle -- 250` then `npm run auditor -- exports/bundle-250.json` (`scripts/export-bundle.js`, `scripts/auditor.js`) |

---

## 5. WHAT THIS DOES NOT DO

No hedging. Each line is a real limit, stated the way an auditor would write it.

- **The chain is a local EVM, not a public one.** Ganache, chainId 31337, contract
  `0x93C6b8B06Ab9FFeAa46Cdcb39ea9A0E43a2949b3` (`deployments.json`). It is real on-chain state,
  replicated nowhere. The Polygon Amoy path is implemented and was exercised to the point of
  broadcast, then rejected by the node for `insufficient funds`, balance 0, tx cost
  0.006904260047409252 POL; every faucet required a captcha or a mainnet balance
  (`docs/AMOY-ATTEMPT.md`). Why it matters: a local chain is a trust domain the attacker may also
  own, so the "independent witness" property is demonstrated, not deployed. The same contract
  compiles and deploys unchanged with `WITNESS_TEST=1 CHAIN=amoy` (`docs/AMOY-ATTEMPT.md` §8).
- **Receipts are co-located, not on a second host.** `data/auditor/receipts.jsonl` is a different
  directory on the same machine, described in the code as "standing in for a different machine"
  (`lib/store.js`). In production that store must move to another host or a KMS; today it does not
  survive the box being wiped (`docs/CHECKLIST.md`, open items).
- **Single node, no `fsync`, no HA.** One Node process, one core, `appendFileSync` into the OS page
  cache. Durability covers a process crash, not power loss (`docs/PERFORMANCE.md`). No replication,
  no failover, no read replica (`docs/CHECKLIST.md`).
- **The anchor window is real.** Entries written since the last batch was published are protected
  by the hash chain only. `GET /api/stats` exposes the size of that window as `unanchored`
  (`server.js`). For lines written **outside** the API, meaning the seeder, the importer, or
  `store.appendLog` called in-process, no receipt leaves the machine either, so the window is the
  only protection: delete those lines before the next anchor and nothing published contradicts you
  (`docs/JUDGE-QA.md` Q5).
- **No identity, no attribution.** The system can say a sequence range changed and how many entries
  are gone. It cannot say who ran the command, from which session, or with whose credentials. That
  needs host forensics outside this system (`lib/incident-report.js`, "Cannot prove" rows).
- **No tamper-proof storage of the content.** `logs.jsonl` is a plain text file. Root can read it,
  copy it, or delete it. What survives deletion is the proof that a line existed, never the line
  (`README.md`, "Honest limitations").
- **No access control on reads.** Every `GET` route is unauthenticated: `/api/entries` returns log
  content, `/api/state` returns the full audit report, `/api/incident-report` publishes the contract
  address (`server.js`). Fine for a status page, wrong for a multi-tenant production deployment
  without a proxy in front.
- **No alert delivery guarantee.** `ALERT_WEBHOOK` is a fire-and-forget POST with no retry and no
  queue; if the network is down, the alert exists only in the local log (`README.md`). Liveness has
  the same shape: it exits non-zero, it does not page anyone (`docs/ARCHITECTURE.md`).
- **No SIEM, no schema, no search index.** Three log grammars are parsed (`lib/formats.js`);
  everything else is skipped rather than guessed at. Search is a linear substring scan over the file
  (`server.js` `/api/entries`).

---

## 6. NUMBERS

Verified figures only. Where two docs disagree, both are shown and the discrepancy is noted in
section 8.

| Figure | Value | Source |
|---|---|---|
| Automated tests | **174 tests, 18 files** (`node --test tests/*.test.js`) | `docs/CHECKLIST.md`; 174 `test(` calls counted across `tests/*.test.js` |
| Entries per batch | **100** (`BATCH_SIZE`, env-overridable) | `lib/store.js` |
| Demo dataset | **1,200 entries, 12 published batches, batch 3 = entries 201-300** | `data/ledger.jsonl`; `README.md` |
| Roots matched against chain | **12 match, 0 differ** | `docs/CHECKLIST.md`; `docs/AMOY-ATTEMPT.md` §6 |
| Consistency pairs | **11/11** consecutive checkpoints verified (12 batches produce 11 pairs) | `lib/consistency.js`; `README.md` |
| Careful-forgery attack | **34 deleted, 7 rewritten, 10 batches affected**, chain reports `intact` | `lib/attack.js` (every 3rd of 100 victims deleted); `README.md`; `docs/JUDGE-QA.md` |
| Gas per anchor | **73,905 gas** (static derivation from the contract and EIP-2929, not a measurement) | `docs/PERFORMANCE.md` |
| Cost per 100K events | **$2.30** at 100-event epochs (1,000 anchors, $0.0023 each); **$0.23** at 1,000-event epochs; **$0.023** at 10,000 | `docs/PERFORMANCE.md` |
| Ingest throughput | **88,718 entries/s** at 50,000 entries (11.3 µs/entry, 386 B/entry) | `docs/PERFORMANCE.md` |
| Chain re-verify | **204.1 ms for 50,000 entries** (4.08 µs/entry) | `docs/PERFORMANCE.md` |
| Merkle root | **0.57 ms** for 100 leaves; **43.7 ms** for 10,000 leaves | `docs/PERFORMANCE.md` |
| Checkpoint re-derivation, 50,000 entries | **107,506 ms before → 438 ms after** (≈245×), roots byte-identical | `docs/PERFORMANCE.md` |
| Full audit, 50,000 entries / 500 checkpoints | **2.2 s** (44 µs/entry), verdict VERIFIED | `docs/PERFORMANCE.md`; `docs/CHECKLIST.md` |
| Accumulator equivalence | 600 prefix sizes and 27 tree-shape boundaries agree with `merkleRoot()` | `docs/PERFORMANCE.md`; `tests/merkle-incremental.test.js` |
| Ingest limits | **1,000 entries per request**, **2 MB** body, **4,000 bytes** per `meta` | `lib/ingest.js`; `server.js` |
| Liveness thresholds | **200** unanchored entries, **3600 s** anchor age | `lib/liveness.js` |
| Retention policy | **180 days** default | `lib/retention.js` |
| Receipt completeness | **1,200 committed vs 1,199 present → exit 2** when one is dropped | `README.md`; `lib/receipt-tree.js` |
| Tenants | **2** (acme :5174, fintech :5175), distinct data dirs | `tenants.json`; `docs/TENANTS.md` |
| Sample log lines | **157** across three files (56 auth, 49 access, 52 syslog) | `samples/*.log`; `README.md` |
| Tracked files | **100** (`git ls-files`) | repo |
| Source size | **10,924 lines of JavaScript** (63 files), **51 lines of Solidity** (1 contract), **1,853 lines of markdown**, **2,041 lines of HTML** | repo; `contracts/LogAnchor.sol` |
| Library / test split | **4,441 lines in `lib/`**, **3,635 lines in `tests/`** | repo |
| Public-chain deployment | **none. not measured, not done** | `deployments.json` (only `local`); `docs/AMOY-ATTEMPT.md` |
| Uptime, availability, production traffic | **not measured** | no such data in the repo |

Machine for every performance figure: Intel i5-1135G7, 7.8 GB RAM, Windows 11, Node v26.7.0, single
process, single thread (`docs/PERFORMANCE.md`). These are laptop numbers, not service levels.

---

## 7. ONE-LINERS

Twelve captions, each verifiable against section 6 or the cited file.

1. Thirty-four entries deleted, every hash rebuilt, and the root published earlier still names batch 3.
2. The hash chain says intact. The published root says tampered. Both are correct.
3. One 32-byte root per hundred entries, written once, reverting on any second write.
4. A receipt is signed at write time, so a deleted line leaves a hash with nothing behind it.
5. 1,200 entries, 12 batches, 12 roots read back from the chain, 0 differences.
6. Eleven of eleven checkpoints extend the one before, so yesterday's log is a prefix of today's.
7. 88,718 entries per second on one laptop core, 11.3 microseconds each, 386 bytes on disk.
8. Checkpoint re-derivation at 50,000 entries went from 107 seconds to 438 milliseconds, with byte-identical roots.
9. Anchoring costs 73,905 gas, about $2.30 per 100,000 events at 100-event epochs.
10. Block outbound traffic and history stays intact; the liveness check exits 2 and says when it stopped.
11. Drop one receipt from 1,200: signatures still verify, the set no longer reproduces the root.
12. The incident page names the sequences, the roots and the contract address, then lists what it cannot prove.

---

## 8. DISCREPANCIES

Claims in the docs that the code or another doc contradicts. Both sides recorded, nothing silently
resolved.

1. **Test count.** `README.md` says "61 automated tests" in the repository map and "`npm test` → 61
   passing" in "Prove it yourself". `docs/CHECKLIST.md` says "174 tests, 174 pass, 0 fail across 18
   test files". Counting `test(` declarations in `tests/*.test.js` gives 174 across 18 files. The
   README figure is stale; this document uses 174.
2. **`verify()` scaling at 50,000 entries.** `docs/PERFORMANCE.md` "Verify scaling" says 50,000
   entries is "on the order of a minute" and that the fix "is not yet implemented". The later
   "audit rewrite" section of the same file reports 2.2 s and 438 ms, and `lib/verify.js` does
   implement the accumulator (`createMerkleAccumulator`, with a documented slow fallback when
   checkpoints do not ascend). The earlier section was not updated; the 2.2 s figure is the
   current one.
3. **Speedup rounding.** `docs/PERFORMANCE.md` table says **246×** for 50,000 entries; the prose and
   `README.md` say **245×**. 107,506 / 438 = 245.4.
4. **Repo size.** `docs/CHECKLIST.md` says "88 files, ~12,300 lines". `git ls-files` reports **100**
   tracked files, with 10,924 JS + 51 Solidity + 1,853 markdown + 2,041 HTML lines. The checklist
   predates the landing-page work.
5. **Which chain.** `docs/DEMO.md` tells the presenter to say "publish it — on Polygon".
   `docs/AMOY-ATTEMPT.md` says no Amoy deployment exists, `docs/JUDGE-QA.md` lists "It's on Polygon"
   under "What NOT to claim", and `deployments.json` contains only `local`. The demo script line is
   wrong; the contract runs on a local EVM at chainId 31337.
6. **Liveness as an open item.** `docs/ARCHITECTURE.md` "Failure modes we know about" still lists
   "No automated liveness alert when anchoring stops", while the same file's closing section
   documents `lib/liveness.js` and `docs/CHECKLIST.md` marks it done. The failure-mode bullet is
   stale; the limitation that remains is that nothing pages a human automatically.
7. **`/api/state` and the contract address.** `docs/STATUS-PAGE.md` states the `chain` object has no
   `address` field, and `server.js` `state()` confirms it: `chain` carries `expected`, `network`,
   `onChain`, `total`, `degraded`, `dataDir`. Any landing-page copy that renders a contract address
   must take it from `/api/incident-report` or `deployments.json`, not from `/api/state`.
