// Proves that the witness digest the API computes is the one Permit2 verifies.
//
// This is the check docs/rencana-backend.md schedules for day two, and it is
// worth running before any coordinator code exists. A digest that is merely
// self consistent will sign, store and relay perfectly well, then revert at
// finalize with InvalidSigner and nothing saying which of the eight inputs was
// wrong. Recovering the signature locally would not catch it either, because
// local recovery agrees with whatever local encoding produced it.
//
// So the proof goes through the deployed Permit2. A signature built from our
// digest is handed to permitWitnessTransferFrom, impersonating Settlement
// because Permit2 binds a signature to its own caller. If the tokens move, the
// digest matched. There is no weaker way to know.
//
// It moves tokens, so it snapshots first and reverts at the end.

import {readFileSync} from "node:fs";
import {createPublicClient, createWalletClient, custom, http, parseUnits} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {decodeIntent, intentHash, witnessDigest} from "../../api/src/permit2.ts";
import {initChain, chain} from "../../api/src/chain.ts";

const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));
const accounts = readJson("../accounts.json");

/**
 * Anvil's seventh default account, which infra/accounts.json calls user0. The
 * key is the published test key every anvil prints on startup and holds nothing
 * anywhere else. It is here rather than in accounts.json because this is the one
 * script that has to produce a real signature.
 */
const MNEMONIC =
  process.env.NOKTURN_FORK_MNEMONIC ??
  "spin skill strategy deal rebel image eager original crowd baby inhale calm";
/** Index six of that mnemonic, which infra/accounts.json calls user0. */
const USER_INDEX = 6;

const permit2Abi = [
  {
    type: "function",
    name: "permitWitnessTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple",
            components: [
              {name: "token", type: "address"},
              {name: "amount", type: "uint256"},
            ],
          },
          {name: "nonce", type: "uint256"},
          {name: "deadline", type: "uint256"},
        ],
      },
      {
        name: "transferDetails",
        type: "tuple",
        components: [
          {name: "to", type: "address"},
          {name: "requestedAmount", type: "uint256"},
        ],
      },
      {name: "owner", type: "address"},
      {name: "witness", type: "bytes32"},
      {name: "witnessTypeString", type: "string"},
      {name: "signature", type: "bytes"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bytes32"}],
  },
];

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{name: "a", type: "address"}],
    outputs: [{type: "uint256"}],
  },
];

const settlementAbi = [
  {
    type: "function",
    name: "WITNESS_TYPE_STRING",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "string"}],
  },
];

process.env.NOKTURN_API_RPC = RPC;
await initChain();
const c = chain();

const client = createPublicClient({chain: c.client.chain, transport: http(RPC)});
const rpc = (method, params) => client.transport.request({method, params});

const user = mnemonicToAccount(MNEMONIC, {addressIndex: USER_INDEX});
if (user.address.toLowerCase() !== accounts.users[0].toLowerCase()) {
  throw new Error(`mnemonic does not derive user0. got ${user.address}, expected ${accounts.users[0]}`);
}

function impersonated(from) {
  return createWalletClient({
    account: from,
    chain: c.client.chain,
    transport: custom({request: ({method, params}) => client.transport.request({method, params})}),
  });
}

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  ok    ${m}`);
};
const bad = (m) => {
  fail += 1;
  console.log(`  FAIL  ${m}`);
};

const snap = await rpc("evm_snapshot", []);
console.log(`snapshot ${snap}\n`);

try {
  const now = Number((await client.getBlock()).timestamp);
  const nvda = c.tokens.find((t) => t.symbol === "NVDA");
  const sellAmount = parseUnits("100", c.quote.decimals);

  const payload = {
    owner: user.address,
    receiver: user.address,
    sellToken: c.quote.address,
    buyToken: nvda.token,
    sellAmount: String(sellAmount),
    minBuyAmount: "1",
    validAfter: String(now - 60),
    validUntil: String(now + 3600),
    flags: "1",
    kind: "0",
    maxDevFromRefBps: "0",
    // CLOSED_WEEKEND, SessionMask bit 6.
    allowedSessions: String(1 << 6),
    batchSpan: "1",
    nonce: "7",
  };
  const intent = decodeIntent(payload);

  const [domainSeparator, witnessTypeString] = await Promise.all([
    client.readContract({address: c.permit2, abi: permit2Abi, functionName: "DOMAIN_SEPARATOR"}),
    client.readContract({
      address: c.deployment.settlement,
      abi: settlementAbi,
      functionName: "WITNESS_TYPE_STRING",
    }),
  ]);

  const digest = witnessDigest({
    domainSeparator,
    witnessTypeString,
    intent,
    spender: c.deployment.settlement,
  });
  const witness = intentHash(intent);

  console.log(`  intent hash   ${witness}`);
  console.log(`  permit2 digest ${digest}\n`);

  const signature = await user.sign({hash: digest});

  const before = await client.readContract({
    address: c.quote.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [c.deployment.settlement],
  });

  // Permit2 binds a signature to its own msg.sender, so this has to arrive as
  // Settlement or it is not the signature Permit2 was given.
  await rpc("anvil_setBalance", [c.deployment.settlement, "0x56bc75e2d63100000"]);
  const gasFunds = await client.getBalance({address: c.deployment.settlement});
  console.log(`  settlement gas balance ${gasFunds}`);
  const hash = await impersonated(c.deployment.settlement).writeContract({
    address: c.permit2,
    abi: permit2Abi,
    functionName: "permitWitnessTransferFrom",
    args: [
      {permitted: {token: intent.sellToken, amount: intent.sellAmount}, nonce: intent.nonce, deadline: BigInt(intent.validUntil)},
      {to: c.deployment.settlement, requestedAmount: intent.sellAmount},
      intent.owner,
      witness,
      witnessTypeString,
      signature,
    ],
    account: c.deployment.settlement,
    gas: 500_000n,
  });
  const receipt = await client.waitForTransactionReceipt({hash});

  if (receipt.status === "success") ok("Permit2 accepted a signature built from our digest");
  else bad("Permit2 rejected the signature, so the digest does not match");

  const after = await client.readContract({
    address: c.quote.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [c.deployment.settlement],
  });
  if (after - before === sellAmount) ok(`the tokens moved, ${after - before} raw units`);
  else bad(`balance moved by ${after - before}, expected ${sellAmount}`);

  // The wrong spender must fail, or the check above proves nothing about the
  // binding that stops anyone else spending the signature. An on chain revert
  // comes back as a receipt rather than as a thrown error once the gas limit is
  // given explicitly, so the status is what gets read.
  await rpc("anvil_setBalance", [accounts.solverA, "0x56bc75e2d63100000"]);
  const stolen = await impersonated(accounts.solverA).writeContract({
    address: c.permit2,
    abi: permit2Abi,
    functionName: "permitWitnessTransferFrom",
    args: [
      {permitted: {token: intent.sellToken, amount: intent.sellAmount}, nonce: 8n, deadline: BigInt(intent.validUntil)},
      {to: accounts.solverA, requestedAmount: intent.sellAmount},
      intent.owner,
      witness,
      witnessTypeString,
      signature,
    ],
    account: accounts.solverA,
    gas: 500_000n,
  });
  const stolenReceipt = await client.waitForTransactionReceipt({hash: stolen});
  if (stolenReceipt.status === "reverted") {
    ok("a different caller cannot spend it, so the spender binding holds");
  } else {
    bad("a different caller spent the same signature, so it is not bound to Settlement");
  }
} finally {
  const reverted = await rpc("evm_revert", [snap]);
  console.log(`\nreverted ${snap} -> ${reverted}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
