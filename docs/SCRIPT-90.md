# The short scripts

Two versions. Both start with the dashboard open at `/app`, banner green.

---

# 90-SECOND VERSION (recommended)

**0:00 — hand on the green banner. Say nothing for one second.**
> "Every company in India must keep security logs for 180 days. Those logs sit on the machine the attacker just took over."

**0:12 — point at the log table.**
> "Each line is tied to the line before it, so one edit breaks everything after. Every hundred lines become one fingerprint, and we write it on a blockchain."

**0:28 — click Attacker: naive delete.**
> "Our attacker has full control of this server. He deletes the lines that show what he did."

**0:36 — banner goes red.**
> "Caught. But that was the easy one."

**0:42 — click Reset demo, then Attacker: careful forgery.**
> "Now the smart one. He deletes 34 lines and recalculates every fingerprint, so the file looks perfect."

**0:55 — point at Hash chain: intact.**
> "Look — the chain says intact. Every local check passes. This is the attacker that beats normal tools."

**1:02 — point at the red banner, batch 3.**
> "Still caught. Those 34 lines were written on the chain as a different fingerprint three hours ago, and he cannot change that."

**1:10 — scroll to receipts.**
> "We hold a signed receipt for each deleted line, saved the moment it was written. He can delete the log, not the proof."

**1:18 — click Send a live line.**
> "A line written right now. The app gets a receipt instantly."

**1:24 — click Incident report.**
> "And this is what we hand to CERT-In. One page, verifiable by anyone."

**1:30 — close.**
> "He owns the server. He still cannot rewrite history."

---

# 60-SECOND VERSION (if they're rushing you)

**0:00 — hand on banner.**
> "Every company must keep security logs for 180 days. Those logs sit on the machine the attacker just took over."

**0:10 — click Attacker: careful forgery.**
> "This attacker deletes 34 lines and recalculates every fingerprint. The file looks perfect."

**0:22 — point at chain intact, then the red banner.**
> "The chain says intact. Every local check passes. Still caught — because the fingerprint we published three hours ago cannot be changed."

**0:35 — scroll to receipts.**
> "And we hold a receipt for every deleted line, saved when it was written."

**0:45 — click Send a live line.**
> "A line written now gets a receipt immediately."

**0:52 — close.**
> "He owns the server. He still cannot rewrite history."

---

## The three sentences that carry the whole demo

Keep these even if you cut everything else:

1. "The log sits on the machine the attacker owns."
2. "Every hundred lines become one fingerprint, published and unchangeable."
3. "He can delete the log. He cannot delete the fingerprint."

## Never say

"On Polygon" · "tamper-proof" · "receipts on another machine" · "production ready" · "CERT-In compliant"
