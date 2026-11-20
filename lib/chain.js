'use strict';
/**
 * chain.js — everything that talks to the public chain.
 *
 * Default network: Polygon Amoy testnet (free, real, public).
 * Set CHAIN=local to talk to a local node instead (the rules explicitly allow a local blockchain).
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const CONTRACT_SRC = path.join(ROOT, 'contracts', 'LogAnchor.sol');
const DEPLOYMENT = path.join(ROOT, 'deployments.json');

const NETWORKS = {
  amoy: { rpc: process.env.RPC_URL || 'https://polygon-amoy-bor-rpc.publicnode.com', chainId: 80002, explorer: 'https://amoy.polygonscan.com' },
  local: { rpc: process.env.RPC_URL || 'http://127.0.0.1:8545', chainId: 31337, explorer: null },
};
const NET = NETWORKS[process.env.CHAIN || 'amoy'];

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'LogAnchor.sol': { content: fs.readFileSync(CONTRACT_SRC, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['LogAnchor.sol'].LogAnchor;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

function provider() {
  // fast polling: the demo reset must not take 18 seconds
  return new ethers.JsonRpcProvider(NET.rpc, NET.chainId, { staticNetwork: true, pollingInterval: 150 });
}

function readDeployment() {
  if (!fs.existsSync(DEPLOYMENT)) return null;
  const d = JSON.parse(fs.readFileSync(DEPLOYMENT, 'utf8'));
  return d[process.env.CHAIN || 'amoy'] || null;
}

function writeDeployment(net, data) {
  const all = fs.existsSync(DEPLOYMENT) ? JSON.parse(fs.readFileSync(DEPLOYMENT, 'utf8')) : {};
  all[net] = data;
  fs.writeFileSync(DEPLOYMENT, JSON.stringify(all, null, 2));
}

async function deploy(privateKey) {
  const { abi, bytecode } = compile();
  const wallet = new ethers.Wallet(privateKey, provider());
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  writeDeployment(process.env.CHAIN || 'amoy', {
    address,
    abi,
    network: process.env.CHAIN || 'amoy',
    deployTx: tx.hash,
    deployedAt: new Date().toISOString(),
  });
  return { address, txHash: tx.hash };
}

function readContract() {
  const d = readDeployment();
  if (!d) throw new Error('contract not deployed — run: npm run deploy');
  return new ethers.Contract(d.address, d.abi, provider());
}

async function anchor(root, seq) {
  const d = readDeployment();
  if (!d) throw new Error('contract not deployed — run: npm run deploy');
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error('PRIVATE_KEY not set');
  const contract = new ethers.Contract(d.address, d.abi, new ethers.Wallet(key, provider()));
  const bytes32 = root.startsWith('0x') ? root : `0x${root}`; // merkleRoot returns bare hex
  const tx = await contract.anchor(seq, bytes32, process.env.ORG || 'WITNESS demo');
  const receipt = await tx.wait();
  return { txHash: receipt.hash, block: receipt.blockNumber, explorer: d.explorer || NET.explorer };
}

async function readRoot(seq) {
  return readContract().rootOf(seq);
}

function explorerUrl(txHash) {
  const d = readDeployment();
  return d?.explorer || NET.explorer ? `${d?.explorer || NET.explorer}/tx/${txHash}` : null;
}

module.exports = { compile, deploy, anchor, readRoot, readDeployment, explorerUrl, NET, provider };
