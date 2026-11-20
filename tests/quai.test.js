'use strict';
/**
 * quai.test.js — the port has two traps that do not exist on Ethereum, and both are silent:
 * a wrong address prefix and a wrong SDK URL both look like "nothing happens".
 */
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const quai = require(path.join(REPO, 'lib', 'chain-quai.js'));
const quais = require('quais');

const KEY = '0x' + '11'.repeat(32);

test('derives a Quai address, not a Qi one', () => {
  const a = quai.quaiAddressFor(KEY);
  assert.equal(quais.isQuaiAddress(a), true, 'node rejects Qi addresses for account calls');
  assert.equal(quais.isQiAddress(a), false);
});

test('sets the 9-bit prefix: region 0, zone 0, ledger 0', () => {
  const b = Buffer.from(quai.quaiAddressFor(KEY).slice(2), 'hex');
  assert.equal(b[0], 0x00, 'byte 0 is region+zone');
  assert.equal(b[1] & 0x80, 0, 'bit 8 is the ledger bit: 0 = QUAI');
  assert.equal(b.length, 20);
});

test('only the routing prefix differs from the raw key address', () => {
  const qi = Buffer.from(new quais.Wallet(KEY).address.slice(2), 'hex');
  const q = Buffer.from(quai.quaiAddressFor(KEY).slice(2), 'hex');
  assert.deepEqual(q.slice(2), qi.slice(2), 'bytes 2..19 are the account itself');
  // byte 0 becomes the region/zone byte; byte 1 keeps its low 7 bits (bit 8 is the ledger bit)
  assert.equal(q[0], 0x00);
  assert.equal(q[1] & 0x7f, qi[1] & 0x7f);
});

test('networks are pinned to Quai chain ids and path-free RPCs', () => {
  assert.equal(quai.network('orchard').chainId, 15000);
  assert.equal(quai.network('mainnet').chainId, 9);
  // The SDK appends the zone path itself; a /cyprus1 suffix makes every request hang.
  assert.equal(quai.network('orchard').rpc.endsWith('/cyprus1'), false);
  assert.throws(() => quai.network('goerli'), /unknown Quai network/);
});

test('compiles LogAnchor with Quai\'s maximum compiler (0.8.20)', () => {
  const c = quai.compile();
  assert.match(c.solc, /^0\.8\.20/);
  assert.ok(c.bytecode.startsWith('0x60'), 'bytecode should be deployable');
  assert.ok(c.bytecode.length / 2 - 1 > 500, 'contract should be non-trivial');
  assert.ok(Array.isArray(c.abi) && c.abi.some((f) => f.name === 'anchor'));
});
