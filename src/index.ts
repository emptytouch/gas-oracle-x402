/**
 * gas-oracle-x402 — multi-chain gas oracle behind x402 on the Kite chain.
 *
 * Wraps **public JSON-RPC endpoints** (no API key, no upstream account) as a
 * paid service. The upstream is free, so the honest reason to charge is the
 * value added on top:
 *
 *  1. Tiered pricing — the current gas snapshot is cheap ($0.001); the fee
 *     history series and the transaction cost estimation are premium ($0.01)
 *     because they are server-computed and return much larger payloads.
 *  2. Real EIP-1559 handling — we use `eth_feeHistory`, not just
 *     `eth_gasPrice`, so callers get the *next* block's base fee plus smoothed
 *     priority-fee percentiles (p10/p50/p90) instead of a single lagging number.
 *     Averaging percentiles over several blocks removes single-block noise.
 *  3. A read-through cache with per-kind TTL (gas moves every block, history is
 *     immutable), per-client rate limiting, upstream timeouts and structured
 *     JSON logs. Payment still happens per request — caching only reduces
 *     upstream traffic, never the charge.
 *
 * Discovery (/healthz) is free so a buyer can inspect the service.
 *
 * Routing note: every paid route is registered with a fully explicit
 * "METHOD /path" key — there is no "/v1/*" catch-all. x402 matches with
 * `.find()` and returns the FIRST hit, so a catch-all would silently swallow
 * more specific routes and misprice them.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FACILITATOR_URL, kiteChainByName, kiteMoneyParser } from "./kite.js";
import { allChains, parseChainIds, resolveChains, type ChainSpec } from "./chains.js";
import {
  adviceFrom,
  avgGasUsedRatio,
  blobBaseFeeGwei,
  estimateCost,
  hexToBigInt,
  historyFromFeeHistory,
  seriesStats,
  snapshotFromFeeHistory,
  trendOf,
  weiToGwei,
  type FeeSnapshot,
} from "./gasmath.js";

const env = (key: string, fallback = ""): string => (process.env[key] ?? "").trim() || fallback;
const money = (v: string): string => (v.startsWith("$") ? v : `$${v}`);
const toHex = (n: number): string => `0x${Math.trunc(n).toString(16)}`;

/** Structured one-line JSON logs — easy to grep, ship, or alert on. */
const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
};

const payTo = env("PAY_TO");
if (!payTo) throw new Error("PAY_TO is required: the Kite wallet address that receives payments");
const chain = kiteChainByName(env("KITE_NETWORK", "testnet"));

// Guards / tuning.
const RPC_TIMEOUT_MS = Number(env("RPC_TIMEOUT_MS", "9000"));
const MAX_CHAINS = Number(env("MAX_CHAINS", "10"));
const SNAPSHOT_BLOCKS = Math.min(Math.max(Number(env("SNAPSHOT_BLOCKS", "5")) || 5, 1), 100);
const MAX_HISTORY_BLOCKS = Number(env("MAX_HISTORY_BLOCKS", "100"));
const MAX_GAS_LIMIT = 30_000_000;

// Optional USD conversion for /v1/estimate. Deliberately non-blocking: if the
// price upstream is unreachable, or the chain has no public price, the USD
// fields are omitted instead of failing a request the client already paid for.
const PRICE_URL = env("PRICE_URL", "https://coins.llama.fi").replace(/\/$/, "");
const USD_PRICES = env("USD_PRICES", "1") !== "0";

// Tiered pricing. Public RPC is free, so the split reflects *value*: a current
// snapshot is cheap; the history series and cost estimation are premium.
const stdPrice = money(env("PRICE_USD", "0.001")); // current gas snapshot
const premiumPrice = money(env("PRICE_USD_PREMIUM", "0.01")); // history + estimate

