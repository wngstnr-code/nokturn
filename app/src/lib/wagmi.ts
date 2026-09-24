import {createConfig, http} from "wagmi";
// Imported from core rather than from wagmi/connectors. That barrel also pulls the
// Base account connector, whose dependency chain reaches an x402 module that is not
// installed, and the whole app fails to compile over a connector we do not offer.
import {injected} from "@wagmi/core";
import {robinhoodMainnet, robinhoodTestnet} from "./chain";

/// Testnet first because it is the only chain where Nokturn is deployed. A user
/// landing on mainnet would be connected to a chain with no protocol on it.
export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet, robinhoodMainnet],
  connectors: [injected()],
  transports: {
    [robinhoodTestnet.id]: http(robinhoodTestnet.rpcUrls.default.http[0]),
    [robinhoodMainnet.id]: http(robinhoodMainnet.rpcUrls.default.http[0]),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
