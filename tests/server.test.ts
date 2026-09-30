import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, createRateLimiter, handleEstimate, handleGas, handleHistory } from "../src/index.js";
import { estimateCost, hexToBigInt, historyFromFeeHistory, snapshotFromFeeHistory, weiToGwei } from "../src/gasmath.js";
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
