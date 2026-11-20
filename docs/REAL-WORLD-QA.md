# Real-world questions, real answers

The ones judges actually asked — invention, example, usability, inspiration — plus the questions
that follow them. Short answers, no jargon.

---

## 1. "What did you invent?"

> "Not the maths — Merkle trees are Google's Certificate Transparency. We invented three things on
> top: the automatic CERT-In incident report, a receipt at write time, and the defence against the
> attacker who recomputes every hash."

If pushed: *"The primitive is old. The India-compliance product is new."*

## 2. "Give me a real-life example"

> "A fintech engineer resigns. On his last Friday he deletes 40 auth-log entries showing he pulled
> customer records. Today the log looks clean and they find out weeks later. With this, the daily
> check fails the same day, names batch 3, and the report is ready before the six-hour deadline."

## 3. "Who is this for? Would anyone use it?"

> "Fintechs, hospitals, SaaS companies that already must keep logs for CERT-In. They run one shipper
> command, it reads their existing log file, and no application code changes."

## 4. "Where did you get the inspiration?"

> "Certificate Transparency and Sigstore Rekor — the same maths for certificates and builds. CERT-In's
> own AMBAK system put audit certificates on a blockchain in 2026. We did it one level down: the
> evidence, not the certificate. Plus the WazirX and CoinDCX cases, where nobody could agree what the
> logs said."

## 5. "What is Quai doing here?"

> "It's the notebook where we write one fingerprint per 100 log lines. Nobody can erase that entry,
> including us. The attacker can delete the logs; he cannot delete the entry."

## 6. "Why not just use Splunk, Datadog or CloudWatch?"

> "They show you logs. They don't prove them. If the admin has root, he can edit the index and the
> tool will happily show you the edited version. We answer a different question: was this log changed?"

## 7. "Why would AWS not just build this?"

> "AWS has Object Lock — it protects objects inside your account. Your account is what gets
> compromised. Our fingerprint is written outside your account, and the check does not need us to be
> honest."

## 8. "Who pays, and how much?"

> "The company that must file the report — it's cheaper than an audit finding. About $2.30 per
> 100,000 log lines for the anchoring. The software would be priced per site, not per line."

## 9. "What does it cost to run for real?"

> "One small node, one blockchain transaction per 100 lines. At a million lines a day that's ten
> transactions — fractions of a cent each at L2 prices."

## 10. "What if the hacker deletes everything, including your server?"

> "He can. Then the check says NO DATA — not 'verified'. And the fingerprint is still on the chain,
> so an auditor can see that 1,200 lines were published and none are left. Deleting everything is
> itself evidence."

## 11. "Do you store our customers' personal data?"

> "No. Only a fingerprint of each line goes anywhere near the chain. If a company needs a person's
> data removed, they hash or salt that field before it enters the log — the proof stays, the identity
> goes."

## 12. "Is this admissible in court?"

> "It's evidence, not a verdict. It proves the record wasn't altered after a point in time. A court
> still decides whether the record was true when written. Our incident report says that in writing."

## 13. "What if your company shuts down?"

> "The verifier is offline and open. The bundles and the chain don't need us. That's deliberate —
> evidence that depends on a vendor staying alive isn't evidence."

## 14. "How long does installation take?"

> "One command for the shipper. Ten minutes for a first anchor. The auditor needs nothing — it's a web
> page or a CLI."

## 15. "What breaks first at scale?"

> "The single node. It's one process writing to local files. Next is the anchor key — one key, one
> signer. Both are on our roadmap and written in the README."

## 16. "What would you do with another month?"

> "Two things: put the receipt key in a KMS so it's genuinely off the box, and make anchors
> multi-signer so one stolen key can't publish false history going forward."

## 17. "Why should we believe your numbers?"

> "Everything is in the repo. `npm test` prints 183 passing tests. The audit numbers come from a
> benchmark script you can run. The failures — Amoy, the faucet, the single node — are documented in
> the same folder."

## 18. "What's the one thing you're most proud of?"

> "That the system tells you what it *can't* prove. The incident report has a section saying 'we
> cannot recover the content of a deleted line, and we cannot name who deleted it'. Most tools would
> quietly leave that out."

## 19. "Did you build this alone?"

> "The product, yes — with AI as a pair programmer. The hash chain, Merkle tree, contract, verifier
> and UI are ours. ethers and solc are open-source libraries, which the rules allow."

## 20. "What did not work?"

> "Two deployments. Polygon Amoy and Quai Orchard both need testnet funds; Amoy's faucets wanted a
> captcha or a mainnet balance, and Quai's faucet host no longer exists. So the demo runs a local EVM
> — and both attempts are written up with the exact errors."

---

## If you only remember three

1. "We didn't invent the maths — we invented the compliance product on top of it."
2. "He can delete the log. He cannot delete the fingerprint."
3. "We wrote down what it can't do, next to what it can."
