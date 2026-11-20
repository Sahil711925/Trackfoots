'use strict';
/**
 * bundle.js — renders ONE log entry as a self-contained, print-ready A4 evidence bundle.
 *
 * This is the artifact a company hands to an auditor, a CERT-In investigator, or a court:
 * a single page that names the entry, its hash, the batch it was sealed into, the Merkle root
 * that was published at the time, and the short inclusion proof that ties the two together.
 *
 * Design rules:
 *   - no network, no external assets, no JavaScript in the output (a court exhibit must not
 *     depend on anything that can change after it is printed)
 *   - every hash is shown in full, because a truncated hash proves nothing to a third party
 *   - every claim in the document is recomputed from the files on disk right now, and any
 *     disagreement is printed loudly instead of being hidden
 */
const fs = require('fs');
const path = require('path');
const { sha256, merkleRoot, merkleProof, verifyProof } = require('./merkle');
const store = require('./store');
const { proveEntry } = require('./verify');

const ROOT = path.join(__dirname, '..');
const EXPORTS_DIR = path.join(ROOT, 'exports');
const DEPLOYMENT_FILE = path.join(ROOT, 'deployments.json');

/* ------------------------------------------------------------------ helpers */

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const pad = (n) => String(n);

function deploymentFor(chainName) {
  try {
    if (!fs.existsSync(DEPLOYMENT_FILE)) return null;
    const all = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    const key = String(chainName || '').toLowerCase();
    const hit = all[key] || null;
    return { key, entry: hit, all };
  } catch (err) {
    return null;
  }
}

function explorerHref(batch, deployment) {
  const base =
    (batch && batch.explorer) ||
    (deployment && deployment.entry && deployment.entry.explorer) ||
    null;
  if (!base || !batch || !batch.txHash) return null;
  return `${String(base).replace(/\/+$/, '')}/tx/${batch.txHash}`;
}

const SIMULATED = 'LOCAL-SIMULATED';

/* --------------------------------------------------------------- the data */

function collect(seq) {
  const rows = store.readLogs();
  const parsed = rows.filter((r) => r.ok).map((r) => r.entry);
  const entry = parsed.find((e) => Number(e.seq) === Number(seq));
  if (!entry) {
    const err = new Error(
      `entry #${seq} not found in the log on disk (${parsed.length} readable entries at ${store.LOGS})`
    );
    err.code = 'ENOENTRY';
    throw err;
  }

  const batch = store.readLedger().find((b) => Number(seq) >= b.fromSeq && Number(seq) <= b.toSeq);
  if (!batch) {
    const err = new Error(
      `entry #${seq} is not covered by any published batch yet — run \`npm run anchor\` before exporting evidence`
    );
    err.code = 'ENOBATCH';
    throw err;
  }

  // Leaves exactly as the anchoring code built them: entries in the batch range, in log order.
  const leaves = [];
  for (let s = batch.fromSeq; s <= batch.toSeq; s++) {
    const e = parsed.find((x) => Number(x.seq) === s);
    if (e) leaves.push(e.hash);
  }
  const recomputedRoot = merkleRoot(leaves);

  // The proof is produced by the same routine the CLI/UI use, so the bundle cannot drift from them.
  const proven = proveEntry(Number(seq));
  let proof = proven && Array.isArray(proven.proof) ? proven.proof : null;
  let index = proven ? proven.index : Number(seq) - batch.fromSeq;

  // Guard: only trust the proof when the leaf at that index really is this entry.
  if (!proof || leaves[index] !== entry.hash) {
    const at = leaves.indexOf(entry.hash);
    if (at >= 0) {
      index = at;
      proof = merkleProof(leaves, at);
    } else {
      proof = null;
      index = -1;
    }
  }

  const withRunning = [];
  if (proof) {
    let cur = entry.hash;
    for (let i = 0; i < proof.length; i++) {
      const step = proof[i];
      cur = step.side === 'right' ? sha256(cur + step.hash) : sha256(step.hash + cur);
      withRunning.push({ i: i + 1, hash: step.hash, side: step.side, running: cur });
    }
  }
  const recoveredRoot = withRunning.length ? withRunning[withRunning.length - 1].running : null;

  // Chain checks, recomputed here rather than trusted from the file.
  const contentOk = store.contentDigest(entry) === entry.chash;
  const hashOk = store.entryDigest(entry, entry.prevHash) === entry.hash;
  const prev = parsed.find((e) => Number(e.seq) === Number(seq) - 1) || null;
  const linkOk = entry.prevHash === (prev ? prev.hash : 'GENESIS');
  const rootOk = recomputedRoot === batch.root;
  const proofOk = proof ? verifyProof(entry.hash, proof) === batch.root : false;
  const included = hashOk && contentOk && linkOk && rootOk && proofOk;

  return {
    entry, batch, leaves, recomputedRoot, proof, withRunning,
    recoveredRoot, index, contentOk, hashOk, linkOk, rootOk, proofOk, included,
    prev: prev ? { seq: prev.seq, hash: prev.hash } : null,
    entriesOnDisk: parsed.length,
  };
}

