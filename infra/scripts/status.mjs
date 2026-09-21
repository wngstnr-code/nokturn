// One screen of what the fork currently says. The first thing to run when
// something behaves oddly, and the thing to paste into the standup.

import {readFileSync, existsSync} from "node:fs";
import {createPublicClient, http, erc20Abi, formatUnits, parseUnits} from "viem";

const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));
const path = (p) => new URL(p, here);

const chain = read("../chain.json");
const accounts = read("../accounts.json");
const pin = existsSync(path("../pinned-block.json")) ? read("../pinned-block.json") : null;
const deployment = existsSync(path("../fork-deployment.json")) ? read("../fork-deployment.json") : null;

const SESSION_NAMES = [
  "CLOSED_OVERNIGHT",
  "PRE_MARKET",
  "AUCTION_OPEN",
  "OPEN",
  "AUCTION_CLOSE",
  "POST_MARKET",
  "CLOSED_WEEKEND",
  "HOLIDAY",
  "PROTECTIVE",
];

const client = createPublicClient({
  chain: {
    id: chain.chainId,
    name: "robinhood-fork",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [RPC]}},
  },
  transport: http(RPC),
});

const sessionAbi = [
  view("currentSession", [], ["uint8"]),
  view("batchDuration", ["uint8"], ["uint32"]),
  view("maxDeviationBps", ["uint8"], ["uint16"]),
  view("inGuardBand", ["uint64"], ["bool"]),
  view("nextTransition", ["uint64"], ["uint64"]),
];
const settlementAbi = [
  view("batchWindow", ["uint64"], ["uint64", "uint64", "uint64"]),
  view("tokenAllowed", ["address"], ["bool"]),
  view("baselineAdapter", [], ["address"]),
  view("capPerBatchUsd", [], ["uint256"]),
  view("isPaused", [], ["bool"]),
];
const oracleAbi = [view("refPrice", ["address"], ["uint256", "uint64", "bool"])];
const registryAbi = [view("isActive", ["address"], ["bool"])];

function view(name, inputs, outputs) {
  return {
    type: "function",
    name,
    stateMutability: "view",
    inputs: inputs.map((type, i) => ({name: `a${i}`, type})),
    outputs: outputs.map((type) => ({type})),
  };
}

const row = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);

async function main() {
  const id = await client.getChainId();
  const block = await client.getBlock();
  const now = Number(block.timestamp);

  console.log("\nCHAIN");
  row("rpc", RPC);
  row("chain id", id);
  row("block", block.number);
  row("chain time", `${new Date(now * 1000).toISOString()} (${now})`);

  // A fork starts at its pinned block's timestamp and runs behind from that
  // moment on, and the gap widens with every restart. Anything that computes a
  // batchId from the laptop clock lands in the future and comes back
  // SolutionWindowClosed, with nothing in that error naming time. Finding R1.
  const drift = Math.floor(Date.now() / 1000) - now;
  const shape =
    drift > 120
      ? `${drift}s behind the laptop clock. use block.timestamp, never Date.now()`
      : `${drift}s from the laptop clock`;
  row("clock drift", shape);
  if (pin) row("pinned at", `${pin.block} ${pin.timestampUtc}`);

  if (!deployment) {
    console.log("\nno fork-deployment.json. run: make deploy\n");
    return;
  }

  const session = await client.readContract({
    address: deployment.sessions,
    abi: sessionAbi,
    functionName: "currentSession",
  });
  const duration = await client.readContract({
    address: deployment.sessions,
    abi: sessionAbi,
    functionName: "batchDuration",
    args: [session],
  });
  const band = await client.readContract({
    address: deployment.sessions,
    abi: sessionAbi,
    functionName: "maxDeviationBps",
    args: [session],
  });
  const nextTransition = await client.readContract({
    address: deployment.sessions,
    abi: sessionAbi,
    functionName: "nextTransition",
    args: [BigInt(now)],
  });

  console.log("\nSESSION");
  row("session", `${SESSION_NAMES[session]} (${session})`);
  row("batch duration", duration === 0 ? "0, auction phase, no ordinary batch" : `${duration}s`);
  row("price band", `${band} bps`);
  row("next transition", new Date(Number(nextTransition) * 1000).toISOString());

  if (duration > 0) {
    const d = BigInt(duration);
    const batchId = ((BigInt(now) / d) + 1n) * d;
    const guard = await client.readContract({
      address: deployment.sessions,
      abi: sessionAbi,
      functionName: "inGuardBand",
      args: [batchId],
    });
    console.log("\nNEXT BATCH");
    row("batchId", batchId);
    row("in guard band", guard);
    if (!guard) {
      const [collectStart, collectEnd, solveEnd] = await client.readContract({
        address: deployment.settlement,
        abi: settlementAbi,
        functionName: "batchWindow",
        args: [batchId],
      });
      row("collect", `${collectStart} .. ${collectEnd}`);
      row("solve closes", solveEnd);
      row("opens in", `${Number(collectEnd) - now}s`);
    }
  }

  console.log("\nSETTLEMENT");
  row("address", deployment.settlement);
  row("paused", await one(deployment.settlement, settlementAbi, "isPaused"));
  row("baseline adapter", await one(deployment.settlement, settlementAbi, "baselineAdapter"));
  row("cap per batch", `${formatUnits(await one(deployment.settlement, settlementAbi, "capPerBatchUsd"), 18)} USD`);

  console.log("\nTOKENS");
  for (const [symbol, t] of Object.entries(chain.tokens)) {
    const allowed = await client.readContract({
      address: deployment.settlement,
      abi: settlementAbi,
      functionName: "tokenAllowed",
      args: [t.token],
    });
    const [price, ts, healthy] = await client.readContract({
      address: deployment.oracle,
      abi: oracleAbi,
      functionName: "refPrice",
      args: [t.token],
    });
    let quote = "reverts";
    try {
      const out = await client.readContract({
        address: deployment.adapter,
        abi: [view("quoteFromState", ["address", "address", "uint256"], ["uint256"])],
        functionName: "quoteFromState",
        args: [chain.usdg, t.token, parseUnits("1000", chain.usdgDecimals)],
      });
      quote = `${Number(formatUnits(out, 18)).toFixed(6)} ${symbol}`;
    } catch {
      /* left as reverts, which is a real answer and not an error here */
    }
    row(
      symbol,
      `allowed=${allowed} ref=$${Number(formatUnits(price, 18)).toFixed(2)} healthy=${healthy} age=${now - Number(ts)}s  1000 USDG buys ${quote}`,
    );
  }

  console.log("\nACCOUNTS");
  for (const [name, address] of [
    ["solverA", accounts.solverA],
    ["solverB", accounts.solverB],
  ]) {
    const active = await client.readContract({
      address: deployment.solvers,
      abi: registryAbi,
      functionName: "isActive",
      args: [address],
    });
    row(name, `${address} bonded=${active}`);
  }
  for (const [i, user] of accounts.users.entries()) {
    const usdg = await client.readContract({
      address: chain.usdg,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    });
    const nvda = await client.readContract({
      address: chain.tokens.NVDA.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    });
    const allowance = await client.readContract({
      address: chain.tokens.NVDA.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [user, chain.permit2],
    });
    row(
      `user${i}`,
      `${user} ${formatUnits(usdg, 6)} USDG ${formatUnits(nvda, 18)} NVDA permit2=${allowance > 0n ? "ok" : "MISSING"}`,
    );
  }
  console.log("");
}

async function one(address, abi, functionName) {
  return client.readContract({address, abi, functionName});
}

await main();
