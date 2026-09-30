# Deploying gas-oracle-x402 to Render (free tier)

The service must be publicly reachable — the x402 facilitator verifies and
settles payments over the public internet. Render's free tier needs no credit
card.

## 1. Prerequisites

- Repo pushed to GitHub (the `Dockerfile` + `package-lock.json` are committed).
- `package-lock.json` **must** be committed and in sync with `package.json` —
  the image builds with `npm ci`, which fails hard on any mismatch.
- A Render API key, either `~/.workbuddy/render-api-key.txt` or `$RENDER_API_KEY`.

## 2. Create the service (Docker)

```bash
RENDER_API_KEY=$(cat ~/.workbuddy/render-api-key.txt)
curl -s -X POST https://api.render.com/v1/services \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "type":"web_service",
    "ownerId":"<ownerId>",
    "name":"gas-oracle-x402",
    "repo":"https://github.com/<you>/gas-oracle-x402",
    "branch":"master",
    "rootDir":"",
    "autoDeploy":"yes",
    "envVars":[
      {"key":"PAY_TO","value":"0xYourKiteWallet"},
      {"key":"KITE_NETWORK","value":"testnet"},
      {"key":"PRICE_USD","value":"0.001"},
      {"key":"PRICE_USD_PREMIUM","value":"0.01"},
      {"key":"RATE_LIMIT_PER_MIN","value":"10"}
    ],
    "serviceDetails":{
      "plan":"free",
      "region":"oregon",
      "healthCheckPath":"/healthz",
      "runtime":"docker",
      "env":"docker",
      "numInstances":1,
      "ipAllowList":[{"cidrBlock":"0.0.0.0/0","description":"everywhere"}],
      "previews":{"generation":"off"},
      "pullRequestPreviewsEnabled":"no",
      "renderSubdomainPolicy":"enabled",
      "envSpecificDetails":{
        "dockerfilePath":"./Dockerfile",
        "dockerContext":".",
        "dockerCommand":""
      }
    }
  }'
```

Get `ownerId` from `GET /v1/owners`.

## 3. Environment variables

Update with `PUT` and a **bare array** body (semantics: replace the whole set):

```bash
curl -s -X PUT "https://api.render.com/v1/services/<serviceId>/env-vars" \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '[{"key":"PAY_TO","value":"0x..."},{"key":"KITE_NETWORK","value":"testnet"}]'
```

Changing env does **not** restart the service by itself — trigger a deploy
afterwards (step 4).

## 4. Trigger a deploy and poll

```bash
curl -s -X POST "https://api.render.com/v1/services/<serviceId>/deploys" \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"clearCache":"do_not_clear"}'
# then poll:
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/<serviceId>/deploys/<deployId>"
# build_in_progress -> update_in_progress -> live
```

> **A service created through the API does not get a GitHub webhook**, so
> `autoDeploy:"yes"` does nothing and pushing to GitHub will *not* deploy —
> silently. Always confirm a deploy exists, and trigger one manually after
> every push.

## 5. Verify (do not stop at `status=live`)

```bash
curl -s -m 90 -w "\nHTTP %{http_code}\n" https://gas-oracle-x402.onrender.com/healthz
# expect 200 + JSON (cold start on the free tier can take 30-60s)

curl -s -i "https://gas-oracle-x402.onrender.com/v1/gas?chains=ethereum"
# expect 402 + payment-required header

curl -s -i -X OPTIONS "https://gas-oracle-x402.onrender.com/v1/history"
# expect 204 + access-control-allow-origin
```

## 6. Prove payment works

```bash
export BUYER_PRIVATE_KEY=0x<kite-testnet-key-holding-pieUSD>
npm run selfpay                                            # GET /v1/gas
QUOTE_ENDPOINT=history CHAINS=ethereum BLOCKS=20 npm run selfpay
QUOTE_ENDPOINT=estimate EST_CHAIN=ethereum EST_GAS_LIMIT=21000 npm run selfpay
npm run proof
```

Commit the regenerated `PROOF.md`.

## Notes

- No upstream API keys are needed: every chain uses a public JSON-RPC endpoint.
  If a public endpoint starts rate-limiting, override just that chain with
  `RPC_URL_<CHAIN_ID>` (e.g. `RPC_URL_ETHEREUM`) — no code change, no rebuild.
- Free-tier instances sleep when idle; the first request after a sleep is slow.
- `NODE_ENV=production` must **not** be set as an env var: it makes Render skip
  `devDependencies` during build, and `npm start` runs through `tsx`.
