# The questions they actually ask

Not "what is a Merkle tree". The ones that make you go blank: what did *you* invent, who uses it,
give me a real example, where did the idea come from.

---

## 1. "What did you invent in this?"

**Do not say** "we invented a hash chain" or "we invented Merkle trees". Every engineer in the room
knows that is Google's Certificate Transparency, and you lose instantly.

**Say this:**

> "We didn't invent the maths — Merkle trees come from Certificate Transparency, Google uses them.
> We invented three things on top.
>
> One: the incident report. When tampering is caught, we generate the CERT-In six-hour notification
> automatically, including what we *cannot* prove. That page doesn't exist anywhere else.
>
> Two: the receipt at write time. The app gets proof the second it writes a line, so a deletion in
> the next ten seconds is already caught.
>
> Three: we built the attacker that beats normal tools — the one who recomputes every hash — and
> shipped the defence against him, not just the easy case."

**If they push "so what's genuinely new?"**

> "The primitive is old. The product for Indian compliance is new. Everyone logs; nobody can hand
> a regulator a verifiable page within six hours."

---

## 2. "Give me a real-life example"

Use one story. Say it slowly, it takes 35 seconds.

> "A fintech in Bengaluru. An engineer with admin access is about to resign. On his last Friday he
> deletes forty entries from the auth log — the ones showing he pulled customer records.
>
> Today: the log looks clean. The company finds out only when someone notices the gap in sequence
> numbers weeks later, and by then they can't prove anything to CERT-In or to the customer.
>
> With this: the moment he deletes, the daily check fails. The system names batch 3, entries 201 to
> 300. He can recompute every hash — the fingerprint published three days ago still disagrees. And
> the report is ready to file before the six-hour clock runs out."

**Shorter version if they're impatient:**

> "Insider deletes his own footprints. Server-side hashing can't tell. A fingerprint published
> before he touched anything can."

---

## 3. "Who is this for? Is it usable?"

> "Companies that already must keep logs — fintechs, hospitals, SaaS. They install one command, it
> reads their existing log file, and nothing in their application changes. No rewrite, no new code
> in their app."

**Realistic usability answer (this is what they're really testing):**

> "Today an engineer would write a script for this and get it wrong. We give a shipper that handles
> rotation, restarts and retries — the boring parts people get wrong at 2 a.m."

**If they ask "would you use it?"**

> "If I ran a fintech in India, yes — because the six-hour rule is a legal deadline and my logs sit
> on the attacker's machine."

---

## 4. "Where did you get the inspiration?"

Honest, specific, no hand-waving:

> "Three places. Certificate Transparency — Google's system that proves a certificate wasn't swapped;
> the maths is theirs. Sigstore Rekor, which does the same for software builds. And CERT-In's own
> AMBAK system, which moved audit-certificate verification onto a blockchain in 2026. We took the
> same idea one level down: not the certificate, the evidence under it.
>
> Then the problem statement itself — 'attackers delete the evidence' — and the WazirX and CoinDCX
> cases, where after the breach nobody could agree on what the logs said."

**Why this answer works:** it shows you read primary sources, not blog posts, and it credits prior
work instead of pretending to be first.

---

## 5. "Is this a real problem in India?"

> "CERT-In handled around 30 lakh incidents in 2025. The rules say keep logs 180 days and report
> within six hours. Both assume the logs are intact — that's the gap we're standing in."

---

## When your mind goes blank — the three-question trick

Whatever they ask, answer in this order. It buys you ten seconds to think.

1. **Who has the problem** — "A company that must keep logs for CERT-In."
2. **What do they do today** — "They trust files on the same server the attacker owns."
3. **What changes** — "The fingerprint is published before the attack, so deletion becomes provable."

Then stop. Do not fill the silence.

---

## Never claim

- "We invented the Merkle tree" — false, and the judge knows.
- "It's tamper-proof" — it's tamper-*evident*.
- "It's on Polygon" — it's a local EVM; Quai path is built but unfunded.
- "Production ready" — working prototype, gaps written down.