// Rate limiting. Paid calls are the ones that hit the upstream, so cap them per
// client. RATE_LIMIT_PER_MIN=0 disables.
export function createRateLimiter(perMin: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (!Number.isFinite(perMin) || perMin <= 0) {
      next();
      return;
    }
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    if (bucket.count >= perMin) {
      log("warn", "rate_limited", { key, path: req.path });
      res.status(429).json({ error: "rate limit exceeded", limit_per_min: perMin });
      return;
    }
    bucket.count += 1;
    next();
  };
}

const ratePerMin = Number(env("RATE_LIMIT_PER_MIN", "10"));
const rateLimit = createRateLimiter(ratePerMin);

// 1. Facilitator + Kite pricing.
const facilitator = new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", FACILITATOR_URL) });
const resourceServer = new x402ResourceServer(facilitator).register(
  chain.network,
  new ExactEvmScheme().registerMoneyParser(kiteMoneyParser(chain)),
);

export const app = express();
app.disable("x-powered-by");

// Render terminates TLS in front of the app; advertise the public https origin.
app.set("trust proxy", 1);
// Parse JSON request bodies for POST /v1/estimate. GET requests carry no body.
app.use(express.json({ limit: "1mb" }));

// CORS: let browser-based x402 clients (and the Kite Passport web agent) call
// the paid endpoints and send the X-PAYMENT header. Only the HTTP layer is
// opened — the 402 challenge and paid responses stay gated by x402.
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,X-PAYMENT");
  res.set("Access-Control-Expose-Headers", "payment-required,x-payment-response");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Read-through cache (server-side only). Gas moves every block, so snapshots are
// cached very briefly (10s); past fee history is immutable, so it is cached
// longer (60s). Payment still happens per request — caching only reduces
// upstream traffic, never the charge. Because each paid request must be re-paid,
// paid 200 responses are marked `Cache-Control: no-store` so clients never replay
// a 200 and skip the next payment.
// ---------------------------------------------------------------------------
interface CacheEntry {
  at: number;
  ttl: number;
  body: Buffer;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;
const TTL_GAS_MS = Number(env("CACHE_TTL_GAS_MS", "10000"));
const TTL_HISTORY_MS = Number(env("CACHE_TTL_HISTORY_MS", "60000"));
const TTL_PRICE_MS = Number(env("CACHE_TTL_PRICE_MS", "60000"));

function getCache(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.at + e.ttl) {
    cache.delete(key);
    return null;
  }
  return e;
}
function setCache(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** One JSON-RPC call with a hard timeout so a hung node can't hold a connection. */
export async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json?.error) throw new Error(`rpc ${method} error: ${json.error.message ?? "unknown"}`);
    return json?.result;
  } finally {
    clearTimeout(t);
  }
}

/** Cached JSON-RPC call; turns network/abort failures into a readable message. */
async function rpcCached(rpcUrl: string, method: string, params: unknown[], ttl: number): Promise<unknown> {
  const key = `${rpcUrl}|${method}|${JSON.stringify(params)}`;
  const hit = getCache(key);
  if (hit) return JSON.parse(hit.body.toString("utf8"));
  let result: unknown;
  try {
    result = await rpcCall(rpcUrl, method, params);
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    throw new Error(aborted ? `rpc timeout after ${RPC_TIMEOUT_MS}ms` : `rpc unreachable: ${String(err)}`);
  }
  setCache(key, { at: Date.now(), ttl, body: Buffer.from(JSON.stringify(result)) });
  return result;
}

const feeHistoryFor = (spec: ChainSpec, blocks: number, ttl: number): Promise<unknown> =>
  rpcCached(spec.rpcUrl, "eth_feeHistory", [toHex(blocks), "latest", [10, 50, 90]], ttl);

