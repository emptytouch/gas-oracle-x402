/**
 * Pure gas/fee math — no I/O, so it is unit-testable and deterministic.
 *
 * The upstream gives us `eth_feeHistory(blockCount, "latest", [p10,p50,p90])`:
 *   - `baseFeePerGas` has blockCount + 1 entries; the LAST one is the *next*
 *     block's base fee, which is what a wallet should actually bid against.
 *   - `reward[i]` holds the priority-fee percentiles observed in block i.
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
  // Keep 6 decimals of native-token precision without float overflow.
  const scaled = (cost * 1_000_000n) / denom;
  return { costWei: cost.toString(), costNative: Number(scaled) / 1_000_000 };
}
