// The coordinator's frozen feed for one batch, turned into signed intents and a
// plan against one block of chain state.

import type {Address, PublicClient} from "viem";
import type {BatchIntentsResponse} from "../../packages/shared/api-types.ts";
import type {Profile} from "./account.ts";
import {API, quoteToken, type Contracts} from "./chain.ts";
import type {Intent} from "./solution.ts";
import {readInputs, solve, type Plan, type SignedIntent} from "./solve.ts";

export function toIntent(p: BatchIntentsResponse["intents"][number]["intent"]): Intent {
  return {
    owner: p.owner,
    receiver: p.receiver,
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    sellAmount: BigInt(p.sellAmount),
    minBuyAmount: BigInt(p.minBuyAmount),
    validAfter: Number(p.validAfter),
    validUntil: Number(p.validUntil),
    flags: Number(p.flags),
    kind: Number(p.kind),
    maxDevFromRefBps: Number(p.maxDevFromRefBps),
    allowedSessions: Number(p.allowedSessions),
    batchSpan: Number(p.batchSpan),
    nonce: BigInt(p.nonce),
  };
}

export async function feed(batchId: bigint): Promise<{body: BatchIntentsResponse; signed: SignedIntent[]}> {
  const res = await fetch(`${API}/v1/batches/${batchId}/intents`);
  if (!res.ok) throw new Error(`GET /v1/batches/${batchId}/intents answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as BatchIntentsResponse;
  return {body, signed: body.intents.map((s) => ({intent: toIntent(s.intent), signature: s.signature}))};
}

export function tokensOf(signed: SignedIntent[], quote: Address): Address[] {
  const set = new Map<string, Address>([[quote.toLowerCase(), quote]]);
  for (const {intent} of signed) for (const t of [intent.sellToken, intent.buyToken]) set.set(t.toLowerCase(), t);
  return [...set.values()];
}

export async function solveAt(c: PublicClient, k: Contracts, batchId: bigint, signed: SignedIntent[], solver: Address, block: bigint, profile: Profile = "a"): Promise<{plan: Plan; inputs: Awaited<ReturnType<typeof readInputs>>}> {
  const quote = await quoteToken(c);
  const inputs = await readInputs(c, k, batchId, tokensOf(signed, quote), block);
  return {plan: await solve(c, k, batchId, signed, quote, solver, inputs, profile), inputs};
}