export interface ChainGasData {
  snapshot: FeeSnapshot;
  /** Blocks the sample covers, oldest first. */
  blockNumbers: number[];
  /** Base fee per sampled block (gwei) — the window the advice is computed over. */
  baseFeeGwei: number[];
  /** Priority-fee percentiles per sampled block (gwei). */
  priorityGwei: { slow: number[]; normal: number[]; fast: number[] };
  /** Mean block fullness over the window (0–1), or null when the node omits it. */
  congestion: number | null;
  /** Latest EIP-4844 blob base fee in gwei, or null. */
  blobBaseFeeGwei: number | null;
  /** Raw per-block fullness series, for the history endpoint. */
  gasUsedRatio: number[];
}

/**
 * One chain's fee data. EIP-1559 chains get everything from a single
 * `eth_feeHistory` call; the rest fall back to `eth_gasPrice`, which has no
 * priority-fee market (so the priority fees are reported as 0, not invented).
 */
export async function fetchGasData(spec: ChainSpec, blocks: number, ttl: number): Promise<ChainGasData> {
  if (!spec.eip1559) {
    const [gasPrice, blockNumber] = await Promise.all([
      rpcCached(spec.rpcUrl, "eth_gasPrice", [], ttl),
      rpcCached(spec.rpcUrl, "eth_blockNumber", [], ttl).catch(() => "0x0"),
    ]);
    const wei = hexToBigInt(gasPrice);
    return {
      snapshot: {
        blockNumber: Number(hexToBigInt(blockNumber)),
        baseFeeWei: wei,
        nextBaseFeeWei: wei,
        priority: { slow: 0n, normal: 0n, fast: 0n },
      },
      blockNumbers: [Number(hexToBigInt(blockNumber))],
      baseFeeGwei: [weiToGwei(wei)],
      priorityGwei: { slow: [0], normal: [0], fast: [0] },
      congestion: null,
      blobBaseFeeGwei: null,
      gasUsedRatio: [],
    };
  }

  const fh = await feeHistoryFor(spec, blocks, ttl);
  const series = historyFromFeeHistory(fh);
  const raw = (fh ?? {}) as { gasUsedRatio?: unknown };
  return {
    snapshot: snapshotFromFeeHistory(fh),
    blockNumbers: series.blockNumbers,
    baseFeeGwei: series.baseFeeGwei,
    priorityGwei: series.priority,
    congestion: avgGasUsedRatio(fh),
    blobBaseFeeGwei: blobBaseFeeGwei(fh),
    gasUsedRatio: Array.isArray(raw.gasUsedRatio) ? raw.gasUsedRatio.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [],
  };
}

/** Cached plain-JSON GET with the same hard timeout as the RPC calls. */
async function fetchJsonCached(url: string, ttl: number): Promise<any> {
  const hit = getCache(url);
  if (hit) return JSON.parse(hit.body.toString("utf8"));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`price upstream http ${res.status}`);
    const json = await res.json();
    setCache(url, { at: Date.now(), ttl, body: Buffer.from(JSON.stringify(json)) });
    return json;
  } finally {
    clearTimeout(t);
  }
}