/* --------------------------------------------------------------- the page */

const STYLE = `
  @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: "Times New Roman", "Liberation Serif", Georgia, serif;
    font-size: 10.5pt; line-height: 1.42; color: #111111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { max-width: 182mm; margin: 0 auto; }
  .masthead { border-top: 3pt solid #0f172a; border-bottom: 0.6pt solid #0f172a; padding: 6pt 0 5pt; }
  .masthead .brand { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 15pt; letter-spacing: 3.2pt; font-weight: 700; color: #0f172a; }
  .masthead .doc { font-size: 12pt; margin-top: 2pt; }
  .masthead .meta { font-family: Arial, sans-serif; font-size: 7.6pt; color: #4b5563; margin-top: 4pt; letter-spacing: 0.3pt; }
  h2 {
    font-family: Arial, Helvetica, sans-serif; font-size: 8.4pt; letter-spacing: 1.5pt;
    text-transform: uppercase; color: #0f172a; margin: 14pt 0 5pt;
    border-bottom: 0.6pt solid #cbd5e1; padding-bottom: 2.5pt;
  }
  h2 .num { color: #64748b; margin-right: 5pt; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th, td { text-align: left; vertical-align: top; padding: 3.2pt 4pt; border-bottom: 0.4pt solid #e2e8f0; }
  th { background: #f1f5f9; font-family: Arial, sans-serif; font-size: 7.6pt; letter-spacing: 0.7pt; text-transform: uppercase; color: #334155; }
  table.kv th { width: 34mm; background: #f8fafc; }
  tr { page-break-inside: avoid; }
  .mono, code { font-family: "Consolas", "Courier New", monospace; font-size: 8.4pt; }
  .hash { word-break: break-all; }
  .small { font-size: 8.2pt; color: #4b5563; }
  .note { font-size: 9.2pt; color: #334155; }
  pre.record {
    font-family: "Consolas", "Courier New", monospace; font-size: 8.2pt; line-height: 1.35;
    background: #f8fafc; border: 0.5pt solid #e2e8f0; border-left: 2.5pt solid #0f172a;
    padding: 6pt 7pt; margin: 0; white-space: pre-wrap; word-break: break-all;
  }
  ol.steps { margin: 0; padding-left: 15pt; }
  ol.steps li { margin-bottom: 3.4pt; font-size: 9.2pt; }
  .verdict {
    margin-top: 10pt; border: 0.7pt solid #0f172a; padding: 6pt 8pt;
    font-family: Arial, sans-serif; font-size: 8.6pt; letter-spacing: 1.1pt; text-transform: uppercase;
  }
  .ok { color: #14532d; border-color: #14532d; background: #f0fdf4; }
  .bad { color: #7f1d1d; border-color: #7f1d1d; background: #fef2f2; }
  .pill { font-family: Arial, sans-serif; font-size: 7.4pt; letter-spacing: 0.6pt; padding: 0.8pt 4pt; border-radius: 2pt; text-transform: uppercase; }
  .pill.ok { background: #dcfce7; color: #14532d; border: 0.4pt solid #86efac; }
  .pill.bad { background: #fee2e2; color: #7f1d1d; border: 0.4pt solid #fca5a5; }
  .foot { margin-top: 14pt; border-top: 0.6pt solid #cbd5e1; padding-top: 5pt; font-family: Arial, sans-serif; font-size: 7.4pt; color: #64748b; }
  .kicker { font-family: Arial, sans-serif; font-size: 7.6pt; letter-spacing: 1pt; text-transform: uppercase; color: #64748b; }
  .avoid { page-break-inside: avoid; }
`;

