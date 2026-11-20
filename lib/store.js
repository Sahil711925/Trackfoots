'use strict';
/**
 * store.js — where the log lives, and how each line is chained to the one before it.
 *
 * data/logs.jsonl            the "diary" — one JSON object per line. The attacker can edit this.
 * data/ledger.jsonl          the anchored fingerprints. In production these already exist on-chain.
 * data/auditor/receipts.jsonl receipts held OUTSIDE the server. The attacker never touches these.
 */
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./merkle');
const receipts = require('./receipts');

const DATA = process.env.WITNESS_DATA || path.join(__dirname, '..', 'data');
const LOGS = path.join(DATA, 'logs.jsonl');
const LEDGER = path.join(DATA, 'ledger.jsonl');
const RECEIPTS = path.join(DATA, 'auditor', 'receipts.jsonl');

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);

function ensure() {
  fs.mkdirSync(path.join(DATA, 'auditor'), { recursive: true });
  for (const f of [LOGS, LEDGER, RECEIPTS]) if (!fs.existsSync(f)) fs.writeFileSync(f, '');
}

/** The exact bytes that get hashed for one entry. Any change to any field changes this. */
function entryDigest(e, prevHash) {
  return sha256([prevHash, e.seq, e.ts, e.actor, e.action, JSON.stringify(e.meta || {})].join('|'));
}

/**
 * A receipt must identify the CONTENT, not the position.
 * Otherwise an attacker who deletes one line and renumbers the rest makes every
 * later receipt look "missing" — 1000 false positives for 34 real deletions.
 */
function contentDigest(e) {
  return sha256([e.ts, e.actor, e.action, JSON.stringify(e.meta || {})].join('|'));
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function readLogs() {
  return readLines(LOGS).map((line) => {
    try {
      return { ok: true, entry: JSON.parse(line) };
    } catch (err) {
      return { ok: false, raw: line, error: err.message };
    }
  });
}

function appendLog(entry) {
  ensure();
  const rows = readLines(LOGS);
  const prev = rows.length ? JSON.parse(rows[rows.length - 1]) : null;
  const prevHash = prev ? prev.hash : 'GENESIS';
  const full = { ...entry, seq: rows.length + 1, prevHash };
  full.chash = contentDigest(full);
  full.hash = entryDigest(full, prevHash);

  // The receipt is written to a DIFFERENT directory, standing in for a different machine.
  // It is signed, so the attacker cannot mint one for a line that was never written.
  const receipt = receipts.sign({ seq: full.seq, chash: full.chash, ts: full.ts });
  fs.appendFileSync(RECEIPTS, JSON.stringify(receipt) + '\n');
  fs.appendFileSync(LOGS, JSON.stringify(full) + '\n');
  return full;
}

/**
 * Bulk append — same chaining rules, one write instead of N.
 * Seeding 1,200 entries through appendLog re-reads the whole file every time.
 */
function appendMany(entries) {
  ensure();
  const rows = readLines(LOGS);
  let prevHash = rows.length ? JSON.parse(rows[rows.length - 1]).hash : 'GENESIS';
  let seq = rows.length;
  const logOut = [];
  const recOut = [];
  for (const e of entries) {
    seq += 1;
    const full = { ...e, seq, prevHash };
    full.chash = contentDigest(full);
    full.hash = entryDigest(full, prevHash);
    prevHash = full.hash;
    logOut.push(JSON.stringify(full));
    recOut.push(JSON.stringify(receipts.sign({ seq: full.seq, chash: full.chash, ts: full.ts })));
  }
  if (logOut.length) {
    fs.appendFileSync(LOGS, logOut.join('\n') + '\n');
    fs.appendFileSync(RECEIPTS, recOut.join('\n') + '\n');
  }
  return logOut.length;
}

function readLedger() {
  return readLines(LEDGER).map((l) => JSON.parse(l));
}

function appendLedger(batch) {
  ensure();
  fs.appendFileSync(LEDGER, JSON.stringify(batch) + '\n');
}

function readReceipts() {
  return readLines(RECEIPTS).map((l) => JSON.parse(l));
}

/**
 * Each demo run gets its own block of sequence numbers on the chain.
 * The contract refuses to overwrite an existing seq (that is the whole point),
 * so a reset must not try to re-anchor batch 3 into a slot it already filled.
 */
const RUNFILE = path.join(DATA, 'run.json');

function runBase() {
  ensure();
  if (!fs.existsSync(RUNFILE)) fs.writeFileSync(RUNFILE, JSON.stringify({ base: Date.now() }));
  return JSON.parse(fs.readFileSync(RUNFILE, 'utf8')).base;
}

module.exports = {
  DATA, LOGS, LEDGER, RECEIPTS, BATCH_SIZE,
  ensure, entryDigest, contentDigest, readLogs, appendLog, appendMany,
  readLedger, appendLedger, readReceipts, readLines, runBase,
};
