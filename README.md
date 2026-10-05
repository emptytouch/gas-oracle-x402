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
   concrete cost per speed (slow/normal/fast) in wei, the native token **and USD**.
3. **An actionable recommendation, not just numbers.** Every chain also carries
   `advice`: where the next base fee sits inside the recent window (percentile),
   whether the window is rising or falling, a `send_now` / `wait` call, and ready
   to use `maxFeePerGas` / `maxPriorityFeePerGas` values that stay valid for
   ~6 blocks while the sender still only pays the real base fee.
4. **Signals that ride along for free.** `congestion` (mean block fullness) and
   `blobBaseFeeGwei` (EIP-4844) come from the same `eth_feeHistory` response —
   no extra RPC round trip, no extra charge.
5. **Multi-chain in one call.** One request fans out to Ethereum, Base, Arbitrum,
   Optimism, Polygon and Kite — **in parallel**, so one slow node can't serialise
   the request, and a dead node doesn't fail the rest.
6. **Production hardening.** Upstream timeouts, per-chain failure isolation,
   a read-through cache, per-client rate limiting, CORS and structured logs.

## Endpoints

| Method | Path | Tier | Price | What it returns |
| --- | --- | --- | --- | --- |
| GET | `/v1/gas` | standard | $0.001 | Current snapshot per chain: block, base fee, **next** base fee, priority percentiles, all-in total per speed, congestion, blob fee, `advice` |
| GET | `/v1/history` | premium | $0.01 | EIP-1559 fee series over N blocks + per-block fullness + a `summary` (min/median/max/mean, trend, cheapest block) |
| POST | `/v1/estimate` | premium | $0.01 | Cost of one transaction at each speed (wei + native token + USD when priced) |
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
      "totalWei":     { "slow": "1160000000", "normal": "1230000000", "fast": "1420000000" },
      "congestion": 0.63,
      "blobBaseFeeGwei": 0.0081,
      "advice": {
        "windowBlocks": 5,
        "currentBaseFeeGwei": 1.11,
        "minGwei": 0.94, "medianGwei": 1.05, "maxGwei": 1.2, "meanGwei": 1.06,
        "percentile": 70.0,
        "trend": "rising",
        "recommendation": "wait",
        "suggestedMaxFeePerGasGwei":          { "slow": 2.27, "normal": 2.34, "fast": 2.53 },
        "suggestedMaxPriorityFeePerGasGwei":  { "slow": 0.05, "normal": 0.12, "fast": 0.31 }
      }
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

`congestion` is the mean block fullness over the sample (0 = empty, 1 = at the
gas limit). `blobBaseFeeGwei` is `null` when the chain has no blob market —
notably Base and OP Mainnet answer `baseFeePerBlobGas: 0x1` (1 wei, the
EIP-4844 floor), which is reported as "not applicable" rather than `1e-9 gwei`.

### `GET /v1/history?chains=ethereum&blocks=20`

Returns parallel arrays (`blockNumbers`, `baseFeeGwei`, `priorityGwei.slow|normal|fast`,
`gasUsedRatio`) so a client can chart the fee market, plus a `summary` that names
the cheapest block in the window and the direction fees are heading:

```json
{
  "blocks": 20,
  "chains": {
    "ethereum": {
      "blockNumbers": [23123437, 23123438, 23123439, 23123440],
      "baseFeeGwei": [1.02, 0.98, 1.05, 1.01],
      "priorityGwei": {
        "slow":   [0.05, 0.04, 0.05, 0.04],
        "normal": [0.12, 0.11, 0.12, 0.11],
        "fast":   [0.31, 0.28, 0.31, 0.30]
      },
      "gasUsedRatio": [0.74, 0.51, 0.63, 0.49],
      "blobBaseFeeGwei": 0.0081,
      "summary": {
        "min": 0.98,
        "median": 1.015,
        "max": 1.05,
        "mean": 1.015,
        "trend": "falling",
        "cheapestBlockNumber": 23123438,
        "cheapestBaseFeeGwei": 0.98
      }
    }
  },
  "count": 1,
  "missing": [],
  "failed": [],
  "updatedAt": 1790000000000
}
```

### `POST /v1/estimate`

```bash
curl -X POST https://gas-oracle-x402.onrender.com/v1/estimate \
  -H 'content-type: application/json' \
  -d '{"chain":"ethereum","gasLimit":21000}'
```

