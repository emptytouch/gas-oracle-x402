/**
 * Pure gas/fee math — no I/O, so it is unit-testable and deterministic.
 *
 * The upstream gives us `eth_feeHistory(blockCount, "latest", [p10,p50,p90])`:
 *   - `baseFeePerGas` has blockCount + 1 entries; the LAST one is the *next*
 *     block's base fee, which is what a wallet should actually bid against.
 *   - `reward[i]` holds the priority-fee percentiles observed in block i.
 *   - `gasUsedRatio[i]` says how full block i was — a free congestion signal.
 * Averaging the percentiles over several blocks smooths out single-block noise
 * (a block full of MEV bundles can skew one sample badly).
 */

/** Parse an RPC hex quantity ("0x1b10f7f5") into a bigint; never throws. */
export function hexToBigInt(value: unknown): bigint {
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value !== "string" || !value.trim()) return 0n;
  try {
    return BigInt(value.trim());
  } catch {
    return 0n;
  }
}

/**
 * 1 gwei = 1e9 wei. Keeps **wei-level** precision (9 decimals), not 6: some L2s
 * (Optimism, Base) quote base fees in the hundreds of wei, and rounding to
 * 6 decimals would report them as a flat `0 gwei` — which reads as "free gas".
 * Gas prices are small enough that the Number conversion stays exact.
 */
export function weiToGwei(wei: bigint): number {
  return Number(wei) / 1_000_000_000;
}

export interface FeeSnapshot {
  /** Highest block the sample covers. */
  blockNumber: number;
  /** Base fee of that block. */
  baseFeeWei: bigint;
  /** Predicted base fee of the NEXT block — the number to bid against. */
  nextBaseFeeWei: bigint;
  /** Smoothed priority fees (p10 / p50 / p90 across the sampled blocks). */
  priority: { slow: bigint; normal: bigint; fast: bigint };
}

export function snapshotFromFeeHistory(fh: unknown): FeeSnapshot {
  const f = (fh ?? {}) as { baseFeePerGas?: unknown; reward?: unknown; oldestBlock?: unknown };
  const bases: bigint[] = Array.isArray(f.baseFeePerGas) ? f.baseFeePerGas.map(hexToBigInt) : [];
  const rewards: bigint[][] = Array.isArray(f.reward)
    ? f.reward.map((r) => (Array.isArray(r) ? r.map(hexToBigInt) : []))
    : [];

  const nextBaseFeeWei = bases.length ? bases[bases.length - 1] : 0n;
  const baseFeeWei = bases.length > 1 ? bases[bases.length - 2] : nextBaseFeeWei;

  // Average each percentile, ignoring zero/absent samples (empty blocks).
  const avgAt = (i: number): bigint => {
    const vals = rewards.map((r) => r[i] ?? 0n).filter((v) => v > 0n);
    if (!vals.length) return 0n;
    return vals.reduce((s, v) => s + v, 0n) / BigInt(vals.length);
  };

  const oldest = hexToBigInt(f.oldestBlock);
  const span = Math.max(rewards.length - 1, 0);

  return {
    blockNumber: Number(oldest) + span,
    baseFeeWei,
    nextBaseFeeWei,
    priority: { slow: avgAt(0), normal: avgAt(1), fast: avgAt(2) },
  };
}

export interface FeeHistorySeries {
  blockNumbers: number[];
  baseFeeGwei: number[];
  priority: { slow: number[]; normal: number[]; fast: number[] };
}

export function historyFromFeeHistory(fh: unknown): FeeHistorySeries {
  const f = (fh ?? {}) as { baseFeePerGas?: unknown; reward?: unknown; oldestBlock?: unknown };
  const bases: bigint[] = Array.isArray(f.baseFeePerGas) ? f.baseFeePerGas.map(hexToBigInt) : [];
  const rewards: bigint[][] = Array.isArray(f.reward)
    ? f.reward.map((r) => (Array.isArray(r) ? r.map(hexToBigInt) : []))
    : [];
  const oldest = Number(hexToBigInt(f.oldestBlock));
  const n = rewards.length;
  const at = (i: number): number[] => Array.from({ length: n }, (_, b) => weiToGwei(rewards[b][i] ?? 0n));

  return {
    blockNumbers: Array.from({ length: n }, (_, i) => oldest + i),
    baseFeeGwei: Array.from({ length: n }, (_, i) => weiToGwei(bases[i] ?? 0n)),
    priority: { slow: at(0), normal: at(1), fast: at(2) },
  };
}

/**
 * Cost of a transaction at a given all-in gas price.
 * Returns both the exact wei amount and a human native-token amount.
 */
export function estimateCost(totalWei: bigint, gasLimit: bigint, decimals: number): { costWei: string; costNative: number } {
  const cost = totalWei * gasLimit;
  const denom = 10n ** BigInt(decimals);
  // 12 decimals, not 6: a plain 21k-gas transfer at ~2 gwei costs 0.0000441 ETH,
  // and truncating that to 6 decimals (0.000044) is a ~0.2% error that shows up
  // directly in the USD figure. 12 decimals keeps shake-level precision while the
  // bigint division still avoids float overflow.
  const scaled = (cost * 1_000_000_000_000n) / denom;
  return { costWei: cost.toString(), costNative: Number(scaled) / 1_000_000_000_000 };
}

