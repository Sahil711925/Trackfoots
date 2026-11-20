'use strict';
/**
 * chain-quai.js — the Quai Network half of the anchoring layer.
 *
 * Quai is EVM-compatible but not Ethereum-shaped. Two things bite anyone porting ethers code:
 *
 *   1. ADDRESSES CARRY ROUTING. The first 9 bits are region (4) | zone (4) | ledger (1). Cyprus-1
 *      is region 0, zone 0, ledger 0 for QUAI — so a Cyprus-1 Quai address starts 0x00 with the
 *      top bit of the second byte cleared. Derive the Ethereum-style address from a key and the
 *      node will reject it: "expected Quai address, but found Qi address".
 *   2. THE SDK IS FORKED. `quais` is ethers v6 adapted for Quai's Protobuf transaction encoding.
 *      ethers.js cannot sign these transactions.
 *
 * This module does the address derivation, compiles against solc 0.8.20 (Quai's maximum), and
 * exposes deploy/anchor/read through quais so the rest of the product does not care.
 */
const fs = require('fs');
const path = require('path');
const quais = require('quais');
const solcQ = require('solc-quai'); // pinned 0.8.20 — Quai does not accept newer bytecode

const ROOT = path.join(__dirname, '..');

const NETWORKS = {
  orchard: {
    name: 'Quai Orchard Testnet (Cyprus-1)',
    chainId: 15000,
    // Base URL only: the SDK appends the zone path when usePathing is set. Passing the
    // /cyprus1 path here as well makes every request hang.
    rpc: 'https://orchard.rpc.quai.network',
    explorer: 'https://orchard.quaiscan.io',
    faucet: 'https://testnet.quaidrop.xyz',
  },
  mainnet: {
    name: 'Quai Mainnet (Cyprus-1)',
    chainId: 9,
    rpc: 'https://rpc.quai.network',
    explorer: 'https://quaiscan.io',
    faucet: null,
  },
};

/**
 * Ethereum-style key → Cyprus-1 Quai address.
 * Quai sets the 9-bit shard prefix on top of the same 20-byte hash, so the account bytes are the
 * key's own; only the routing prefix is rewritten.
 */
function quaiAddressFor(privateKey) {
  const w = new quais.Wallet(privateKey);
  const bytes = Buffer.from(w.address.slice(2), 'hex');
  bytes[0] = 0x00;          // region 0, zone 0
  bytes[1] = bytes[1] & 0x7f; // ledger bit = 0 → QUAI, not Qi
  return quais.formatMixedCaseChecksumAddress('0x' + bytes.toString('hex'));
}

function network(name) {
  const key = String(name || 'orchard').toLowerCase();
  const net = NETWORKS[key];
  if (!net) throw new Error(`unknown Quai network: ${name} (use orchard | mainnet)`);
  return net;
}

function provider(netName) {
  return new quais.JsonRpcProvider(network(netName).rpc, undefined, { usePathing: true });
}

function wallet(privateKey, netName) {
  return new quais.Wallet(privateKey, provider(netName));
}

/** Compile LogAnchor.sol with the Quai-pinned compiler. */
function compile() {
  const src = fs.readFileSync(path.join(ROOT, 'contracts', 'LogAnchor.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'LogAnchor.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solcQ.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['LogAnchor.sol'].LogAnchor;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, solc: solcQ.version() };
}

function readDeployment(netName) {
  const file = path.join(ROOT, 'deployments.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[netName] || null;
  } catch {
    return null;
  }
}

function saveDeployment(netName, record) {
  const file = path.join(ROOT, 'deployments.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[netName] = { ...(all[netName] || {}), ...record, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return all[netName];
}

/** Price the deployment without spending anything. Works with a zero balance. */
async function estimateDeploy(privateKey, netName = 'orchard') {
  const net = network(netName);
  const p = provider(netName);
  const addr = quaiAddressFor(privateKey);
  const { bytecode, abi, solc } = compile();
  const factory = new quais.ContractFactory(abi, bytecode);
  const tx = await factory.getDeployTransaction();
  let gasEstimate = null;
  let estimateError = null;
  try {
    gasEstimate = (await p.estimateGas({ from: addr, data: tx.data })).toString();
  } catch (err) {
    estimateError = err.shortMessage || err.message;
  }
  const balance = await p.getBalance(addr);
  return { network: net, address: addr, balance: balance.toString(), gasEstimate, estimateError, solc, bytecodeBytes: bytecode.length / 2 - 1 };
}

/** Deploy the anchor contract and record it in deployments.json under the network name. */
async function deploy(privateKey, netName = 'orchard') {
  const net = network(netName);
  const w = wallet(privateKey, netName);
  const { abi, bytecode } = compile();
  const factory = new quais.ContractFactory(abi, bytecode, w);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const record = { address, abi, chainId: net.chainId, network: net.name, deployedAt: new Date().toISOString(), explorer: `${net.explorer}/address/${address}` };
  saveDeployment(netName, record);
  return record;
}

async function anchor(seq, root, org, netName = 'orchard', privateKey = process.env.PRIVATE_KEY) {
  const dep = readDeployment(netName);
  if (!dep) throw new Error(`nothing deployed on ${netName} — run: npm run quai:deploy`);
  const c = new quais.Contract(dep.address, dep.abi, wallet(privateKey, netName));
  const tx = await c.anchor(seq, root, org);
  const receipt = await tx.wait();
  return { txHash: receipt.hash || tx.hash, explorer: `${network(netName).explorer}/tx/${receipt.hash || tx.hash}` };
}

async function readRoot(seq, netName = 'orchard') {
  const dep = readDeployment(netName);
  if (!dep) throw new Error(`nothing deployed on ${netName}`);
  const c = new quais.Contract(dep.address, dep.abi, provider(netName));
  return c.rootOf(seq);
}

module.exports = {
  NETWORKS, network, provider, wallet, quaiAddressFor, compile,
  deploy, estimateDeploy, anchor, readRoot, readDeployment, saveDeployment,
};