```json
{
  "chain": "ethereum",
  "label": "Ethereum",
  "nativeSymbol": "ETH",
  "gasLimit": 21000,
  "blockNumber": 23123456,
  "baseFeeGwei": 1.02,
  "nextBaseFeeGwei": 2,
  "priorityGwei": {
    "slow": 0.1,
    "normal": 1,
    "fast": 2
  },
  "nativeUsdPrice": 2500,
  "speeds": {
    "slow":   { "totalGwei": 2.1, "costWei": "44100000000000", "costNative": 0.0000441, "costUsd": 0.11025 },
    "normal": { "totalGwei": 3.0, "costWei": "63000000000000", "costNative": 0.000063,  "costUsd": 0.1575 },
    "fast":   { "totalGwei": 4.0, "costWei": "84000000000000", "costNative": 0.000084,  "costUsd": 0.21 }
  }
}
```

`costUsd` is best-effort: if the price upstream is unreachable, or the chain has
no public price feed (Kite), `nativeUsdPrice` is `null` and `costUsd` is omitted —
the native-token cost is still returned, and the request still succeeds. That is
deliberate: the client already paid, so an optional enrichment must never fail it.

A degraded response (Kite, no public price) looks like:

```json
{
  "chain": "kite",
  "label": "Kite",
  "nativeSymbol": "KITE",
  "gasLimit": 21000,
  "blockNumber": 22041780,
  "baseFeeGwei": 182,
  "nextBaseFeeGwei": 182,
  "priorityGwei": { "slow": 0, "normal": 0, "fast": 7 },
  "nativeUsdPrice": null,
  "speeds": {
    "slow":   { "totalGwei": 182, "costWei": "3822000000000000", "costNative": 0.003822 },
    "normal": { "totalGwei": 182, "costWei": "3822000000000000", "costNative": 0.003822 },
    "fast":   { "totalGwei": 189, "costWei": "3969000000000000", "costNative": 0.003969 }
  }
}
```

Note the `priorityGwei.slow` / `normal` are `0`: Kite's `eth_feeHistory` reports no
priority-fee market for those percentiles, so the service reports zero instead of
inventing numbers — same principle as the non-EIP-1559 fallback.

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
BASE_URL=https://gas-oracle-x402.onrender.com QUOTE_ENDPOINT=history  CHAINS=ethereum BLOCKS=20 npm run selfpay
BASE_URL=https://gas-oracle-x402.onrender.com QUOTE_ENDPOINT=estimate EST_CHAIN=ethereum EST_GAS_LIMIT=21000 npm run selfpay
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
| `USD_PRICES` | `1` | `0` disables the optional USD conversion in `/v1/estimate` |
| `PRICE_URL` | `https://coins.llama.fi` | Native-token price upstream |
| `CACHE_TTL_PRICE_MS` | `60000` | Cache TTL for the price lookup |
| `CACHE_TTL_GAS_MS` | `10000` | Cache TTL for fee snapshots |
| `CACHE_TTL_HISTORY_MS` | `60000` | Cache TTL for fee history (immutable data) |
| `PORT` | `8080` | Render injects this |

## Design notes

- **Payment happens per request.** The server-side cache only reduces upstream
  RPC traffic; it never lets a client skip a payment. Paid `200` responses are
  sent with `Cache-Control: no-store` so a client can't replay one.
- **Per-chain failure isolation.** One dead RPC does not fail the whole request;
  failures are reported in a `failed` array. If *every* requested chain fails,
  the response is `502` rather than a `200` with an empty payload. Chains are
  fetched with `Promise.allSettled`, so a slow node can't delay the others.
- **Degenerate chains are reported honestly.** Chains without an EIP-1559 fee
  market fall back to `eth_gasPrice` and report priority fees as `0` rather than
  inventing percentiles; chains without a public price report `nativeUsdPrice:
  null` rather than a stale or made-up USD figure.
- **Precision that survives small numbers.** L2 base fees can be a few hundred
  wei, so exact `*_Wei` strings are always shipped next to the gwei figures, and
  native costs keep 12 decimals (rounding a 0.0000441 ETH transfer to 6 decimals
  would be a ~0.2% error that shows up in the USD cost).
- **Explicit routes only.** Payment routes are registered as exact
  `"METHOD /path"` keys — there is no `/v1/*` catch-all, because x402 matches
  with `.find()` and a catch-all would silently misprice specific routes.
