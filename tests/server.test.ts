import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, createRateLimiter, fetchGasData, handleEstimate, handleGas, handleHistory } from "../src/index.js";
import {
  adviceFrom,
  avgGasUsedRatio,
  blobBaseFeeGwei,
  estimateCost,
  hexToBigInt,
  historyFromFeeHistory,
  percentilePosition,
  seriesStats,
  snapshotFromFeeHistory,
  trendOf,
  weiToGwei,
} from "../src/gasmath.js";
import { allChains, parseChainIds, resolveChains } from "../src/chains.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A hand-built eth_feeHistory payload. 1 gwei = 1e9 wei.
//   baseFeePerGas: [1 gwei (current), 2 gwei (next block)]
//   reward[0]    : [0.1 gwei (p10), 1 gwei (p50), 2 gwei (p90)]
const FH = {
  oldestBlock: "0x64", // 100
  baseFeePerGas: ["0x3b9aca00", "0x77359400"],
  reward: [["0x5f5e100", "0x3b9aca00", "0x77359400"]],
  gasUsedRatio: [0.5],
};

const mockRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
};
const mockReq = (over: any) => ({ query: {}, body: {}, ...over }) as any;

const stubRpc = (result: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
const stubAbort = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }),
  );

// A 5-block EIP-1559 window, rising 10 -> 14 gwei with 15 gwei predicted next.
//   baseFeePerGas     : [10,11,12,13,14] observed + [15] next block
//   reward[i]         : p10 = 0.1*(i+1), p50 = 0.5*(i+1), p90 = 1*(i+1)
//   gasUsedRatio      : mean 0.6
//   baseFeePerBlobGas : latest 0.02 gwei
const gwei = (n: number): string => `0x${BigInt(Math.round(n * 1e9)).toString(16)}`;
const FH_WIN = {
  oldestBlock: "0x64", // 100
  baseFeePerGas: [10, 11, 12, 13, 14, 15].map(gwei),
  reward: [1, 2, 3, 4, 5].map((n) => [gwei(n * 0.1), gwei(n * 0.5), gwei(n)]),
  gasUsedRatio: [0.4, 0.6, 0.8, 0.5, 0.7],
  baseFeePerBlobGas: [gwei(0.01), gwei(0.02)],
};

/**
 * Route-aware fetch stub. `route` sees the request URL and — for JSON-RPC
 * calls — the RPC method, so a single test can answer the fee upstream and the
 * (separate) USD price upstream differently.
 */
const stubFetch = (route: (url: string, rpcMethod?: string) => { status: number; body: unknown }) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      let rpcMethod: string | undefined;
      if (init?.body) {
        try {
          rpcMethod = (JSON.parse(String(init.body)) as { method?: string })?.method;
        } catch {
          /* not a JSON-RPC call (plain JSON GET) */
        }
      }
      const r = route(url, rpcMethod);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );

/** feeHistory (or gasPrice) answers OK; everything else 500s. */
const rpcOnlyRoute = (result: unknown) => (url: string) =>
  url.startsWith("http") ? { status: 200, body: { jsonrpc: "2.0", id: 1, result } } : { status: 500, body: {} };

describe("GET /healthz", () => {
  it("returns 200 with network, tiers, chains and uptime", async () => {
    const r = await request(app).get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.network).toBe("eip155:2368");
    expect(r.body.asset).toBe("pieUSD");
    expect(r.body.tiers.gas.price).toBe("$0.001");
    expect(r.body.tiers.history.price).toBe("$0.01");
    expect(r.body.tiers.estimate.price).toBe("$0.01");
    expect(r.body.endpoints.gas.method).toBe("GET");
    expect(r.body.endpoints.estimate.method).toBe("POST");
    expect(Array.isArray(r.body.chains)).toBe(true);
    expect(r.body.chains.map((c: any) => c.id)).toContain("kite-testnet");
    expect(typeof r.body.uptimeSec).toBe("number");
  });
});

