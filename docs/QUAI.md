# Quai Network integration — status

Quai Network is the hackathon's chain. This is what is wired, what is proven, and what is left.

---

## What is implemented

| File | What it does |
|---|---|
| `lib/chain-quai.js` | Quai adapter: 9-bit address derivation, Orchard/Mainnet networks, compile with solc **0.8.20**, deploy, anchor, read a root back |
| `scripts/quai-deploy.js` | `npm run quai:check` prices the deployment without spending; `npm run quai:deploy` deploys and records it in `deployments.json` under `quai` |
| `scripts/quai-faucet.js` | Claims testnet QUAI from QuaiDrop by solving its x402 proof-of-work (85 guesses, ~3 s) |
| `tests/quai.test.js` | 5 tests: address type, 9-bit prefix bits, account bytes preserved, chain ids, 0.8.20 bytecode |

## Two traps that are specific to Quai

**1. Addresses carry routing.** The first 9 bits are `region (4) | zone (4) | ledger (1)`.
Cyprus-1 QUAI is region 0, zone 0, ledger 0 — byte 0 is `0x00` and **bit 8 (top bit of byte 1) is 0**.
Derive an Ethereum address from the same key and the node answers:

```
expected Quai address, but found Qi address: 0xc2A64B068893B74b0142810AA0a402D73F751561
```

Our derivation produces, from the same key:

```
Quai address   0x00264b068893b74B0142810aa0A402d73f751561
isQuaiAddress  true
```

**2. The SDK is a fork and the RPC URL is a trap.** `quais` is ethers v6 adapted for Quai's Protobuf
transactions; ethers cannot sign them. And the provider must get the **base** URL with
`{ usePathing: true }` — passing `…/cyprus1` as well makes every call hang with no error:

```js
new quais.JsonRpcProvider('https://orchard.rpc.quai.network', undefined, { usePathing: true })
```

## Verified against the live chain

```
network    Quai Orchard Testnet (Cyprus-1) · chainId 15000
rpc        https://orchard.rpc.quai.network          (block height 1,878,006 and advancing)
account    0x00264b068893b74B0142810aa0A402d73f751561
balance    0 wei
compiler   0.8.20+commit.a1b79de6 · 853 byte contract
gas (est)  333698      ← the node decoded and priced our deploy transaction
```

The gas estimate matters: it means Quai's node parsed the signed transaction shape, accepted the
contract bytecode, and priced it. The only thing missing is the balance.

## Blocked on testnet funds — the faucet moved

| Source | Result |
|---|---|
| `orchard.faucet.quai.network` (named in the official docs) | **NXDOMAIN** — the host no longer exists, confirmed via DNS-over-HTTPS (status 3), not a local resolver problem |
| `faucet.quai.network`, `orchard.quai.network` | also NXDOMAIN |
| `testnet.quaidrop.xyz` (third-party, live) | Answers, but a claim needs a **drop id**: `dropId 7263` → `{"error":"Drop is not claimable","creator":"0x0000…"}`. The API never lists public drops (`/api/drops` requires a `creator`) |

The x402 proof-of-work payment itself works — we solved a job in 85 guesses / 3.2 s and the claim
endpoint accepted the payment before rejecting the drop id. So the blocker is one missing link,
not a broken integration.

## Finishing it in three steps

1. Get a live drop link from the organisers (QuaiSquad / Quai Discord) — it looks like
   `https://testnet.quaidrop.xyz/<dropId>`.
2. `npm run quai:faucet -- <dropId>` — pays the proof-of-work and sends testnet QUAI to the account above.
3. `npm run quai:deploy` — deploys, writes `deployments.json.quai`, prints the Quaiscan link.
   Then `node scripts/quai-deploy.js --anchor 1` writes one checkpoint on Quai.

## What to say to a judge

> "The contract compiles under Quai's 0.8.20 ceiling and deploys through the `quais` SDK with
> zone-correct addresses — the node priced our deployment at 333,698 gas. We could not fund the
> testnet account: the faucet host in Quai's own docs no longer resolves, and the third-party
> replacement needs a drop link. The faucet's proof-of-work payment works — we paid it. It is one
> link away from a live deployment, and the demo itself runs on a local EVM."
