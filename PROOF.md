# Proof of payment — gas-oracle-x402

Every row below is a **real on-chain settlement** produced by the buyer script in
`examples/paid-call.mjs` (`npm run selfpay`), not a mocked response. Each call:

1. requests a paid endpoint with no payment → `402 Payment Required` + a `payment-required` challenge,
2. signs an EIP-3009 `transferWithAuthorization` with a Kite testnet key,
3. retries with the `X-PAYMENT` header → `200` + settlement receipt.

| Endpoint | Tier | Price | Transaction | Buyer |
| --- | --- | --- | --- | --- |
| `GET /v1/gas` | standard | $0.001 | 0xa26df9f85a4d190a5b42ec5b66b8af6bd88eee383b6bc2d77244b2da294bdd04 | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |
| `GET /v1/history` | premium | $0.01 | 0xa7e4f3f42fa5176273174d4a7237fe2f244ba4f7b666dd9824ef5e016af8a8e6 | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |
| `POST /v1/estimate` | premium | $0.01 | 0x1077465c824d00880d8bb7974064c2d69a9385266bf90a52097b32d9c65bc8bd | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |

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
