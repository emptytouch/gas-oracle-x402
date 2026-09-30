/**
 * Chain registry for the gas oracle.
 *
 * Every entry points at a **public JSON-RPC endpoint that needs no API key**, so
 * the service runs anywhere (Render free tier, a laptop, CI) without secrets.
 * All of them implement EIP-1559 `eth_feeHistory`, which is what makes the
 * premium endpoints possible (base-fee trend + priority-fee percentiles).
 *
 * Three env hooks keep ops flexible without touching code:
 *   - `RPC_URL_<CHAIN_ID>` overrides one endpoint (uppercase, `-` -> `_`).
 *   - `CHAINS` restricts the registry to a comma-separated subset.
 *   - `USD_PRICES=0` disables the (optional) native-token price lookup.
 */
const env = (key: string, fallback = ""): string => (process.env[key] ?? "").trim() || fallback;

export interface ChainSpec {
  id: string;
  label: string;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Supports eth_feeHistory (EIP-1559 fee market). */
  eip1559: boolean;
  /**
   * DeFiLlama / CoinGecko id for the native token, used only to turn a native
   * cost into USD. `null` = no public price, in which case USD fields are
   * omitted instead of failing the request.
   */
  coingeckoId: string | null;
}

const REGISTRY: ChainSpec[] = [
  { id: "ethereum", label: "Ethereum", rpcUrl: "https://ethereum-rpc.publicnode.com", nativeSymbol: "ETH", nativeDecimals: 18, eip1559: true, coingeckoId: "ethereum" },
  { id: "base", label: "Base", rpcUrl: "https://mainnet.base.org", nativeSymbol: "ETH", nativeDecimals: 18, eip1559: true, coingeckoId: "ethereum" },
  { id: "arbitrum", label: "Arbitrum One", rpcUrl: "https://arbitrum-one-rpc.publicnode.com", nativeSymbol: "ETH", nativeDecimals: 18, eip1559: true, coingeckoId: "ethereum" },
  { id: "optimism", label: "OP Mainnet", rpcUrl: "https://optimism-rpc.publicnode.com", nativeSymbol: "ETH", nativeDecimals: 18, eip1559: true, coingeckoId: "ethereum" },
  { id: "polygon", label: "Polygon PoS", rpcUrl: "https://polygon-bor-rpc.publicnode.com", nativeSymbol: "POL", nativeDecimals: 18, eip1559: true, coingeckoId: "polygon-ecosystem-token" },
  // Kite has no public USD price feed yet, so USD fields are simply omitted.
  { id: "kite", label: "Kite", rpcUrl: "https://rpc.gokite.ai", nativeSymbol: "KITE", nativeDecimals: 18, eip1559: true, coingeckoId: null },
  { id: "kite-testnet", label: "Kite Testnet", rpcUrl: "https://rpc-testnet.gokite.ai", nativeSymbol: "KITE", nativeDecimals: 18, eip1559: true, coingeckoId: null },
];

const envKeyFor = (id: string): string => `RPC_URL_${id.toUpperCase().replace(/-/g, "_")}`;

/** Registry with env overrides applied. */
export function allChains(): ChainSpec[] {
  const enabled = env("CHAINS");
  let list = REGISTRY;
  if (enabled) {
    const want = new Set(
      enabled
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    list = list.filter((c) => want.has(c.id));
  }
  return list.map((c) => {
    const override = env(envKeyFor(c.id));
    return override ? { ...c, rpcUrl: override } : c;
  });
}

/** Normalise a comma-separated list of chain ids. */
export function parseChainIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Resolve requested ids against the registry, collecting unknown ones. */
export function resolveChains(raw: string): { specs: ChainSpec[]; missing: string[] } {
  const byId = new Map(allChains().map((c) => [c.id, c]));
  const specs: ChainSpec[] = [];
  const missing: string[] = [];
  for (const id of parseChainIds(raw)) {
    const spec = byId.get(id);
    if (spec) specs.push(spec);
    else missing.push(id);
  }
  return { specs, missing };
}
