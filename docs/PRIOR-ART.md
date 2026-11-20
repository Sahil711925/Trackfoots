# Prior art — who else does this

Researched 20 Nov 2026. Every claim below has a link. Where I could not verify something, it says so.

## The short version

Merkle-tree audit logging is a **solved primitive** with a decade of production use. Nobody should claim it as new.
Trackfoots is not first, and a judge who knows the field will know that.

What is genuinely thin:

1. **The commercial middle is empty.** AWS **retired QLDB on 31 July 2025** and told customers to migrate to
   Aurora PostgreSQL — which is *not* tamper-evident. A whole category of customers lost their drop-in option.
2. **Almost nothing connects it to Indian obligations.** CERT-In's 180-day retention and 6-hour reporting assume
   logs are trustworthy. Only CERT-In's own **AMBAK** touches blockchain, and only for audit *certificates*.
3. **Most tools stop at signed checkpoints.** Very few anchor to a public chain where a third party can verify
   without trusting the vendor's keys.

---

## Directly comparable products

| Product | What it is | How Trackfoots differs | Link |
|---|---|---|---|
| **Sigilbase** | Managed audit-log API. SHA-256 hash chain, Merkle checkpoints every few minutes, **Ed25519-signed** roots, self-contained evidence bundle, offline verifier. The closest product to ours. | Their trust root is a **signing key they hold**, not a public chain. An auditor still trusts the vendor's key infrastructure. Ours anchors to a chain the operator cannot rewrite. | https://sigilbase.io/writing/best-cryptographic-audit-log-solutions/ |
| **immudb** (Codenotary) | Open-source immutable database, Merkle-backed, clients cryptographically verify server responses. | A database, not an evidence product: you own the key story and must build the auditor narrative yourself. | https://immudb.io/ |
| **Google Trillian** | The verifiable Merkle log behind Certificate Transparency. Inclusion + consistency proofs at internet scale. | Infrastructure only — no evidence bundle, no compliance framing, no operator-facing workflow. | https://github.com/google/trillian |
| **Sigstore Rekor** | Public transparency log (Merkle) for software supply chain artefacts. | Public and supply-chain scoped; not for an organisation's own incident logs. | https://docs.sigstore.dev/logging/overview/ |
| **Azure Confidential Ledger** | Managed immutable ledger with hardware-backed (confidential computing) tamper evidence. | Hardware trust root inside one hyperscaler vs. a public chain; and no CERT-In/incident-evidence workflow. | https://learn.microsoft.com/azure/confidential-ledger/ |
| **AWS QLDB** | Was the obvious drop-in. **End of support 31 July 2025.** | Dead. AWS recommends Aurora PostgreSQL, which offers no cryptographic tamper evidence. **This is the market hole.** | https://aws.amazon.com/qldb/ |
| **Chainkit for Splunk** | Add-on bringing tamper detection and anti-forensic detection into Splunk. | Detection inside the SIEM; the SIEM operator still holds the keys. | https://splunkbase.splunk.com/app/5068 |
| **keralis** (GitHub) | Proof of concept: log-file integrity anchored to the **Hedera** blockchain, real-time tamper detection. | Closest open-source analogue to our anchoring idea; POC scope, no auditor workflow. | https://github.com/clab60917/keralis |

## Research that is uncomfortably close

- **"Agent Flight Recorder: Tamper-Evident Audit Trails with On-Chain Anchoring"** — arXiv **2609.01931**, Sept 2026.
  Hash chaining + Merkle batching + **periodic on-chain anchoring of epoch roots**, deployed to Base Sepolia, with
  inclusion proofs and third-party verification. Architecturally this is our design, applied to **AI agents**
  instead of enterprise incident logs. Useful numbers from their eval: **~48 µs per event**, and anchoring
  100K events on an L2 costs **$2.30**. Cite it before a judge does.
  https://arxiv.org/html/2609.01931
- **"Print-Time Audit-Log Integrity Below the Operating System"** — ACM, 2026. Names the exact gap we disclose as
  our weakest point: *"between the instant a record is produced and the instant it becomes immutable lies a race
  window in which a host-root adversary can delete or rewrite it."* That is our anchor window.
  https://dl.acm.org/doi/10.1145/3837053.3839334
- **"Accountability of Things: Large-Scale Tamper-Evident Logging for Smart Devices"** — arXiv 2308.05557.
  https://arxiv.org/html/2308.05557
- **"Lightweight Tamper-Evident Log Integrity Verification for IoT Edge"** — arXiv 2605.00065 (Merkle pipeline,
  adaptive chunking). https://ar5iv.labs.arxiv.org/html/2605.00065

## India-specific

- **CERT-In AMBAK** — from 15 July 2026, security audit reports and certificates from CERT-In-empanelled auditors
  are verified through a CERT-In blockchain. *Single secondary source (a LinkedIn write-up); confirm on
  cert-in.org.in before putting it on a slide.* https://www.linkedin.com/pulse/cert-in-ambak-transforming-cybersecurity-audit-india-bharat-pandiya-yugof
- **TCIL tender** for "Blockchain Solution and Audit Verification & Continuous Assessment" — indicates the
  government is procuring in this space. https://www.tcil.net.in/tender/pdf/25f2404_1.pdf
- **Blocsys** — sells "compliance-ready audit trails with cryptographic evidence" (enterprise, EU/US/UAE focus).
  https://blocsys.com/compliance-ready-audit-trails-with-cryptographic-evidence/
- **Zebi** — Indian blockchain data-security company (Zebi Secure Cloud, 2018). Current status unverified.

---

## How to answer "isn't this already solved?"

> "The primitive is solved — Certificate Transparency has run this at internet scale for a decade, and immudb
> ships it as a database. What changed is the market: AWS retired QLDB in July 2025 and pointed customers at
> Aurora PostgreSQL, which has no tamper evidence, so a whole category lost its drop-in option. And in India
> nothing connects this to CERT-In's 180-day retention duty — CERT-In's own blockchain covers audit certificates,
> not the evidence behind them. We're not inventing Merkle logs. We're building the incident-evidence artifact for
> that regulation, with the trust root outside the operator."

## What I could not verify

- Whether AMBAK is live and mandatory, or announced — only one secondary source.
- Whether Blocsys or Zebi have paying Indian customers, or are marketing sites.
- Sigilbase's claimed offline verifier — I did not download or test it.
- Any pricing for immudb Cloud / Azure Confidential Ledger.
