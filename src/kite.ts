import type { AssetAmount, MoneyParser, Network } from "@x402/core/types";

/**
 * One Kite network the wrapper can charge on. Only the stablecoin the Kite
 * facilitator settles for that network is listed: the payer signs an EIP-3009
 * transferWithAuthorization, so the asset must implement EIP-3009 and the
 * EIP-712 domain (name/version) must match the token contract exactly.
 */
export interface KiteChain {
  network: Network;
  rpcUrl: string;
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  eip712Name: string;
  eip712Version: string;
}

/** Kite mainnet: Bridged USDC (USDC.e), 6 decimals. */
export const KITE_MAINNET: KiteChain = {
  network: "eip155:2366",
  rpcUrl: "https://rpc.gokite.ai",
  assetAddress: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
  assetSymbol: "USDC.e",
  assetDecimals: 6,
  eip712Name: "Bridged USDC (Kite AI)",
  eip712Version: "2",
};

/** Kite testnet: pieUSD, 18 decimals. Kite Passport sandbox agents pay with this. */
export const KITE_TESTNET: KiteChain = {
  network: "eip155:2368",
  rpcUrl: "https://rpc-testnet.gokite.ai",
  assetAddress: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
  assetSymbol: "pieUSD",
  assetDecimals: 18,
  eip712Name: "pieUSD",
  eip712Version: "1",
};

/**
 * Facilitator that verifies and settles on both Kite networks. The x402 SDK
 * appends /verify, /settle and /supported, so keep the /v2 prefix.
 */
export const FACILITATOR_URL = "https://facilitator.pieverse.io/v2";

export function kiteChainByName(name: string | undefined): KiteChain {
  switch ((name ?? "mainnet").trim()) {
    case "":
    case "mainnet":
      return KITE_MAINNET;
    case "testnet":
      return KITE_TESTNET;
    default:
      throw new Error(`unknown KITE_NETWORK "${name}" (want mainnet or testnet)`);
  }
}

/**
 * Lets routes be priced as "$0.001" on Kite networks. The x402 SDK only knows
 * default stablecoins for a fixed set of chains; this parser adds the Kite
 * ones and pins the EIP-712 domain the facilitator expects.
 */
export function kiteMoneyParser(chain: KiteChain): MoneyParser {
  return async (amount: string | number, network: Network): Promise<AssetAmount | null> => {
    if (network !== chain.network) return null;
    // The SDK hands over the numeric part of "$0.001" (as number or string).
    // Do integer math on the decimal string to avoid float rounding.
    const text = typeof amount === "number" ? amount.toFixed(chain.assetDecimals) : amount.trim().replace(/^\$/, "");
    if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) throw new Error(`price must be a positive decimal, got ${amount}`);
    const [whole, frac = ""] = text.split(".");
    if (frac.length > chain.assetDecimals) throw new Error(`price ${text} has more than ${chain.assetDecimals} decimals (${chain.assetSymbol})`);
    const units = BigInt(whole + frac.padEnd(chain.assetDecimals, "0"));
    if (units <= 0n) throw new Error(`price ${amount} is below one unit of ${chain.assetSymbol}`);
    return {
      asset: chain.assetAddress,
      amount: units.toString(),
      extra: { name: chain.eip712Name, version: chain.eip712Version },
    };
  };
}