function kvRow(k, v, opts = {}) {
  return `<tr><th>${esc(k)}</th><td class="${opts.cls || ''}">${v}</td></tr>`;
}

function statusPill(ok) {
  return ok ? '<span class="pill ok">pass</span>' : '<span class="pill bad">fail</span>';
}

function metaRows(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  const keys = Object.keys(meta);
  if (!keys.length) return '';
  return keys
    .map(
      (k) =>
        `<tr><th class="mono">${esc(k)}</th><td class="mono hash">${esc(
          typeof meta[k] === 'object' ? JSON.stringify(meta[k]) : meta[k]
        )}</td></tr>`
    )
    .join('');
}

function render(ctx) {
  const { entry, batch, proof, withRunning, recomputedRoot, recoveredRoot, index } = ctx;
  const generatedAt = new Date().toISOString();
  const deployment = deploymentFor(batch.chain);
  const onChain = String(batch.chain || '').toUpperCase() !== SIMULATED;
  const address = onChain && deployment && deployment.entry ? deployment.entry.address : null;
  const href = explorerHref(batch, deployment);
  const seq = entry.seq;

  const txCell = batch.txHash
    ? `<span class="mono hash">${esc(batch.txHash)}</span>${
        href ? `<br><span class="small">${esc(href)}</span>` : ''
      }`
    : '<span class="small">not recorded</span>';

  const proofTable = proof
    ? `<table>
        <thead><tr>
          <th style="width:9mm">Step</th>
          <th>Sibling hash (the other half of the pair)</th>
          <th style="width:22mm">Sibling is on</th>
          <th>Hash after combining</th>
        </tr></thead>
        <tbody>
          ${withRunning
            .map(
              (s) => `<tr>
                <td class="mono">${pad(s.i)}</td>
                <td class="mono hash">${esc(s.hash)}</td>
                <td class="mono">${esc(s.side)}</td>
                <td class="mono hash">${esc(s.running)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <p class="small">${withRunning.length} step(s): entry hash combined upward, left-to-right at each level, to
      recover the batch root. No other entry in the batch is needed to check this line.</p>`
    : `<p class="note">No inclusion proof could be constructed: this entry's hash does not appear in the
       batch leaves that are currently on disk. That means the batch contents have changed since the root
       was published.</p>`;

  const checks = [
    ['Entry hash recomputes from its own content', ctx.hashOk],
    ['Entry content digest (chash) recomputes', ctx.contentOk],
    ['Previous-hash link matches the entry before it', ctx.linkOk],
    ['Batch Merkle root recomputes to the published root', ctx.rootOk],
    ['Inclusion proof recovers the published root', ctx.proofOk],
  ]
    .map(
      ([label, ok]) =>
        `<tr><td>${esc(label)}</td><td style="width:14mm">${statusPill(ok)}</td></tr>`
    )
    .join('');

  const witnessSentence = onChain
    ? `root value <strong>${esc(batch.root)}</strong> was published to a ledger outside the organisation's control
       on ${esc(batch.ts)} (transaction <span class="mono">${esc(batch.txHash)}</span>).`
    : `root value <strong>${esc(batch.root)}</strong> was committed to the append-only witness ledger on
       ${esc(batch.ts)}. In this offline anchor mode no public-chain transaction was made; the root is fixed by
       that ledger entry and by the auditor receipts held outside the server, which is what makes it
       unforgeable after the fact.`;

  const explanation = ctx.included
    ? `This page establishes one fact: log entry <strong>#${esc(seq)}</strong>, exactly as printed above,
       existed in the organisation's log at the time shown, and has not been altered since. It does so
       without asking anyone to trust the organisation or this document. The entry's SHA-256 hash is a
       fingerprint of its content; changing any character of it produces a different hash. That hash sits at
       position <strong>${esc(index)}</strong> of a Merkle tree of <strong>${esc(batch.count)}</strong> entries
       (batch <strong>${esc(batch.batch)}</strong>, entries ${esc(batch.fromSeq)}–${esc(batch.toSeq)}), whose single
       ${witnessSentence}
       The proof below lets anyone recompute that same root from this one entry in ${withRunning.length} steps.
       Because the root was fixed and witnessed before any tampering could have occurred, an attacker who
       edits the log afterwards cannot produce a matching hash — the recomputed root no longer equals the
       published one. That mismatch, not the organisation's word, is what makes the record evidence.`
    : `This entry FAILS verification as it currently stands on disk. At least one check below does not
       reproduce the value that was published at the time. Either the entry was altered after it was written,
       or entries around it were deleted or renumbered. The published root
       ${batch.root ? `<span class="mono">${esc(batch.root)}</span>` : ''} still exists independently in the
       witness ledger${onChain ? ' and on the public chain' : ''}, and it cannot be rewritten from inside the
       organisation — so the discrepancy itself is the evidence. Do not treat the entry above as an accurate record of what happened; treat this failure
       report as the finding.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TRACKFOOTS evidence bundle — entry #${esc(seq)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="sheet">

  <div class="masthead">
    <div class="brand">TRACKFOOTS</div>
    <div class="doc">Incident evidence bundle</div>
    <div class="meta">
      DOCUMENT&nbsp;&nbsp;TRACKFOOTS-EB-${String(seq).padStart(6, '0')} &nbsp;·&nbsp;
      ENTRY&nbsp;#${esc(seq)} &nbsp;·&nbsp;
      BATCH&nbsp;${esc(batch.batch)} &nbsp;·&nbsp;
      GENERATED&nbsp;${esc(generatedAt)}
    </div>
  </div>

  <div class="verdict ${ctx.included ? 'ok' : 'bad'}">
    ${ctx.included
      ? `Integrity established — entry #${esc(seq)} is included in published batch root ${esc(String(batch.root).slice(0, 24))}…`
      : `Integrity check FAILED — entry #${esc(seq)} does not reproduce its published root`}
  </div>

  <h2><span class="num">1</span>The log entry</h2>
  <table class="kv">
    <tbody>
      ${kvRow('Sequence', `<span class="mono">${esc(seq)}</span>`)}
      ${kvRow('Timestamp (UTC)', `<span class="mono">${esc(entry.ts)}</span>`)}
      ${kvRow('Actor', esc(entry.actor))}
      ${kvRow('Action', `<strong>${esc(entry.action)}</strong>`)}
      ${kvRow('Entry hash', `<span class="mono hash">${esc(entry.hash)}</span>`)}
      ${kvRow('Content digest', `<span class="mono hash">${esc(entry.chash || '(absent)')}</span>`)}
      ${kvRow('Previous hash', `<span class="mono hash">${esc(entry.prevHash)}</span>`)}
    </tbody>
  </table>

  <h2><span class="num">2</span>Metadata recorded with the entry</h2>
  ${metaRows(entry.meta) ? `<table class="kv"><tbody>${metaRows(entry.meta)}</tbody></table>` : '<p class="small">No metadata was recorded for this entry.</p>'}
  <p class="kicker" style="margin:8pt 0 3pt">Raw record as stored (canonical bytes that were hashed)</p>
  <pre class="record">${esc(JSON.stringify(entry))}</pre>

  <h2><span class="num">3</span>Batch and published root</h2>
  <table class="kv">
    <tbody>
      ${kvRow('Batch number', `<span class="mono">${esc(batch.batch)}</span>`)}
      ${kvRow('Entries covered', `<span class="mono">${esc(batch.fromSeq)}–${esc(batch.toSeq)}</span> (${esc(batch.count)} entries)`)}
      ${kvRow('Position of this entry', `<span class="mono">${index >= 0 ? esc(index) : 'unknown'}</span> of ${esc(batch.count)}`)}
      ${kvRow('Published Merkle root', `<span class="mono hash">${esc(batch.root)}</span>`)}
      ${kvRow('Recomputed Merkle root', `<span class="mono hash">${esc(recomputedRoot)}</span> ${statusPill(ctx.rootOk)}`)}
      ${kvRow('Root published at', `<span class="mono">${esc(batch.ts)}</span>`)}
      ${kvRow('Trackfoots / network', `<span class="mono">${esc(batch.chain || 'local ledger')}</span>`)}
      ${kvRow('Transaction hash', txCell)}
      ${kvRow('Contract address', address ? `<span class="mono hash">${esc(address)}</span>` : '<span class="small">not applicable — this anchor was written to the local ledger in offline mode</span>')}
    </tbody>
  </table>
  <p class="small">Recomputed root = Merkle root of the ${esc(ctx.leaves.length)} entry hashes currently on disk for
  batch ${esc(batch.batch)}. If it equals the published root, the batch is bit-for-bit what was witnessed.
  ${batch.txHash && !onChain ? 'Offline anchor mode: the transaction value above is a local commitment recorded in the ledger, not a public-chain transaction.' : ''}</p>

  <h2><span class="num">4</span>Merkle inclusion proof</h2>
  ${proofTable}

  <h2><span class="num">5</span>What this proof establishes</h2>
  <p class="note">${explanation}</p>

  <h2><span class="num">6</span>Verification checks performed when this bundle was generated</h2>
  <table>
    <thead><tr><th>Check</th><th>Result</th></tr></thead>
    <tbody>${checks}</tbody>
  </table>
  ${recoveredRoot ? `<p class="small">Root recovered from the proof: <span class="mono hash">${esc(recoveredRoot)}</span></p>` : ''}

  <div class="avoid">
  <h2><span class="num">7</span>How to verify independently</h2>
  <ol class="steps">
    <li>Recompute the entry hash: SHA-256 over
      <span class="mono">prevHash | seq | ts | actor | action | JSON(meta)</span>, joined with the
      <span class="mono">|</span> character. The result must equal <span class="mono hash">${esc(entry.hash)}</span>.
      Any change to the entry changes this value.</li>
    <li>Recompute the Merkle root of batch ${esc(batch.batch)}: take the ${esc(batch.count)} entry hashes in
      sequence order, hash each neighbouring pair with SHA-256 over the concatenation
      <span class="mono">left + right</span>, duplicating the last node on any odd level, and repeat until one
      value remains. It must equal <span class="mono hash">${esc(batch.root)}</span>.</li>
    <li>Walk the table in section 4 yourself: start with
      <span class="mono hash">${esc(entry.hash)}</span>, and for each row compute
      <span class="mono">SHA-256(current + sibling)</span> when the sibling is on the right, or
      <span class="mono">SHA-256(sibling + current)</span> when it is on the left. The final value must equal the
      published root.</li>
    <li>Confirm the published root was recorded outside the organisation's control: look up transaction
      <span class="mono hash">${esc(batch.txHash || '(none)')}</span> on the witness network
      (${esc(batch.chain || 'local ledger')})${address ? `, contract <span class="mono hash">${esc(address)}</span>` : ''},
      and check that the stored root matches. The ledger entry is dated ${esc(batch.ts)}; the block timestamp
      must not be later than the incident response timeline you are relying on.</li>
    <li>Repeat on the live system with the project's own verifier — it performs the same three checks over the
      whole log, not just this entry:
      <br><span class="mono">node cli.js verify</span>
      <br><span class="mono">node cli.js prove ${esc(seq)}</span></li>
    <li>Judge the document by its arithmetic, not by its letterhead. If steps 1–4 reproduce the published
      root, the entry above is genuine; if any step fails, the discrepancy is the finding and it should be
      reported as such.</li>
  </ol>
  </div>

  <div class="foot">
    Generated by TRACKFOOTS bundle exporter · ${esc(generatedAt)} · entry #${esc(seq)} · batch ${esc(batch.batch)} ·
    ${esc(ctx.entriesOnDisk)} entries readable on disk · this document is self-contained: it references no
    external stylesheet, script, image or font, and its contents do not change after printing.
  </div>

</div>
</body>
</html>
`;
}

/* ----------------------------------------------------------------- public */

/**
 * Render entry `seq` to exports/bundle-<seq>.html and return { path, html }.
 * Throws (with a readable message) if the entry or its batch does not exist.
 */
async function buildBundle(seq) {
  const n = Number(seq);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`invalid sequence number: ${seq}`);
    err.code = 'EBADSEQ';
    throw err;
  }
  const ctx = collect(n);
  const html = render(ctx);

  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const outPath = path.join(EXPORTS_DIR, `bundle-${n}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  return { path: outPath, html, included: ctx.included };
}

module.exports = { buildBundle, EXPORTS_DIR };
