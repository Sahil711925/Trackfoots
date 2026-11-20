#!/usr/bin/env node
'use strict';
/**
 * quai-faucet.js — claim Orchard testnet QUAI from QuaiDrop.
 *
 * The official faucet host (orchard.faucet.quai.network) no longer resolves. QuaiDrop serves the
 * same purpose behind an x402 "work" payment: instead of a captcha or an account, you pay by
 * solving a small SHA-256d puzzle. That is a real payment — it costs CPU, not money.
 *
 *   node scripts/quai-faucet.js [dropId]
 */
require('../lib/env');

const QUAI_ADDRESS = process.env.QUAI_ADDRESS || deriveQuaiAddress();
const URL = 'https://drops.quaidrop.xyz/api/claims/sponsored';

function deriveQuaiAddress() {
  const quais = require('quais');
  const w = new quais.Wallet(process.env.PRIVATE_KEY);
  const bytes = Buffer.from(w.address.slice(2), 'hex');
  // Quai address prefix: 9 bits = 4 region | 4 zone | 1 ledger. Cyprus-1 = region 0, zone 0,
  // ledger 0 (Quai). So byte 0 is 0x00 and bit 8 — the top bit of byte 1 — must be 0.
  bytes[0] = 0x00;
  bytes[1] = bytes[1] & 0x7f;
  return quais.formatMixedCaseChecksumAddress('0x' + bytes.toString('hex'));
}

(async () => {
  const dropId = String(process.argv[2] || '7263');
  const body = { dropId, claimer: QUAI_ADDRESS };

  console.log('claimer :', QUAI_ADDRESS);
  console.log('drop    :', dropId);
  console.log('paying  : solving SHA-256d proof of work (this is the faucet\'s price)…');

  const { payWithWork } = await import('x402-work-client');
  const out = await payWithWork(URL, body, { maxPrice: 500_000 });

  const text = await out.response.text();
  console.log('status  :', out.response.status);
  if (out.payment) {
    console.log('work    :', out.payment.profile, '·', out.payment.guesses, 'guesses ·', out.payment.milliseconds, 'ms');
  }
  console.log('body    :', text.slice(0, 400));
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
