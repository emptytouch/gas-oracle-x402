# Proof of payment — gas-oracle-x402

Every row below is a **real on-chain settlement** produced by the buyer script in
`examples/paid-call.mjs` (`npm run selfpay`), not a mocked response. Each call:

1. requests a paid endpoint with no payment → `402 Payment Required` + a `payment-required` challenge,
2. signs an EIP-3009 `transferWithAuthorization` with a Kite testnet key,
3. retries with the `X-PAYMENT` header → `200` + settlement receipt.

| Endpoint | Tier | Price | Transaction | Buyer |
| --- | --- | --- | --- | --- |
| `GET /v1/gas` | standard | $0.001 | _(run `npm run selfpay`)_ | _(run `npm run selfpay`)_ |
| `GET /v1/history` | premium | $0.01 | _(run `npm run selfpay`)_ | _(run `npm run selfpay`)_ |
| `POST /v1/estimate` | premium | $0.01 | _(run `npm run selfpay`)_ | _(run `npm run selfpay`)_ |

Settlement parameters (read from the live `402` challenge):

- **Network:** `eip155:2368` (Kite testnet)
- **Asset:** pieUSD, 18 decimals — `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`
- **Scheme:** `exact`
- **PayTo:** see `PAY_TO` in the deployment / `/healthz` response
- **Facilitator:** `https://facilitator.pieverse.io/v2`

## Reproducing

```bash
npm install
export BUYER_PRIVATE_KEY=0x<kite-testnet-key-holding-pieUSD>
# or rely on a Kite Passport sandbox session file

BASE_URL=https://gas-oracle-x402.onrender.com npm run selfpay                       # GET /v1/gas
QUOTE_ENDPOINT=history  CHAINS=ethereum BLOCKS=20        npm run selfpay            # GET /v1/history
QUOTE_ENDPOINT=estimate EST_CHAIN=ethereum EST_GAS_LIMIT=21000 npm run selfpay      # POST /v1/estimate

npm run proof   # rewrites the table above from proof/paid-calls.jsonl
```

`proof/paid-calls.jsonl` is gitignored — it holds the raw request/response
records including settlement receipts. The table above is the human-readable
summary committed to the repo.
