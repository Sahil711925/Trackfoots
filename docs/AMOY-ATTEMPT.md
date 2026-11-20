# Polygon Amoy deployment attempt — BLOCKED

**Verdict: NOT deployed to Amoy. Blocked by zero testnet balance.**

The Amoy RPC is live and reachable from this host. The contract compiles. The deployer key is valid.
The transaction was built, signed and broadcast — and the node rejected it because the account holds
**0 POL** and cannot pay gas.

No Amoy entry was added to `deployments.json` (it still contains only `local`), because writing one
without a real contract address would be a lie.

Attempt date: 2026-11-20. Duration: ~20 min. Nothing about the running demo was touched.

---

## 1. RPC reachability — WORKS

```
$ curl -s -m 20 -X POST https://polygon-amoy-bor-rpc.publicnode.com \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
{"jsonrpc":"2.0","result":"0x13882","id":1}
```

`0x13882` = **80002** — correct Polygon Amoy chain id.

Note: `https://rpc-amoy.polygon.technology` (the endpoint named in Polygon's own docs) still does
**not resolve** from this host:

```
$ curl -s -o /dev/null -m 12 -w '%{http_code}' https://rpc-amoy.polygon.technology
000   (curl exit 6, could not resolve host)
```

Also unresolvable from here: `api.faucet.polygon.technology`, `faucet.polygonscan.com`
(both curl exit 6). `polygon-amoy-bor-rpc.publicnode.com` works, so `publicnode` is the endpoint to use.

## 2. Deployer balance — ZERO

Address: `0xc2A64B068893B74b0142810AA0a402D73F751561` (derived from the existing `PRIVATE_KEY`; the key
itself was never printed, echoed, or copied anywhere).

```
deployer  : 0xc2A64B068893B74b0142810AA0a402D73F751561
chainId   : 80002
blockNumber: 53367965
balanceWei: 0
balancePOL: 0.0
```

Re-checked after all faucet attempts (`blockNumber: 53368110`, i.e. the chain advanced ~145 blocks
while we worked — so the chain is fully live):

```
balanceWei: 0
balancePOL: 0.0
```

## 3. Deployment attempt — REJECTED BY NODE

Command (the `WITNESS_TEST=1` is required — see the gotcha in §5):

```
$ WITNESS_TEST=1 CHAIN=amoy RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com \
    node scripts/deploy.js
compiling + deploying LogAnchor…
```

The compile succeeded and the tx was signed, then:

```
Error: insufficient funds for intrinsic transaction cost
  code=INSUFFICIENT_FUNDS
  info: { error: { code: -32000,
    message: 'insufficient funds for gas * price + value:
              balance 0, tx cost 6904260047409252, overshot 6904260047409252' } }
```

`6904260047409252` wei = **0.006904260047409252 POL** — that is the entire amount missing.
A faucet drip of 0.1 POL (what Alchemy advertises) would be 14x more than needed.

`deployments.json` after the failure: keys are still exactly `["local"]`. Nothing was written.

## 4. Faucets — all three refused for reasons we are not allowed to bypass

| # | Endpoint | Result | Literal response |
|---|----------|--------|------------------|
| 1 | `POST https://faucet.polygon.technology/api/v1/faucet` | 403 | `<title>Just a moment...</title>` — Cloudflare Turnstile/JS challenge page (captcha) |
| 2 | `POST https://www.alchemy.com/api/faucet/claim` | 404 | `{"error":{"code":"not_found","message":"No endpoint matches POST /api/faucet/claim."...}}` |
| 3 | `POST https://www.alchemy.com/api/faucets/polygon-amoy/send` | 400 | `{"error":"CAPTCHA verification is required","statusCode":"missing_turnstile","hint":"Include turnstileToken from the faucet page for this network. There is no server-to-server credential for this endpoint."}` |
| — | `POST https://faucet.chainstack.com/api/claim` | 200 | Returned the faucet's HTML page, not a JSON API (no machine endpoint) |

Attempt 3 is the real Alchemy endpoint (found via `https://www.alchemy.com/openapi.json`). Its own
description says it needs a Cloudflare Turnstile token from the browser page, "there is no
server-to-server credential", and that requests are subject to **anti-sybil checks against mainnet
balance and activity**. QuickNode's faucet documents the same mainnet-balance requirement. The
official Polygon faucet wants Sepolia ETH as anti-abuse.

So: every keyless path is closed by a captcha and/or a mainnet balance we do not have. Per the run
rules we did not sign up, did not use social login, and did not attempt to solve a captcha.

## 5. Gotcha worth knowing before anyone retries

`lib/env.js` puts `CHAIN`, `RPC_URL`, `ANCHOR_ON_CHAIN`, `WITNESS_DATA`, `PRIVATE_KEY` in a
`FORCE_FROM_FILE` set: it **overrides shell env vars from `.env`** to stop a stray inherited
`WITNESS_DATA`/`ANCHOR_ON_CHAIN` from silently disabling anchoring. `.env` currently says
`CHAIN=local` / `RPC_URL=http://127.0.0.1:8545`, so

```
CHAIN=amoy RPC_URL=... node scripts/deploy.js     # BROKEN — env.js resets CHAIN to local
WITNESS_TEST=1 CHAIN=amoy RPC_URL=... node ...    # WORKS — TEST_MODE skips the forcing
```

The `WITNESS_TEST=1` prefix is the only way to override without editing `.env` (which we were told
not to touch).

## 6. What actually is proven, and on what chain

The contract is deployed and anchored **on the local ganache (chainId 31337)**, and that is real
on-chain state — just not a public one:

```
$ CHAIN=local node scripts/verify-chain.js
  contract 0x93C6b8B06Ab9FFeAa46Cdcb39ea9A0E43a2949b3
  network  local
  batch   1  ✓ matches chain  e5c09eac7f3480bff4…
  ... (batches 1-12) ...
  batch  12  ✓ matches chain  090819b30c0cf4b762…

  12 match, 0 differ
```

That command reads `rootOf(seq)` back **from the chain** and compares it to the ledger — it is the
same code path that will run against Amoy, unchanged, the moment the account has gas.

## 7. What a judge should be told

Say exactly this:

> The anchoring contract is deployed and verified on a local Ethereum-compatible chain
> (ganache, chainId 31337, `0x93C6b8B06Ab9FFeAa46Cdcb39ea9A0E43a2949b3`); 12 of 12 anchored roots
> read back from that chain match the ledger. The Polygon Amoy deployment path is implemented and
> was exercised end to end: the Amoy RPC answers (chainId 80002), the contract compiles, the
> transaction is signed and broadcast — but the funded-wallet requirement could not be met, because
> every public Amoy faucet now requires a captcha and/or a mainnet balance, so the node rejected the
> deployment with `insufficient funds ... balance 0, tx cost 0.0069 POL`. Switching to Amoy is a
> config change plus a funded key: `WITNESS_TEST=1 CHAIN=amoy node scripts/deploy.js`.

Do **not** claim an Amoy address. There isn't one.

## 8. Reproduce in ~2 minutes once the account has POL

```bash
cd C:/Users/sahil/Documents/bighack/witness
export NODE=C:/Users/sahil/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe

# 1. confirm funds arrived (need >= 0.007 POL)
WITNESS_TEST=1 CHAIN=amoy $NODE -e "...getBalance(...)"

# 2. deploy (writes an 'amoy' key into deployments.json, leaves 'local' alone)
WITNESS_TEST=1 CHAIN=amoy RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com \
  $NODE scripts/deploy.js

# 3. anchor one checkpoint + read the root back off Amoy
WITNESS_TEST=1 CHAIN=amoy WITNESS_DATA=<temp dir> ANCHOR_ON_CHAIN=true \
  $NODE scripts/anchor.js
WITNESS_TEST=1 CHAIN=amoy WITNESS_DATA=<temp dir> $NODE scripts/verify-chain.js
# expect: "N match, 0 differ"
```

Anchor against a throwaway `WITNESS_DATA` dir, never the demo's `data/`, so the presentation ledger
is not disturbed.
