'use strict';
/**
 * receipts.js — signed write receipts.
 *
 * A receipt is what the auditor is handed the moment a line is written. It is only worth
 * anything if the attacker cannot mint one: if receipts are unsigned, a root-level intruder
 * simply writes his own receipt for a line that never existed, and the recovery step becomes
 * evidence laundering.
 *
 * So every receipt carries an HMAC-SHA256 tag over (seq ‖ chash ‖ ts).
 *
 * Where the key lives is the whole point. In this build it comes from RECEIPT_SECRET in the
 * environment — a stand-in for a KMS/HSM held outside the server. It is deliberately NOT
 * derived from anything in data/, so an attacker who owns the box and reads every file still
 * cannot forge receipts for content that was never written. If the key is absent we say so,
 * loudly, rather than pretending the receipts are authenticated.
 */
const crypto = require('crypto');
require('./env'); // the signing key lives in the environment, so load it here too

const ENV_KEY = 'RECEIPT_SECRET';

let ephemeral = null;

function secret() {
  const fromEnv = process.env[ENV_KEY];
  if (fromEnv && fromEnv.length >= 16) return { key: fromEnv, source: 'env', persistent: true };
  // No configured key: sign with a per-process key. Verification still works for the life of
  // this process, and the report tells the truth about what that is worth.
  if (!ephemeral) ephemeral = crypto.randomBytes(32).toString('hex');
  return { key: ephemeral, source: 'ephemeral', persistent: false };
}

function tagFor(receipt) {
  const { key } = secret();
  return crypto
    .createHmac('sha256', key)
    .update(`${receipt.seq}|${receipt.chash}|${receipt.ts}`)
    .digest('hex');
}

/** Attach a signature to a receipt before it is written. */
function sign(receipt) {
  return { ...receipt, sig: tagFor(receipt), sigAlg: 'hmac-sha256' };
}

/** Returns 'valid' | 'invalid' | 'unsigned'. */
function verify(receipt) {
  if (!receipt || !receipt.sig) return 'unsigned';
  const expected = tagFor(receipt);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(receipt.sig), 'hex');
  if (a.length !== b.length) return 'invalid';
  return crypto.timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

/** What the UI and the report say about receipt authentication. */
function status() {
  const s = secret();
  return {
    signed: true,
    algorithm: 'hmac-sha256',
    keySource: s.source,
    persistent: s.persistent,
    note: s.persistent
      ? 'key supplied by the environment (production: KMS/HSM, not the server disk)'
      : 'per-process key — receipts from earlier runs cannot be re-verified',
  };
}

/**
 * A receipt signed with the attacker's key instead of ours.
 * The demo uses this to show that possessing the log files is not enough to mint evidence —
 * verification rejects the signature even though every field looks right.
 */
function makeForged(receipt) {
  const bogus = crypto
    .createHmac('sha256', 'attacker-key-that-is-not-ours')
    .update(`${receipt.seq}|${receipt.chash}|${receipt.ts}`)
    .digest('hex');
  return { ...receipt, sig: bogus, sigAlg: 'hmac-sha256', forged: true };
}

module.exports = { sign, verify, status, tagFor, makeForged };