// ---------------------------------------------------------------------------
// Congestion + blob fees: feeHistory already returns these, so surfacing them
// costs nothing extra (no additional RPC call).
// ---------------------------------------------------------------------------

/** Mean block fullness over the window (0 = empty, 1 = at the gas limit). */
export function avgGasUsedRatio(fh: unknown): number | null {
  const f = (fh ?? {}) as { gasUsedRatio?: unknown };
  if (!Array.isArray(f.gasUsedRatio) || !f.gasUsedRatio.length) return null;
  const vals = f.gasUsedRatio.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/**
 * Latest EIP-4844 blob base fee in gwei, or null when the node doesn't report a
 * *meaningful* one.
 *
 * OP-stack L2s (Base, OP Mainnet) answer `baseFeePerBlobGas: 0x1` — literally
 * 1 wei, the EIP-4844 floor — because they have no blob market at all. Shipping
 * that as `1e-9 gwei` would look like a real (if tiny) price, so anything at or
 * below the protocol floor is reported as "not applicable" instead.
 */
export function blobBaseFeeGwei(fh: unknown): number | null {
  const f = (fh ?? {}) as { baseFeePerBlobGas?: unknown };
  if (!Array.isArray(f.baseFeePerBlobGas) || !f.baseFeePerBlobGas.length) return null;
  const last = hexToBigInt(f.baseFeePerBlobGas[f.baseFeePerBlobGas.length - 1]);
  if (last <= 1n) return null;
  return weiToGwei(last);
}

// ---------------------------------------------------------------------------
// Advisory layer: turn a raw fee window into something an agent can act on.
// ---------------------------------------------------------------------------

export interface SeriesStats {
  min: number;
  median: number;
  max: number;
  mean: number;
}

export function seriesStats(values: number[]): SeriesStats {
  const vals = values.filter((v) => Number.isFinite(v));
  if (!vals.length) return { min: 0, median: 0, max: 0, mean: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return { min: sorted[0], median, max: sorted[sorted.length - 1], mean };
}

/** Where `value` sits inside `values`, as a 0–100 percentile (midpoint ties). */
export function percentilePosition(value: number, values: number[]): number {
  const vals = values.filter((v) => Number.isFinite(v));
  if (!vals.length) return 50;
  const below = vals.filter((v) => v < value).length;
  const equal = vals.filter((v) => v === value).length;
  return ((below + equal / 2) / vals.length) * 100;
}

export type Trend = "rising" | "falling" | "flat";

/** Compare the recent half of the window against the half before it. */
export function trendOf(values: number[]): Trend {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 4) return "flat";
  const half = Math.max(2, Math.floor(vals.length / 2));
  const recent = vals.slice(-half);
  const prior = vals.slice(-2 * half, -half);
  if (!prior.length) return "flat";
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
  const base = mean(prior);
  if (base <= 0) return "flat";
  const delta = (mean(recent) - base) / base;
  if (delta > 0.05) return "rising";
  if (delta < -0.05) return "falling";
  return "flat";
}

export interface GasAdvice {
  windowBlocks: number;
  currentBaseFeeGwei: number;
  minGwei: number;
  medianGwei: number;
  maxGwei: number;
  meanGwei: number;
  /** 0 = cheapest block in the window, 100 = most expensive. */
  percentile: number;
  trend: Trend;
  recommendation: "send_now" | "wait";
  /** Ready to drop into a tx: survives the base fee doubling. */
  suggestedMaxFeePerGasGwei: { slow: number; normal: number; fast: number };
  suggestedMaxPriorityFeePerGasGwei: { slow: number; normal: number; fast: number };
}

/**
 * Cheap to compute, expensive to get wrong: the base fee can rise 12.5% per
 * block, so `maxFeePerGas = 2 x nextBaseFee + priority` keeps a tx valid for
 * roughly six blocks while the sender still only pays the real base fee.
 */
export function adviceFrom(
  nextBaseFeeWei: bigint,
  priority: { slow: bigint; normal: bigint; fast: bigint },
  windowGwei: number[],
): GasAdvice {
  const stats = seriesStats(windowGwei);
  const current = weiToGwei(nextBaseFeeWei);
  const percentile = Math.round(percentilePosition(current, windowGwei) * 10) / 10;
  const maxFeeAt = (p: bigint): number => weiToGwei(nextBaseFeeWei * 2n + p);

  return {
    windowBlocks: windowGwei.length,
    currentBaseFeeGwei: current,
    minGwei: stats.min,
    medianGwei: stats.median,
    maxGwei: stats.max,
    meanGwei: stats.mean,
    percentile,
    trend: trendOf(windowGwei),
    // Below the 60th percentile of the recent window the fee is relatively
    // cheap; above it, waiting has historically paid off.
    recommendation: percentile <= 60 ? "send_now" : "wait",
    suggestedMaxFeePerGasGwei: {
      slow: maxFeeAt(priority.slow),
      normal: maxFeeAt(priority.normal),
      fast: maxFeeAt(priority.fast),
    },
    suggestedMaxPriorityFeePerGasGwei: {
      slow: weiToGwei(priority.slow),
      normal: weiToGwei(priority.normal),
      fast: weiToGwei(priority.fast),
    },
  };
}
