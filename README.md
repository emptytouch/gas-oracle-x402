# gas-oracle-x402

Multi-chain **gas oracle** (EIP-1559 fee market) behind [x402](https://x402.org) on the Kite chain.

It wraps **public JSON-RPC endpoints** — no API key, no upstream account, no
rate-limited third-party service — and turns them into a paid, agent-friendly
HTTP API settled in pieUSD on Kite testnet (`eip155:2368`).

Live: `https://gas-oracle-x402.onrender.com`

## Why pay for a free RPC?

The upstream is free, so the honest answer is **what gets added on top**:

1. **Real EIP-1559 handling.** Most "gas price" APIs just proxy `eth_gasPrice`,
   a single lagging legacy number. This service uses `eth_feeHistory` to return
   the **next block's base fee** plus **priority-fee percentiles (p10/p50/p90)**
   averaged over several blocks — which removes the single-block noise a
   MEV-heavy block introduces. That is the number a wallet should actually bid.
2. **Server-side computation.** `POST /v1/estimate` turns a gas limit into a
   concrete cost per speed (slow/normal/fast) in both wei and the native token.
3. **Multi-chain in one call.** One request fans out to Ethereum, Base, Arbitrum,
   Optimism, Polygon and Kite — no per-chain client setup.
4. **Production hardening.** Upstream timeouts, per-chain failure isolation,
   a read-through cache, per-client rate limiting, CORS and structured logs.

## Endpoints

| Method | Path | Tier | Price | What it returns |
| --- | --- | --- | --- | --- |
| GET | `/v1/gas` | standard | $0.001 | Current snapshot per chain: block, base fee, **next** base fee, priority percentiles, all-in total per speed |
| GET | `/v1/history` | premium | $0.01 | EIP-1559 fee series over N blocks: base fee + priority percentiles per block |
| POST | `/v1/estimate` | premium | $0.01 | Cost of one transaction at each speed (wei + native token) |
| GET | `/healthz` | free | — | Network, asset, payTo, chain list, tiers, endpoint catalogue, uptime |

### `GET /v1/gas?chains=ethereum,base`

```json
{
  "chains": {
    "ethereum": {
      "label": "Ethereum",
      "nativeSymbol": "ETH",
      "blockNumber": 23123456,
      "baseFeeGwei": 1.02,
      "nextBaseFeeGwei": 1.11,
      "priorityGwei": { "slow": 0.05, "normal": 0.12, "fast": 0.31 },
      "totalGwei":    { "slow": 1.16, "normal": 1.23, "fast": 1.42 },
      "baseFeeWei": "1020000000",
      "nextBaseFeeWei": "1110000000",
      "priorityWei":  { "slow": "50000000", "normal": "120000000", "fast": "310000000" },
      "totalWei":     { "slow": "1160000000", "normal": "1230000000", "fast": "1420000000" }
    }
  },
  "count": 1,
  "missing": [],
  "failed": [],
  "snapshotBlocks": 5,
  "updatedAt": 1790000000000
}
```

Exact `*_Wei` values are returned next to the gwei figures on purpose: Optimism
and Base sometimes quote a base fee of only a few hundred wei, and a rounded
gwei number alone would read as `0` — which looks like free gas.

### `GET /v1/history?chains=ethereum&blocks=20`

Returns parallel arrays (`blockNumbers`, `baseFeeGwei`, `priorityGwei.slow|normal|fast`)
so a client can chart the fee market or decide whether to wait.

### `POST /v1/estimate`

```bash
curl -X POST https://gas-oracle-x402.onrender.com/v1/estimate \
  -H 'content-type: application/json' \
  -d '{"chain":"ethereum","gasLimit":21000}'
```

```json
{
  "chain": "ethereum",
  "nativeSymbol": "ETH",
  "gasLimit": 21000,
  "nextBaseFeeGwei": 2,
  "speeds": {
    "slow":   { "totalGwei": 2.1, "costWei": "44100000000000", "costNative": 0.0000441 },
    "normal": { "totalGwei": 3.0, "costWei": "63000000000000", "costNative": 0.000063 },
    "fast":   { "totalGwei": 4.0, "costWei": "84000000000000", "costNative": 0.000084 }
  }
}
```

## Chains

| id | Chain | Native | RPC |
| --- | --- | --- | --- |
| `ethereum` | Ethereum | ETH | `ethereum-rpc.publicnode.com` |
| `base` | Base | ETH | `mainnet.base.org` |
| `arbitrum` | Arbitrum One | ETH | `arbitrum-one-rpc.publicnode.com` |
| `optimism` | OP Mainnet | ETH | `optimism-rpc.publicnode.com` |
| `polygon` | Polygon PoS | POL | `polygon-bor-rpc.publicnode.com` |
| `kite` | Kite | KITE | `rpc.gokite.ai` |
| `kite-testnet` | Kite Testnet | KITE | `rpc-testnet.gokite.ai` |

Override any endpoint with `RPC_URL_<CHAIN_ID>` (uppercase, `-` → `_`), or restrict
the registry with `CHAINS=ethereum,base,kite-testnet`.

## Run it locally

```bash
npm install
cp .env.example .env      # set PAY_TO to your Kite wallet
npm run dev               # http://localhost:8080/healthz
```

`PAY_TO` is required — the service refuses to start without the address that
receives payments.

## Paying for a call

Unpaid requests get `402` + a `payment-required` challenge. Pay with any x402
client, or use the bundled self-pay script:

```bash
export BUYER_PRIVATE_KEY=0x<kite-testnet-key-holding-pieUSD>
BASE_URL=https://gas-oracle-x402.onrender.com npm run selfpay
QUOTE_ENDPOINT=estimate EST_CHAIN=ethereum EST_GAS_LIMIT=21000 npm run selfpay
npm run proof            # writes the settlement tx hashes into PROOF.md
```

See [PROOF.md](./PROOF.md) for verified on-chain settlements.

## Tests

```bash
npm run typecheck
npm test
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAY_TO` | — (required) | Kite wallet that receives payments |
| `KITE_NETWORK` | `testnet` | `testnet` (pieUSD) or `mainnet` (USDC.e) |
| `PRICE_USD` | `0.001` | Standard tier (`GET /v1/gas`) |
| `PRICE_USD_PREMIUM` | `0.01` | Premium tier (`history`, `estimate`) |
| `RATE_LIMIT_PER_MIN` | `10` | Paid calls per client per minute; `0` disables |
| `RPC_TIMEOUT_MS` | `9000` | Hard timeout per JSON-RPC call |
| `MAX_CHAINS` | `10` | Max chains per request |
| `SNAPSHOT_BLOCKS` | `5` | Blocks sampled to smooth the percentiles |
| `MAX_HISTORY_BLOCKS` | `100` | Upper bound on `history?blocks=` |
| `PORT` | `8080` | Render injects this |

## Design notes

- **Payment happens per request.** The server-side cache only reduces upstream
  RPC traffic; it never lets a client skip a payment. Paid `200` responses are
  sent with `Cache-Control: no-store` so a client can't replay one.
- **Per-chain failure isolation.** One dead RPC does not fail the whole request;
  failures are reported in a `failed` array. If *every* requested chain fails,
  the response is `502` rather than a `200` with an empty payload.
- **Explicit routes only.** Payment routes are registered as exact
  `"METHOD /path"` keys — there is no `/v1/*` catch-all, because x402 matches
  with `.find()` and a catch-all would silently misprice specific routes.
