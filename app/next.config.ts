import path from "node:path";
import type {NextConfig} from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The repo root carries its own lockfile for api, solver and infra. Without
  // this Next picks that root and traces the whole monorepo into the output.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  experimental: {externalDir: true},
  env: {
    NOKTURN_RPC_MAINNET: process.env.NOKTURN_RPC_MAINNET ?? "https://robinhood.drpc.org",
    NOKTURN_RPC_TESTNET: process.env.NOKTURN_RPC_TESTNET ?? "https://robinhood-testnet.drpc.org",
  },
};

export default config;
