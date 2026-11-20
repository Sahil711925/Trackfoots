'use strict';
/**
 * attack.js (lib) — plays the intruder.
 *   naive : deletes and edits, leaves hashes alone  -> caught by the chain
 *   smart : also recomputes every hash              -> caught only by the published root
 */
const fs = require('fs');
const store = require('./store');

const INCIMINATING = new Set(['sudo su', 'cat /etc/passwd', 'DELETE /api/orders/1182', 'login failed']);

function attack(mode = 'naive', batchNo = 3) {
  const rows = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  if (!rows.length) throw new Error('no logs to attack — seed first');

  const ledger = store.readLedger();
  const target = ledger.find((b) => b.batch === Number(batchNo));
  if (!target) throw new Error(`batch ${batchNo} is not anchored yet`);

  const inRange = (e) => e.seq >= target.fromSeq && e.seq <= target.toSeq;
  const victims = rows.filter(inRange);
  const keep = new Set(victims.filter((_, i) => i % 3 !== 0).map((e) => e.seq));
  const deleted = victims.length - keep.size;

  let edited = 0;
  let out = rows
    .filter((e) => !inRange(e) || keep.has(e.seq))
    .map((e) => {
      if (inRange(e) && INCIMINATING.has(e.action)) {
        edited += 1;
        return { ...e, action: 'login success' };
      }
      return e;
    });

  if (mode === 'smart') {
    let prevHash = 'GENESIS';
    out = out.map((e, i) => {
      const fixed = { ...e, seq: i + 1, prevHash };
      fixed.hash = store.entryDigest(fixed, prevHash);
      prevHash = fixed.hash;
      return fixed;
    });
  }

  fs.writeFileSync(store.LOGS, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { mode, batch: target.batch, fromSeq: target.fromSeq, toSeq: target.toSeq, deleted, edited, remaining: out.length };
}

module.exports = { attack };