describe("unpaid gating", () => {
  it("GET /v1/gas returns 402 with PAYMENT-REQUIRED header", async () => {
    const r = await request(app).get("/v1/gas?chains=ethereum");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
  it("GET /v1/history returns 402", async () => {
    const r = await request(app).get("/v1/history?chains=ethereum&blocks=10");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
  it("POST /v1/estimate returns 402", async () => {
    const r = await request(app).post("/v1/estimate").send({ chain: "ethereum", gasLimit: 21000 });
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
});

describe("tiered pricing", () => {
  const decodeAmount = (header: unknown): string => {
    const decoded = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    return String(decoded.accepts[0].amount);
  };

  it("charges premium for history and estimate above the gas snapshot", async () => {
    const gas = await request(app).get("/v1/gas?chains=ethereum");
    const history = await request(app).get("/v1/history?chains=ethereum&blocks=10");
    const estimate = await request(app).post("/v1/estimate").send({ chain: "ethereum", gasLimit: 21000 });
    const gasAmount = BigInt(decodeAmount(gas.headers["payment-required"]));
    const historyAmount = BigInt(decodeAmount(history.headers["payment-required"]));
    const estimateAmount = BigInt(decodeAmount(estimate.headers["payment-required"]));
    expect(historyAmount).toBeGreaterThan(gasAmount);
    expect(estimateAmount).toBeGreaterThan(gasAmount);
    expect(historyAmount).toBe(estimateAmount);
  });
});

describe("rate limiter", () => {
  const mkRes = () => {
    const res: any = { statusCode: 0, body: null };
    res.status = (c: number) => {
      res.statusCode = c;
      return res;
    };
    res.json = (b: unknown) => {
      res.body = b;
      return res;
    };
    return res;
  };
  const mkReq = (ip: string) => ({ ip, path: "/v1/gas" }) as any;

  it("allows up to the limit, then returns 429", () => {
    const limiter = createRateLimiter(2);
    let passed = 0;
    const next = () => {
      passed += 1;
    };
    limiter(mkReq("1.2.3.4"), mkRes(), next);
    limiter(mkReq("1.2.3.4"), mkRes(), next);
    const third = mkRes();
    limiter(mkReq("1.2.3.4"), third, next);
    expect(passed).toBe(2);
    expect(third.statusCode).toBe(429);
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter(1);
    const next = () => {};
    limiter(mkReq("1.1.1.1"), mkRes(), next);
    const other = mkRes();
    limiter(mkReq("2.2.2.2"), other, next);
    expect(other.statusCode).toBe(0);
  });

  it("is a no-op when disabled", () => {
    const limiter = createRateLimiter(0);
    let passed = 0;
    const next = () => {
      passed += 1;
    };
    for (let i = 0; i < 5; i++) limiter(mkReq("1.2.3.4"), mkRes(), next);
    expect(passed).toBe(5);
  });
});

describe("gasmath (pure functions)", () => {
  it("hexToBigInt parses hex quantities and never throws", () => {
    expect(hexToBigInt("0x3b9aca00")).toBe(1_000_000_000n);
    expect(hexToBigInt("0x0")).toBe(0n);
    expect(hexToBigInt(undefined)).toBe(0n);
    expect(hexToBigInt("nonsense")).toBe(0n);
  });

  it("weiToGwei converts with 1e9 scaling", () => {
    expect(weiToGwei(1_000_000_000n)).toBe(1);
    expect(weiToGwei(2_100_000_000n)).toBe(2.1);
    expect(weiToGwei(0n)).toBe(0);
  });

  it("weiToGwei keeps sub-micro-gwei precision (L2s quote tiny base fees)", () => {
    // Optimism/Base can quote a base fee of a few hundred wei. Rounding to
    // 6 decimals would report 0, which reads as "free gas".
    expect(weiToGwei(801n)).toBeGreaterThan(0);
    expect(weiToGwei(801n)).toBeCloseTo(0.000000801, 12);
  });

  it("snapshotFromFeeHistory reads next base fee + smoothed percentiles", () => {
    const s = snapshotFromFeeHistory(FH);
    expect(s.blockNumber).toBe(100);
    expect(s.baseFeeWei).toBe(1_000_000_000n);
    expect(s.nextBaseFeeWei).toBe(2_000_000_000n);
    expect(s.priority).toEqual({ slow: 100_000_000n, normal: 1_000_000_000n, fast: 2_000_000_000n });
  });

  it("snapshotFromFeeHistory tolerates an empty/garbage payload", () => {
    const s = snapshotFromFeeHistory(null);
    expect(s.nextBaseFeeWei).toBe(0n);
    expect(s.priority.normal).toBe(0n);
  });

  it("historyFromFeeHistory splits the series into parallel arrays", () => {
    const h = historyFromFeeHistory(FH);
    expect(h.blockNumbers).toEqual([100]);
    expect(h.baseFeeGwei).toEqual([1]);
    expect(h.priority).toEqual({ slow: [0.1], normal: [1], fast: [2] });
  });

  it("estimateCost returns exact wei and a human native amount", () => {
    // 2 gwei * 21000 gas = 4.2e13 wei = 0.000042 ETH
    const out = estimateCost(2_000_000_000n, 21_000n, 18);
    expect(out.costWei).toBe("42000000000000");
    expect(out.costNative).toBeCloseTo(0.000042, 9);
  });

  it("estimateCost keeps shake-level precision for cheap transfers", () => {
    // 2.1 gwei * 21000 gas = 4.41e13 wei = 0.0000441 ETH. Rounding to 6 decimals
    // here would report 0.000044 — a ~0.2% error that carries into the USD cost.
    const out = estimateCost(2_100_000_000n, 21_000n, 18);
    expect(out.costWei).toBe("44100000000000");
    expect(out.costNative).toBeCloseTo(0.0000441, 12);
  });
});

describe("chains registry", () => {
  it("parseChainIds normalises ids", () => {
    expect(parseChainIds("Ethereum, base ,")).toEqual(["ethereum", "base"]);
  });
  it("resolveChains separates known specs from unknown ids", () => {
    const { specs, missing } = resolveChains("ethereum,notachain");
    expect(specs.map((s) => s.id)).toEqual(["ethereum"]);
    expect(missing).toEqual(["notachain"]);
  });
  it("exposes Kite chains alongside the majors", () => {
    const ids = allChains().map((c) => c.id);
    expect(ids).toContain("kite");
    expect(ids).toContain("kite-testnet");
    expect(ids).toContain("ethereum");
  });
});

// Each case targets a DIFFERENT chain so the per-chain RPC cache can't leak
// results between tests (cache keys are keyed by rpcUrl).
describe("handler error paths & boundaries", () => {
  it("handleGas returns a populated snapshot on success", async () => {
    stubRpc(FH);
    const res = mockRes();
    await handleGas(mockReq({ query: { chains: "ethereum" } }), res);
    expect(res.statusCode).toBe(200);
    const eth = res.body.chains.ethereum;
    expect(eth.baseFeeGwei).toBe(1);
    expect(eth.nextBaseFeeGwei).toBe(2);
    expect(eth.priorityGwei).toEqual({ slow: 0.1, normal: 1, fast: 2 });
    expect(eth.totalGwei).toEqual({ slow: 2.1, normal: 3, fast: 4 });
    expect(eth.blockNumber).toBe(100);
  });

  it("handleGas returns 502 when the RPC fails for every chain", async () => {
    stubRpc(null, 500);
    const res = mockRes();
    await handleGas(mockReq({ query: { chains: "base" } }), res);
    expect(res.statusCode).toBe(502);
    expect(String(res.body.error)).toMatch(/unreachable/i);
  });

  it("handleGas surfaces an RPC timeout as 502 with timeout detail", async () => {
    stubAbort();
    const res = mockRes();
    await handleGas(mockReq({ query: { chains: "arbitrum" } }), res);
    expect(res.statusCode).toBe(502);
    expect(String(res.body.detail)).toMatch(/timeout/i);
  });

  it("handleGas rejects more than MAX_CHAINS", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `chain${i}`).join(",");
    const res = mockRes();
    await handleGas(mockReq({ query: { chains: many } }), res);
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/too many/i);
  });

  it("handleHistory returns the fee series on success", async () => {
    stubRpc(FH);
    const res = mockRes();
    await handleHistory(mockReq({ query: { chains: "optimism", blocks: "5" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.blocks).toBe(5);
    expect(res.body.chains.optimism.baseFeeGwei).toEqual([1]);
    expect(res.body.chains.optimism.priorityGwei.normal).toEqual([1]);
  });

  it("handleHistory clamps blocks into 1..MAX_HISTORY_BLOCKS", async () => {
    stubRpc(FH);
    const res = mockRes();
    await handleHistory(mockReq({ query: { chains: "optimism", blocks: "99999" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.blocks).toBe(100);
  });

  it("handleHistory returns 502 when the RPC fails", async () => {
    stubRpc(null, 500);
    const res = mockRes();
    await handleHistory(mockReq({ query: { chains: "polygon", blocks: "5" } }), res);
    expect(res.statusCode).toBe(502);
  });

  it("handleEstimate computes cost per speed on success", async () => {
    stubRpc(FH);
    const res = mockRes();
    await handleEstimate(mockReq({ body: { chain: "kite-testnet", gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.chain).toBe("kite-testnet");
    expect(res.body.speeds.normal.totalGwei).toBe(3); // 2 gwei base + 1 gwei priority
    expect(res.body.speeds.normal.costNative).toBeCloseTo(0.000063, 9);
    expect(res.body.speeds.slow.totalGwei).toBe(2.1);
    expect(res.body.speeds.fast.totalGwei).toBe(4);
  });

  it("handleEstimate rejects a missing chain", async () => {
    const res = mockRes();
    await handleEstimate(mockReq({ body: { gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(400);
  });

  it("handleEstimate rejects invalid gasLimit values", async () => {
    for (const bad of [0, -1, 1.5, 40_000_000, undefined]) {
      const res = mockRes();
      await handleEstimate(mockReq({ body: { chain: "ethereum", gasLimit: bad } }), res);
      expect(res.statusCode).toBe(400);
    }
  });

  it("handleEstimate rejects an unknown chain", async () => {
    const res = mockRes();
    await handleEstimate(mockReq({ body: { chain: "notachain", gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/unknown chain/i);
  });

  it("handleEstimate returns 502 when the RPC fails", async () => {
    stubRpc(null, 500);
    const res = mockRes();
    await handleEstimate(mockReq({ body: { chain: "kite", gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(502);
  });
});

describe("gasmath: congestion, blobs and the advisory layer", () => {
  it("avgGasUsedRatio averages block fullness, or null when absent", () => {
    expect(avgGasUsedRatio(FH_WIN)).toBeCloseTo(0.6, 9); // (0.4+0.6+0.8+0.5+0.7)/5
    expect(avgGasUsedRatio({ gasUsedRatio: [] })).toBeNull();
    expect(avgGasUsedRatio(null)).toBeNull();
    expect(avgGasUsedRatio({ gasUsedRatio: "nope" })).toBeNull();
  });

  it("blobBaseFeeGwei reports the latest blob fee, or null when unsupported", () => {
    expect(blobBaseFeeGwei(FH_WIN)).toBeCloseTo(0.02, 9);
    expect(blobBaseFeeGwei({})).toBeNull();
    expect(blobBaseFeeGwei({ baseFeePerBlobGas: ["0x0"] })).toBeNull();
    // Base / OP answer 0x1 (1 wei = the EIP-4844 floor): no blob market, so it
    // must be reported as "not applicable" rather than as 1e-9 gwei.
    expect(blobBaseFeeGwei({ baseFeePerBlobGas: ["0x1", "0x1"] })).toBeNull();
  });

  it("seriesStats summarises a window and degrades safely on empty input", () => {
    const s = seriesStats([10, 11, 12, 13, 14]);
    expect(s).toEqual({ min: 10, median: 12, max: 14, mean: 12 });
    expect(seriesStats([])).toEqual({ min: 0, median: 0, max: 0, mean: 0 });
    // Ignores non-finite junk rather than poisoning the summary.
    expect(seriesStats([1, Number.NaN, 3]).max).toBe(3);
  });

  it("percentilePosition locates a value inside the window", () => {
    expect(percentilePosition(12, [10, 11, 12, 13, 14])).toBe(50);
    expect(percentilePosition(15, [10, 11, 12, 13, 14])).toBe(100);
    expect(percentilePosition(9, [10, 11, 12, 13, 14])).toBe(0);
    expect(percentilePosition(1, [])).toBe(50); // no window -> neutral
  });

  it("trendOf classifies rising / falling / flat", () => {
    expect(trendOf([10, 10, 11, 13, 14])).toBe("rising");
    expect(trendOf([14, 14, 13, 11, 10])).toBe("falling");
    expect(trendOf([10, 10, 10, 10, 10])).toBe("flat");
    expect(trendOf([10, 10.2, 10, 10.1])).toBe("flat"); // +/-2% is noise
    expect(trendOf([1, 2])).toBe("flat"); // too few samples to judge
  });

  it("adviceFrom says wait when the next base fee is at the top of the window", () => {
    const a = adviceFrom(15_000_000_000n, { slow: 300_000_000n, normal: 1_500_000_000n, fast: 3_000_000_000n }, [
      10, 11, 12, 13, 14,
    ]);
    expect(a.windowBlocks).toBe(5);
    expect(a.currentBaseFeeGwei).toBe(15);
    expect(a.medianGwei).toBe(12);
    expect(a.percentile).toBe(100);
    expect(a.trend).toBe("rising");
    expect(a.recommendation).toBe("wait");
    // maxFeePerGas = 2 x nextBaseFee + priority — stays valid while the base
    // fee climbs ~12.5%/block, but the sender still only pays the real base fee.
    expect(a.suggestedMaxFeePerGasGwei).toEqual({ slow: 30.3, normal: 31.5, fast: 33 });
    expect(a.suggestedMaxPriorityFeePerGasGwei).toEqual({ slow: 0.3, normal: 1.5, fast: 3 });
  });

  it("adviceFrom says send_now when the next base fee is the cheapest in the window", () => {
    // Window has been falling 24 -> 20 gwei and the next block quotes 15: the
    // cheapest observed level, so waiting is unlikely to help.
    const a = adviceFrom(15_000_000_000n, { slow: 1n, normal: 2n, fast: 3n }, [24, 23, 22, 21, 20]);
    expect(a.percentile).toBe(0);
    expect(a.trend).toBe("falling");
    expect(a.recommendation).toBe("send_now");
  });
});

describe("non-EIP-1559 fallback", () => {
  it("uses eth_gasPrice and reports zero priority fees instead of inventing them", async () => {
    const spec = { ...resolveChains("ethereum").specs[0], rpcUrl: "https://legacy.example/rpc", eip1559: false };
    stubFetch((_url, method) => {
      if (method === "eth_gasPrice") return { status: 200, body: { jsonrpc: "2.0", id: 1, result: gwei(25) } };
      if (method === "eth_blockNumber") return { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0x3e8" } };
      return { status: 500, body: {} };
    });
    const data = await fetchGasData(spec, 5, 60_000);
    expect(data.snapshot.blockNumber).toBe(1000);
    expect(data.snapshot.baseFeeWei).toBe(25_000_000_000n);
    expect(data.snapshot.nextBaseFeeWei).toBe(25_000_000_000n);
    expect(data.snapshot.priority).toEqual({ slow: 0n, normal: 0n, fast: 0n });
    expect(data.congestion).toBeNull();
    expect(data.blobBaseFeeGwei).toBeNull();
    expect(data.gasUsedRatio).toEqual([]);
  });

  it("still returns data if the block-number call fails but gasPrice succeeds", async () => {
    const spec = { ...resolveChains("base").specs[0], rpcUrl: "https://legacy2.example/rpc", eip1559: false };
    stubFetch((_url, method) =>
      method === "eth_gasPrice" ? { status: 200, body: { jsonrpc: "2.0", id: 1, result: gwei(30) } } : { status: 500, body: {} },
    );
    const data = await fetchGasData(spec, 5, 60_000);
    expect(data.snapshot.blockNumber).toBe(0);
    expect(data.snapshot.baseFeeWei).toBe(30_000_000_000n);
  });
});

describe("enriched paid responses", () => {
  it("GET /v1/gas now ships congestion, blob fees and a per-chain advice block", async () => {
    stubFetch(rpcOnlyRoute(FH_WIN));
    const res = mockRes();
    await handleGas(mockReq({ query: { chains: "kite" } }), res);
    expect(res.statusCode).toBe(200);
    const k = res.body.chains.kite;
    expect(k.congestion).toBeCloseTo(0.6, 9);
    expect(k.blobBaseFeeGwei).toBeCloseTo(0.02, 9);
    expect(k.advice.windowBlocks).toBe(5);
    expect(k.advice.currentBaseFeeGwei).toBe(15);
    expect(k.advice.trend).toBe("rising");
    expect(k.advice.recommendation).toBe("wait");
  });

  it("GET /v1/gas isolates chain failures: one dead node doesn't kill the response", async () => {
    stubFetch((url) =>
      url.includes("polygon-bor")
        ? { status: 500, body: {} }
        : { status: 200, body: { jsonrpc: "2.0", id: 1, result: FH } },
    );
    const res = mockRes();
    await handleGas(mockReq({ query: { chains: "arbitrum,polygon" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.chains.arbitrum).toBeTruthy();
    expect(res.body.failed.map((f: { chain: string }) => f.chain)).toEqual(["polygon"]);
  });

  it("GET /v1/history summarises the window and names the cheapest block", async () => {
    stubFetch(rpcOnlyRoute(FH_WIN));
    const res = mockRes();
    await handleHistory(mockReq({ query: { chains: "base", blocks: "10" } }), res);
    expect(res.statusCode).toBe(200);
    const b = res.body.chains.base;
    expect(b.gasUsedRatio).toEqual([0.4, 0.6, 0.8, 0.5, 0.7]);
    expect(b.blobBaseFeeGwei).toBeCloseTo(0.02, 9);
    expect(b.summary.min).toBe(10);
    expect(b.summary.median).toBe(12);
    expect(b.summary.max).toBe(14);
    expect(b.summary.trend).toBe("rising");
    expect(b.summary.cheapestBlockNumber).toBe(100);
    expect(b.summary.cheapestBaseFeeGwei).toBe(10);
  });

  it("POST /v1/estimate adds a USD cost when the native price is available", async () => {
    stubFetch((url) =>
      url.includes("coins.llama.fi")
        ? { status: 200, body: { coins: { "coingecko:ethereum": { price: 2500 } } } }
        : { status: 200, body: { jsonrpc: "2.0", id: 1, result: FH } },
    );
    const res = mockRes();
    await handleEstimate(mockReq({ body: { chain: "ethereum", gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.nativeUsdPrice).toBe(2500);
    // 3 gwei x 21000 gas = 6.3e-5 ETH @ $2500 = $0.1575
    expect(res.body.speeds.normal.costUsd).toBeCloseTo(0.1575, 6);
    expect(res.body.speeds.slow.costUsd).toBeCloseTo(0.11025, 6);
  });

  it("POST /v1/estimate degrades to native-only when the price upstream fails", async () => {
    stubFetch((url) =>
      url.includes("coins.llama.fi")
        ? { status: 500, body: {} }
        : { status: 200, body: { jsonrpc: "2.0", id: 1, result: FH } },
    );
    const res = mockRes();
    await handleEstimate(mockReq({ body: { chain: "polygon", gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.nativeUsdPrice).toBeNull();
    expect(res.body.speeds.normal.costUsd).toBeUndefined();
    expect(res.body.speeds.normal.costNative).toBeCloseTo(0.000063, 9);
  });

  it("POST /v1/estimate never calls the price upstream for a chain with no feed", async () => {
    stubFetch((url) => {
      if (url.includes("coins.llama.fi")) throw new Error("price upstream must not be called for Kite");
      return { status: 200, body: { jsonrpc: "2.0", id: 1, result: FH } };
    });
    const res = mockRes();
    await handleEstimate(mockReq({ body: { chain: "kite", gasLimit: 21000 } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.nativeUsdPrice).toBeNull();
    expect(res.body.speeds.normal.costUsd).toBeUndefined();
    // Derived from costWei so the assertion doesn't depend on which fixture the
    // per-chain cache happens to hold.
    expect(res.body.speeds.normal.costNative).toBeCloseTo(Number(BigInt(res.body.speeds.normal.costWei)) / 1e18, 12);
  });
});

describe("CORS", () => {
  it("answers OPTIONS preflight with 204 + CORS headers on paid routes", async () => {
    const r = await request(app).options("/v1/gas");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-allow-headers"]).toContain("X-PAYMENT");
  });
  it("exposes CORS headers on the 402 challenge", async () => {
    const r = await request(app).get("/v1/gas?chains=ethereum");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-expose-headers"]).toContain("payment-required");
  });
});
