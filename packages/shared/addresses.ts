// Generated from docs/parameter.md section 10 and section 10.1. Numbers and
// addresses change there first, in the same pull request as the code change.
// Every address below was read back from mainnet 4663 on 16 September 2026.

export const CHAIN_ID_MAINNET = 4663;
export const CHAIN_ID_TESTNET = 46630;

export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const;
export const USDG_DECIMALS = 6;

export const STOCK_TOKEN_BEACON = "0xe10b6f6b275de231345c20d14ab812db62151b00" as const;
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// Not the canonical 0x1F98431c address. That one holds a different contract on
// this chain and answers neither getPool nor owner.
export const UNISWAP_V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;

export const STOCK_TOKENS = {
  NVDA: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  AAPL: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
  TSLA: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
  GOOGL: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
} as const;

export const ALLOWLIST_V1 = ["NVDA", "AAPL", "TSLA", "GOOGL"] as const;

// TSLA is the only one whose depth sits in fee 3000. Do not assume 500.
// usdgIsToken0 is false for TSLA and GOOGL, so derive zeroForOne from token0().
export const POOLS = {
  NVDA: {pool: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3", fee: 500, usdgIsToken0: true},
  AAPL: {pool: "0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D", fee: 500, usdgIsToken0: true},
  TSLA: {pool: "0xf4ACdAEEB7022862A763C9B1B885e11191c889E3", fee: 3000, usdgIsToken0: false},
  GOOGL: {pool: "0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7", fee: 500, usdgIsToken0: false},
} as const;

// Reads over an archive node, and it needs no DNS workaround from Indonesia.
export const RPC_MAINNET = "https://robinhood.drpc.org" as const;
export const RPC_TESTNET = "https://rpc.testnet.chain.robinhood.com" as const;
