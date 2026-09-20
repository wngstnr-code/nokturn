// Pulls the state the demo reads into the fork cache, so that nothing stalls on
// a cold fetch in the middle of a demo.
//
// A forked anvil fetches state lazily, and the first call that reaches a cold
// slot pays a round trip to the upstream endpoint. The quotes below are the
// point of this script rather than a sanity check, because walking a swap is
// what pulls in tickBitmap words and tick entries, and those are the slowest
// reads on the baseline path.
//
// This does not enable an offline mode. anvil --dump-state does not carry every
// slot a fork fetched, measured 20 September 2026, so a reload answers slot0 and
// then zero for liquidity. Use make snapshot for resets instead.

import {readFileSync} from "node:fs";
import {createPublicClient, http, erc20Abi, parseUnits} from "viem";

const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));

const chain = read("../chain.json");
const deployment = read("../fork-deployment.json");

const client = createPublicClient({
  chain: {
    id: chain.chainId,
    name: "robinhood-fork",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [RPC]}},
  },
  transport: http(RPC),
});

const poolAbi = [
  fn("slot0", [], ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"]),
  fn("liquidity", [], ["uint128"]),
  fn("fee", [], ["uint24"]),
  fn("tickSpacing", [], ["int24"]),
  fn("token0", [], ["address"]),
  fn("token1", [], ["address"]),
];
const feedAbi = [
  fn("decimals", [], ["uint8"]),
  fn("latestRoundData", [], ["uint80", "int256", "uint256", "uint256", "uint80"]),
];
const adapterAbi = [fn("quoteFromState", ["address", "address", "uint256"], ["uint256"])];
const multiplierAbi = [fn("uiMultiplier", [], ["uint256"])];
const permit2Abi = [
  fn("DOMAIN_SEPARATOR", [], ["bytes32"]),
  fn("nonceBitmap", ["address", "uint256"], ["uint256"]),
];

function fn(name, inputs, outputs) {
  return {
    type: "function",
    name,
    stateMutability: "view",
    inputs: inputs.map((type, i) => ({name: `a${i}`, type})),
    outputs: outputs.map((type) => ({type})),
  };
}

let reads = 0;
async function touch(label, promise) {
  try {
    await promise;
    reads += 1;
  } catch (error) {
    console.log(`  cold read failed, ${label}: ${String(error).split("\n")[0]}`);
  }
}

// Sizes chosen to walk progressively further across the tick bitmap. The last
// one is far above CAP_PER_BATCH on purpose, so that a demo at an unusual size
// is not the first call to go cold.
const SIZES_USDG = ["1", "100", "1000", "5000", "25000", "100000"];
const SIZES_STOCK = ["0.01", "1", "20", "100"];

async function main() {
  console.log(`prewarming against ${RPC}`);

  for (const [symbol, t] of Object.entries(chain.tokens)) {
    await touch(symbol, client.readContract({address: t.token, abi: erc20Abi, functionName: "decimals"}));
    await touch(
      `${symbol} totalSupply`,
      client.readContract({address: t.token, abi: erc20Abi, functionName: "totalSupply"}),
    );
    await touch(
      `${symbol} uiMultiplier`,
      client.readContract({address: t.token, abi: multiplierAbi, functionName: "uiMultiplier"}),
    );
    // The ERC-1967 beacon slot is what StockTokenGate checks.
    await touch(
      `${symbol} beacon slot`,
      client.getStorageAt({
        address: t.token,
        slot: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
      }),
    );
    for (const call of poolAbi) {
      await touch(`${symbol} pool ${call.name}`, client.readContract({address: t.pool, abi: poolAbi, functionName: call.name}));
    }
    for (const call of feedAbi) {
      await touch(`${symbol} feed ${call.name}`, client.readContract({address: t.feed, abi: feedAbi, functionName: call.name}));
    }
    for (const size of SIZES_USDG) {
      await touch(
        `${symbol} quote in ${size}`,
        client.readContract({
          address: deployment.adapter,
          abi: adapterAbi,
          functionName: "quoteFromState",
          args: [chain.usdg, t.token, parseUnits(size, chain.usdgDecimals)],
        }),
      );
    }
    for (const size of SIZES_STOCK) {
      await touch(
        `${symbol} quote out ${size}`,
        client.readContract({
          address: deployment.adapter,
          abi: adapterAbi,
          functionName: "quoteFromState",
          args: [t.token, chain.usdg, parseUnits(size, t.decimals)],
        }),
      );
    }
    console.log(`  ${symbol} warmed`);
  }

  await touch("usdg decimals", client.readContract({address: chain.usdg, abi: erc20Abi, functionName: "decimals"}));
  await touch(
    "permit2 domain",
    client.readContract({address: chain.permit2, abi: permit2Abi, functionName: "DOMAIN_SEPARATOR"}),
  );
  await touch("permit2 code", client.getBytecode({address: chain.permit2}));

  for (const [name, address] of Object.entries(deployment)) {
    if (typeof address === "string" && address.startsWith("0x") && address.length === 42) {
      await touch(`${name} code`, client.getBytecode({address}));
    }
  }

  console.log(`warmed ${reads} reads`);
  console.log("cache warm. take a reset point with: make snapshot");
}

await main();
