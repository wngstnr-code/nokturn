// Hands the demo accounts real mainnet tokens, then opens the Permit2 approval
// every intent needs, then bonds both solvers.
//
// The source of tokens is the Uniswap V3 pool for each pair, impersonated. A
// plain ERC20 transfer out of a V3 pool moves the pool's balance and touches
// neither slot0 nor liquidity, so quoteFromState answers exactly the same number
// before and after. Verified on the fork, and the check is at the bottom of this
// file so it is not something anyone has to take on trust.
//
// Set NOKTURN_FUNDING_SOURCE to override with a real holder address if the team
// would rather not lean on that property.

import {readFileSync} from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  erc20Abi,
  parseUnits,
  formatUnits,
  maxUint256,
} from "viem";

const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));

const chain = read("../chain.json");
const accounts = read("../accounts.json");
const deployment = read("../fork-deployment.json");

const forkChain = {
  id: chain.chainId,
  name: "robinhood-fork",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [RPC]}},
};

const publicClient = createPublicClient({chain: forkChain, transport: http(RPC)});

const ETH_EACH = parseUnits("100", 18);
const STOCK_EACH = parseUnits("20", 18);
const USDG_PER_USER = parseUnits("10000", 6);
const USDG_PER_SOLVER = parseUnits("5000", 6);
const BOND = parseUnits("500", 6);

const registryAbi = [
  {
    type: "function",
    name: "bond",
    stateMutability: "nonpayable",
    inputs: [{name: "amount", type: "uint256"}],
    outputs: [],
  },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [{name: "solver", type: "address"}],
    outputs: [{type: "bool"}],
  },
];

function walletFor(address) {
  // anvil runs with --auto-impersonate, so eth_sendTransaction is accepted from
  // any address on this chain and no private key is needed anywhere.
  return createWalletClient({
    account: address,
    chain: forkChain,
    transport: custom({
      request: ({method, params}) => publicClient.transport.request({method, params}),
    }),
  });
}

async function rpc(method, params) {
  return publicClient.transport.request({method, params});
}

async function send(from, request) {
  const hash = await walletFor(from).writeContract({...request, account: from});
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
  return receipt;
}

const users = accounts.users;
const solvers = [accounts.solverA, accounts.solverB];
const everyone = [...users, ...solvers, accounts.deployer, accounts.proposer, accounts.guardian];

async function main() {
  const id = await publicClient.getChainId();
  if (id !== chain.chainId) throw new Error(`fork says chain ${id}, expected ${chain.chainId}`);

  console.log("funding gas");
  for (const a of [...everyone, ...Object.values(chain.tokens).map((t) => t.pool)]) {
    await rpc("anvil_setBalance", [a, `0x${ETH_EACH.toString(16)}`]);
  }

  const usdgSource = process.env.NOKTURN_FUNDING_SOURCE ?? chain.tokens.NVDA.pool;
  const quoteBefore = await quoteNvda();

  console.log("moving stock tokens out of their pools");
  for (const [symbol, t] of Object.entries(chain.tokens)) {
    for (const user of users) {
      await send(t.pool, {
        address: t.token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [user, STOCK_EACH],
      });
    }
    console.log(`  ${symbol} ${formatUnits(STOCK_EACH, 18)} to each of ${users.length} users`);
  }

  console.log("moving USDG");
  for (const user of users) {
    await send(usdgSource, {
      address: chain.usdg,
      abi: erc20Abi,
      functionName: "transfer",
      args: [user, USDG_PER_USER],
    });
  }
  for (const solver of solvers) {
    await send(usdgSource, {
      address: chain.usdg,
      abi: erc20Abi,
      functionName: "transfer",
      args: [solver, USDG_PER_SOLVER],
    });
  }

  // Permit2 pulls with transferFrom, so the token allowance is what makes every
  // later signature spendable. Without this the intent verifies and finalize
  // still reverts.
  console.log("approving Permit2 on every sell side token");
  const sellables = [chain.usdg, ...Object.values(chain.tokens).map((t) => t.token)];
  for (const user of users) {
    for (const token of sellables) {
      await send(user, {
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [chain.permit2, maxUint256],
      });
    }
  }

  console.log("bonding both solvers");
  for (const solver of solvers) {
    await send(solver, {
      address: chain.usdg,
      abi: erc20Abi,
      functionName: "approve",
      args: [deployment.solvers, BOND],
    });
    await send(solver, {
      address: deployment.solvers,
      abi: registryAbi,
      functionName: "bond",
      args: [BOND],
    });
    const active = await publicClient.readContract({
      address: deployment.solvers,
      abi: registryAbi,
      functionName: "isActive",
      args: [solver],
    });
    console.log(`  ${solver} active=${active}`);
    if (!active) throw new Error("solver bonded but is not active");
  }

  const quoteAfter = await quoteNvda();
  console.log(`baseline quote before ${quoteBefore}`);
  console.log(`baseline quote after  ${quoteAfter}`);
  if (quoteBefore !== quoteAfter) {
    throw new Error("funding moved the baseline quote, which it must never do");
  }
  console.log("baseline unchanged, funding done");
}

async function quoteNvda() {
  return publicClient.readContract({
    address: deployment.adapter,
    abi: [
      {
        type: "function",
        name: "quoteFromState",
        stateMutability: "view",
        inputs: [
          {name: "tokenIn", type: "address"},
          {name: "tokenOut", type: "address"},
          {name: "amountIn", type: "uint256"},
        ],
        outputs: [{type: "uint256"}],
      },
    ],
    functionName: "quoteFromState",
    args: [chain.usdg, chain.tokens.NVDA.token, parseUnits("1000", 6)],
  });
}

await main();
