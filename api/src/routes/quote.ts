// GET /v1/quote
//
// The baseline. Every savings claim this protocol publishes is measured against
// the number this route returns, so it is read from the deployed adapter rather
// than recomputed here.
//
// That choice is deliberate and it is the whole reason this route is thin. The
// gate is zero difference against quoteFromState, and calling the same contract
// makes the difference zero by construction instead of by testing. Porting the
// tick crossing maths into TypeScript would create exactly the divergence risk
// the rule exists to prevent. docs/desain-baseline.md section 9.

import type {FastifyInstance} from "fastify";
import {isAddress, getAddress, type Address} from "viem";
import type {ApiErrorCode, BaselineQuote} from "../../../packages/shared/api-types.ts";
import {adapterAbi, chain, read} from "../chain.ts";
import {badRequest} from "../errors.ts";
import {provenance, stamp, verifiable} from "../provenance.ts";

/** Adapter revert names, docs/interfaces.md section 8B. */
const ADAPTER_REVERTS: Record<string, string> = {
  PoolNotSet: "the adapter holds no pool for this pair",
  PoolNotInitialized: "the pool exists but was never initialised",
  TokenNotInPool: "one of these tokens is not in that pool",
  LiquidityExhausted: "the pool cannot absorb this size from state",
  TooManyTickCrossings: "the walk passed MAX_TICK_CROSSINGS",
  DynamicFeeUnsupported: "the pool charges a dynamic fee, so state cannot price it",
};

function decimalsOf(address: Address): number {
  const c = chain();
  if (address.toLowerCase() === c.quote.address.toLowerCase()) return c.quote.decimals;
  const found = c.tokens.find((t) => t.token.toLowerCase() === address.toLowerCase());
  return found?.decimals ?? 18;
}

function poolFor(a: Address, b: Address): Address | undefined {
  const c = chain();
  const other = a.toLowerCase() === c.quote.address.toLowerCase() ? b : a;
  return c.tokens.find((t) => t.token.toLowerCase() === other.toLowerCase())?.pool;
}

export function quoteRoutes(app: FastifyInstance) {
  app.get<{Querystring: {sellToken?: string; buyToken?: string; sellAmount?: string}}>(
    "/v1/quote",
    async (request): Promise<BaselineQuote> => {
      const {sellToken, buyToken, sellAmount} = request.query;
      if (!sellToken || !buyToken || !sellAmount) {
        throw badRequest("COORDINATOR_INVALID_REQUEST", "sellToken, buyToken and sellAmount are all required");
      }
      if (!isAddress(sellToken) || !isAddress(buyToken)) {
        throw badRequest("COORDINATOR_INVALID_REQUEST", "sellToken and buyToken must be addresses");
      }
      let amount: bigint;
      try {
        amount = BigInt(sellAmount);
      } catch {
        throw badRequest(
          "COORDINATOR_INVALID_REQUEST",
          "sellAmount is a decimal string in the token's smallest unit, not a float",
          {sellAmount},
        );
      }
      if (amount <= 0n) {
        throw badRequest("COORDINATOR_INVALID_REQUEST", "sellAmount must be above zero", {sellAmount});
      }

      const c = chain();
      const at = await stamp();
      const sell = getAddress(sellToken);
      const buy = getAddress(buyToken);
      const pool = poolFor(sell, buy);

      let baselineBuy = 0n;
      let tickCrossings = 0;
      let loopSteps = 0;
      let unavailable: BaselineQuote["unavailable"] = null;

      try {
        const [out, crossings, steps] = await read<[bigint, number, number]>(
          c.deployment.adapter,
          adapterAbi,
          "quoteWithStats",
          [sell, buy, amount],
        );
        baselineBuy = out;
        tickCrossings = Number(crossings);
        loopSteps = Number(steps);
      } catch (error) {
        // A revert is a real answer here, not a failure of this endpoint. It is
        // the answer that forces a batch to pass through with zero fee, so it is
        // reported with the contract's own error name rather than swallowed.
        const name =
          (error as {cause?: {data?: {errorName?: string}}})?.cause?.data?.errorName ??
          (error as {cause?: {cause?: {data?: {errorName?: string}}}})?.cause?.cause?.data?.errorName ??
          "revert";
        unavailable = {
          code: (name === "revert" ? "COORDINATOR_UPSTREAM_DOWN" : name) as ApiErrorCode,
          reason: ADAPTER_REVERTS[name] ?? `the adapter reverted with ${name}`,
        };
      }

      return {
        sellToken: sell,
        buyToken: buy,
        sellAmount: String(amount),
        sellDecimals: decimalsOf(sell),
        baselineBuy: String(baselineBuy),
        buyDecimals: decimalsOf(buy),
        pool: pool ?? ("0x0000000000000000000000000000000000000000" as Address),
        tickCrossings,
        loopSteps,
        unavailable,
        verify: verifiable({
          to: c.deployment.adapter,
          abi: adapterAbi,
          functionName: "quoteFromState",
          args: [sell, buy, amount],
          at,
          expected: baselineBuy,
          describes: "UniswapV3Adapter.quoteFromState",
          signature: "quoteFromState(address,address,uint256)(uint256)",
          humanArgs: [sell, buy, String(amount)],
        }),
        provenance: provenance(at),
      };
    },
  );
}
