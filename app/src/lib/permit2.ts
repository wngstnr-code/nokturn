import {hashDomain, type Address, type Hex, type TypedDataDomain} from "viem";
import {INTENT_TYPES, type IntentMessage} from "./intent";
import {settlementAbi} from "./abi";
import {clientFor} from "./chain";

/*
 * Settlement._pull calls permit2.permitWitnessTransferFrom, so a signature over
 * the Intent struct alone verifies nowhere. contracts/src/Settlement.sol line 395.
 */

const PERMIT2_DOMAIN_NAME = "Permit2";

export const TOKEN_PERMISSIONS_TYPE = [
  {name: "token", type: "address"},
  {name: "amount", type: "uint256"},
] as const;

export const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    {name: "permitted", type: "TokenPermissions"},
    {name: "spender", type: "address"},
    {name: "nonce", type: "uint256"},
    {name: "deadline", type: "uint256"},
    {name: "witness", type: "Intent"},
  ],
  TokenPermissions: TOKEN_PERMISSIONS_TYPE,
  Intent: INTENT_TYPES.Intent,
} as const;

/* Permit2 has no version field. Adding one changes the separator. */
export const PERMIT2_DOMAIN_TYPE = [
  {name: "name", type: "string"},
  {name: "chainId", type: "uint256"},
  {name: "verifyingContract", type: "address"},
] as const;

export function permit2Domain(chainId: number, permit2: Address): TypedDataDomain {
  return {name: PERMIT2_DOMAIN_NAME, chainId, verifyingContract: permit2};
}

export function permit2DomainSeparator(chainId: number, permit2: Address): Hex {
  return hashDomain({
    domain: {name: PERMIT2_DOMAIN_NAME, chainId: BigInt(chainId), verifyingContract: permit2},
    types: {EIP712Domain: PERMIT2_DOMAIN_TYPE},
  });
}

/*
 * Rebuilt from the field list the wallet signs, not copied from the contract, so
 * a divergence surfaces as a WITNESS_TYPE_STRING mismatch rather than as a
 * signature nothing verifies.
 */
export function witnessTypeString(): string {
  const fields = INTENT_TYPES.Intent.map((field) => `${field.type} ${field.name}`).join(",");
  return `Intent witness)Intent(${fields})TokenPermissions(address token,uint256 amount)`;
}

export function permitWitnessMessage(intent: IntentMessage, spender: Address) {
  return {
    permitted: {token: intent.sellToken, amount: intent.sellAmount},
    spender,
    nonce: intent.nonce,
    // Settlement passes validUntil in as the Permit2 deadline.
    deadline: BigInt(intent.validUntil),
    witness: intent,
  };
}

export type SigningContext = {
  domain: TypedDataDomain;
  spender: Address;
  expectedDomainSeparator: Hex;
  onchainDomainSeparator: Hex | null;
  onchainWitnessTypeString: string | null;
  /** False means refuse to sign. A wrong digest fails silently, so it fails closed here. */
  ok: boolean;
  problem: string | null;
};

const permit2Abi = [
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bytes32"}],
  },
] as const;

/*
 * Both values are read, never copied. Permit2 rebuilds its separator off the
 * chain id and Settlement moves between fork, 46630 and mainnet, so a constant
 * is right on one chain and quietly wrong on the others.
 */
export async function signingContext(
  chainId: number,
  settlement: Address,
  permit2: Address,
): Promise<SigningContext> {
  const domain = permit2Domain(chainId, permit2);
  const expected = permit2DomainSeparator(chainId, permit2);

  let onchainSeparator: Hex | null = null;
  let onchainWitness: string | null = null;
  let problem: string | null = null;

  const client = clientFor(chainId);

  try {
    onchainSeparator = await client.readContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "DOMAIN_SEPARATOR",
    });
  } catch (error) {
    problem = `Permit2 did not answer DOMAIN_SEPARATOR. ${message(error)}`;
  }

  try {
    onchainWitness = (await client.readContract({
      address: settlement,
      abi: settlementAbi,
      functionName: "WITNESS_TYPE_STRING",
    })) as string;
  } catch (error) {
    problem = problem ?? `Settlement did not answer WITNESS_TYPE_STRING. ${message(error)}`;
  }

  if (problem === null && onchainSeparator !== null && onchainSeparator !== expected) {
    problem = `Permit2 reports domain separator ${onchainSeparator}, this app builds ${expected}`;
  }

  if (problem === null && onchainWitness !== null && onchainWitness !== witnessTypeString()) {
    problem = "Settlement WITNESS_TYPE_STRING does not match the Intent type this app signs";
  }

  return {
    domain,
    spender: settlement,
    expectedDomainSeparator: expected,
    onchainDomainSeparator: onchainSeparator,
    onchainWitnessTypeString: onchainWitness,
    ok: problem === null,
    problem,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? "read failed") : String(error);
}