/** Native-token USD price, or null when unavailable. Never throws. */
async function nativeUsdPrice(spec: ChainSpec): Promise<number | null> {
  if (!USD_PRICES || !spec.coingeckoId) return null;
  try {
    const json = await fetchJsonCached(`${PRICE_URL}/prices/current/coingecko:${spec.coingeckoId}`, TTL_PRICE_MS);
    const price = Number(json?.coins?.[`coingecko:${spec.coingeckoId}`]?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    log("warn", "price_upstream_failed", { chain: spec.id, detail: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Resolve the requested chain ids, applying the MAX_CHAINS guard. */
function resolveRequest(raw: string | undefined, res: Response): { specs: ChainSpec[]; missing: string[] } | null {
  const text = String(raw ?? "").trim();
  const ids = text ? parseChainIds(text) : allChains().map((c) => c.id);
  if (ids.length === 0) {
    res.status(400).json({ error: "no chains available (the CHAINS env var restricts the registry)" });
    return null;
  }
  if (ids.length > MAX_CHAINS) {
    res.status(400).json({ error: `too many chains: ${ids.length} (max ${MAX_CHAINS})` });
    return null;
  }
  return resolveChains(ids.join(","));
}

export async function handleGas(req: Request, res: Response): Promise<void> {
  const resolved = resolveRequest(req.query.chains as string | undefined, res);
  if (!resolved) return;
  const { specs, missing } = resolved;

  const chains: Record<string, unknown> = {};
  const failed: Array<{ chain: string; error: string }> = [];

  // Fetch every chain in parallel. Sequentially, one slow node would serialise
  // the whole request even though each call already has its own timeout.
  const settled = await Promise.allSettled(
    specs.map(async (spec) => ({ spec, data: await fetchGasData(spec, SNAPSHOT_BLOCKS, TTL_GAS_MS) })),
  );

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      const failedSpec = specs[i];
      log("error", "gas_rpc_failed", { chain: failedSpec.id, detail: String(outcome.reason) });
      failed.push({ chain: failedSpec.id, error: String(outcome.reason) });
      continue;
    }
    const { spec, data } = outcome.value;
    const snapshot = data.snapshot;
    const priorityGwei = {
      slow: weiToGwei(snapshot.priority.slow),
      normal: weiToGwei(snapshot.priority.normal),
      fast: weiToGwei(snapshot.priority.fast),
    };
    const totalAt = (p: bigint): number => weiToGwei(snapshot.nextBaseFeeWei + p);
    // Exact wei values are shipped alongside the gwei numbers: some L2s quote
    // fees in the hundreds of wei, and a rounded gwei figure alone can read as 0.
    const asWei = (v: bigint): string => v.toString();
    chains[spec.id] = {
      label: spec.label,
      nativeSymbol: spec.nativeSymbol,
      blockNumber: snapshot.blockNumber,
      baseFeeGwei: weiToGwei(snapshot.baseFeeWei),
      nextBaseFeeGwei: weiToGwei(snapshot.nextBaseFeeWei),
      priorityGwei,
      totalGwei: { slow: totalAt(snapshot.priority.slow), normal: totalAt(snapshot.priority.normal), fast: totalAt(snapshot.priority.fast) },
      baseFeeWei: asWei(snapshot.baseFeeWei),
      nextBaseFeeWei: asWei(snapshot.nextBaseFeeWei),
      priorityWei: {
        slow: asWei(snapshot.priority.slow),
        normal: asWei(snapshot.priority.normal),
        fast: asWei(snapshot.priority.fast),
      },
      totalWei: {
        slow: asWei(snapshot.nextBaseFeeWei + snapshot.priority.slow),
        normal: asWei(snapshot.nextBaseFeeWei + snapshot.priority.normal),
        fast: asWei(snapshot.nextBaseFeeWei + snapshot.priority.fast),
      },
      // Congestion and blob fees ride along with feeHistory — no extra RPC call.
      congestion: data.congestion,
      blobBaseFeeGwei: data.blobBaseFeeGwei,
      // Server-side advisory: where the next base fee sits inside the recent
      // window, plus maxFeePerGas values that drop straight into a transaction.
      advice: adviceFrom(snapshot.nextBaseFeeWei, snapshot.priority, data.baseFeeGwei),
    };
  }

  // If every requested chain failed there is no data to bill for — surface it
  // as 502 instead of a 200 with an empty payload.
  if (specs.length > 0 && Object.keys(chains).length === 0) {
    res.status(502).json({ error: "rpc unreachable for every requested chain", detail: failed[0]?.error ?? "unknown", failed });
    return;
  }

  res.json({
    chains,
    count: Object.keys(chains).length,
    missing,
    failed,
    snapshotBlocks: SNAPSHOT_BLOCKS,
    updatedAt: Date.now(),
  });
}

export async function handleHistory(req: Request, res: Response): Promise<void> {
  const resolved = resolveRequest(req.query.chains as string | undefined, res);
  if (!resolved) return;
  const { specs, missing } = resolved;

  const blocks = Math.min(Math.max(Number(req.query.blocks ?? "20") || 20, 1), MAX_HISTORY_BLOCKS);

  const chains: Record<string, unknown> = {};
  const failed: Array<{ chain: string; error: string }> = [];

  const settled = await Promise.allSettled(
    specs.map(async (spec) => ({ spec, data: await fetchGasData(spec, blocks, TTL_HISTORY_MS) })),
  );

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      const failedSpec = specs[i];
      log("error", "history_rpc_failed", { chain: failedSpec.id, detail: String(outcome.reason) });
      failed.push({ chain: failedSpec.id, error: String(outcome.reason) });
      continue;
    }
    const { spec, data } = outcome.value;
    // Where was the cheapest block in this window? The answer is only useful if
    // you also get the block number, so both are returned together.
    let cheapestIdx = 0;
    for (let k = 1; k < data.baseFeeGwei.length; k++) {
      if (data.baseFeeGwei[k] < data.baseFeeGwei[cheapestIdx]) cheapestIdx = k;
    }
    chains[spec.id] = {
      label: spec.label,
      nativeSymbol: spec.nativeSymbol,
      blockNumbers: data.blockNumbers,
      baseFeeGwei: data.baseFeeGwei,
      priorityGwei: data.priorityGwei,
      gasUsedRatio: data.gasUsedRatio.length ? data.gasUsedRatio : null,
      blobBaseFeeGwei: data.blobBaseFeeGwei,
      summary: {
        ...seriesStats(data.baseFeeGwei),
        trend: trendOf(data.baseFeeGwei),
        cheapestBlockNumber: data.blockNumbers[cheapestIdx] ?? null,
        cheapestBaseFeeGwei: data.baseFeeGwei[cheapestIdx] ?? null,
      },
    };
  }

  if (specs.length > 0 && Object.keys(chains).length === 0) {
    res.status(502).json({ error: "rpc unreachable for every requested chain", detail: failed[0]?.error ?? "unknown", failed });
    return;
  }

  res.json({ blocks, chains, count: Object.keys(chains).length, missing, failed, updatedAt: Date.now() });
}

export async function handleEstimate(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { chain?: unknown; gasLimit?: unknown };
  const chainId = String(body.chain ?? "").trim().toLowerCase();
  if (!chainId) {
    res.status(400).json({ error: "chain is required, e.g. { \"chain\": \"ethereum\", \"gasLimit\": 21000 }" });
    return;
  }
  const gasLimit = Number(body.gasLimit);
  if (!Number.isInteger(gasLimit) || gasLimit <= 0 || gasLimit > MAX_GAS_LIMIT) {
    res.status(400).json({ error: `gasLimit must be an integer in 1..${MAX_GAS_LIMIT}` });
    return;
  }

  const { specs, missing } = resolveChains(chainId);
  if (!specs.length) {
    res.status(400).json({ error: `unknown chain: ${chainId}`, missing });
    return;
  }
  const spec = specs[0];

  // The price lookup is best-effort and must never fail a paid request, so it
  // runs alongside the fee fetch and simply degrades to null.
  const [feeResult, usdPrice] = await Promise.all([
    feeHistoryFor(spec, SNAPSHOT_BLOCKS, TTL_GAS_MS).then(
      (fh) => ({ ok: true as const, fh }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    nativeUsdPrice(spec),
  ]);
  if (!feeResult.ok) {
    log("error", "estimate_rpc_failed", { chain: spec.id, detail: String(feeResult.err) });
    res.status(502).json({ error: "rpc unreachable", detail: String(feeResult.err) });
    return;
  }
  const snapshot = snapshotFromFeeHistory(feeResult.fh);

  const limit = BigInt(gasLimit);
  const speed = (p: bigint) => {
    const totalWei = snapshot.nextBaseFeeWei + p;
    const { costWei, costNative } = estimateCost(totalWei, limit, spec.nativeDecimals);
    const out: Record<string, unknown> = { totalGwei: weiToGwei(totalWei), costWei, costNative };
    if (usdPrice !== null) out.costUsd = Number((costNative * usdPrice).toFixed(6));
    return out;
  };

  res.json({
    chain: spec.id,
    label: spec.label,
    nativeSymbol: spec.nativeSymbol,
    gasLimit,
    blockNumber: snapshot.blockNumber,
    baseFeeGwei: weiToGwei(snapshot.baseFeeWei),
    nextBaseFeeGwei: weiToGwei(snapshot.nextBaseFeeWei),
    priorityGwei: {
      slow: weiToGwei(snapshot.priority.slow),
      normal: weiToGwei(snapshot.priority.normal),
      fast: weiToGwei(snapshot.priority.fast),
    },
    speeds: {
      slow: speed(snapshot.priority.slow),
      normal: speed(snapshot.priority.normal),
      fast: speed(snapshot.priority.fast),
    },
    // null when the chain has no public price feed (Kite) or the price upstream
    // is unreachable — the native-token cost is always returned regardless.
    nativeUsdPrice: usdPrice,
  });
}

const startedAt = Date.now();

// Structured, machine-readable endpoint catalogue — lets a buyer/client see the
// exact method + path + price per tier.
const endpoints = {
  gas: { method: "GET", path: "/v1/gas", price: stdPrice, description: "current gas snapshot per chain (standard)" },
  history: { method: "GET", path: "/v1/history", price: premiumPrice, description: "EIP-1559 fee history series (premium)" },
  estimate: { method: "POST", path: "/v1/estimate", price: premiumPrice, description: "transaction cost estimation (premium)" },
};

const tiers = {
  gas: { endpoint: "GET /v1/gas", price: stdPrice, description: "current gas snapshot per chain (standard)" },
  history: { endpoint: "GET /v1/history", price: premiumPrice, description: "EIP-1559 fee history series (premium)" },
  estimate: { endpoint: "POST /v1/estimate", price: premiumPrice, description: "transaction cost estimation (premium)" },
};

// 2. Free discovery.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "gas-oracle-x402",
    network: chain.network,
    asset: chain.assetSymbol,
    payTo,
    chains: allChains().map((c) => ({ id: c.id, label: c.label, nativeSymbol: c.nativeSymbol })),
    tiers,
    endpoints,
    rateLimitPerMin: ratePerMin,
    cache: { enabled: true, maxEntries: CACHE_MAX, gasTtlMs: TTL_GAS_MS, historyTtlMs: TTL_HISTORY_MS },
    startedAt,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// 3. Payment gate. Every route is explicit — no catch-all.
app.use(
  paymentMiddleware(
    {
      "GET /v1/gas": {
        accepts: { scheme: "exact", price: stdPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Current gas snapshot (base fee + priority percentiles) per chain",
        mimeType: "application/json",
      },
      "GET /v1/history": {
        accepts: { scheme: "exact", price: premiumPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "EIP-1559 fee history series per chain (premium)",
        mimeType: "application/json",
      },
      "POST /v1/estimate": {
        accepts: { scheme: "exact", price: premiumPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Transaction cost estimation per speed (premium)",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// Paid 200 responses must not be cached by clients, or they'd replay a 200 and
// skip the next payment.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// 4. Paid handlers. Rate limiting is applied here (after the gate), so only paid
//    calls consume the limit.
app.get("/v1/gas", rateLimit, (req: Request, res: Response) => void handleGas(req, res));
app.get("/v1/history", rateLimit, (req: Request, res: Response) => void handleHistory(req, res));
app.post("/v1/estimate", rateLimit, (req: Request, res: Response) => void handleEstimate(req, res));

const port = Number(env("PORT", "8080"));
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    log("info", "listening", {
      port,
      network: chain.network,
      std: stdPrice,
      premium: premiumPrice,
      payTo,
      rateLimitPerMin: ratePerMin,
      chains: allChains().map((c) => c.id),
    });
  });
}
