// GET /v1/nonces/:owner
//
// Nothing can be signed before this answers.
//
// Permit2 nonces are unordered and live in a bitmap, so there is no counter to
// increment and no way to pick a free one without asking the chain. The
// frontend needs this before it can build a single intent, which is why it is
// served here rather than left for the frontend to work out on its own.
//
// Cancelling targets Permit2, not Settlement. Settlement carries no
// invalidateNonce despite docs/interfaces.md section 3 listing one, and
// IPermit2 says as much in a comment above nonceBitmap. Building the cancel
// payload from the document would have produced calldata for a function that
// does not exist.

import type {FastifyInstance} from "fastify";
import {encodeFunctionData, getAddress, isAddress} from "viem";
import type {NonceResponse} from "../../../packages/shared/api-types.ts";
import {chain, permit2Abi, read} from "../chain.ts";
import {badRequest} from "../errors.ts";
import {env} from "../config.ts";
import {provenance, stamp} from "../provenance.ts";

/**
 * How many 256 bit words to scan before giving up. Four covers a thousand
 * nonces per owner, which is far past anything a demo or a real user reaches,
 * and it bounds the number of reads a single request can make.
 */
const MAX_WORDS = 4n;

function firstFreeBit(bitmap: bigint): number | null {
  for (let bit = 0n; bit < 256n; bit += 1n) {
    if ((bitmap >> bit) % 2n === 0n) return Number(bit);
  }
  return null;
}

export function nonceRoutes(app: FastifyInstance) {
  app.get<{Params: {owner: string}; Querystring: {nonce?: string}}>(
    "/v1/nonces/:owner",
    async (request): Promise<NonceResponse> => {
      const {owner} = request.params;
      if (!isAddress(owner)) {
        throw badRequest("COORDINATOR_INVALID_REQUEST", `not an address: ${owner}`, {owner});
      }

      const c = chain();
      const at = await stamp();
      const address = getAddress(owner);

      const scannedWords: NonceResponse["scannedWords"] = [];
      let next: bigint | null = null;

      for (let word = 0n; word < MAX_WORDS; word += 1n) {
        const bitmap = await read<bigint>(c.permit2, permit2Abi, "nonceBitmap", [address, word]);
        scannedWords.push({word: String(word), bitmap: String(bitmap)});
        const bit = firstFreeBit(bitmap);
        if (bit !== null) {
          // Permit2 splits a nonce into the word it lives in and the bit inside
          // that word, so the nonce is the word shifted up by eight plus the bit.
          next = word * 256n + BigInt(bit);
          break;
        }
      }

      if (next === null) {
        throw badRequest(
          "COORDINATOR_INVALID_REQUEST",
          `every nonce in the first ${MAX_WORDS} words is used for ${address}`,
          {owner: address},
        );
      }

      const response: NonceResponse = {
        owner: address,
        next: String(next),
        scannedWords,
        provenance: provenance(at),
      };

      const asked = request.query.nonce;
      if (asked !== undefined) {
        let nonce: bigint;
        try {
          nonce = BigInt(asked);
        } catch {
          throw badRequest("COORDINATOR_INVALID_REQUEST", "nonce is a decimal string", {nonce: asked});
        }
        const word = nonce >> 8n;
        const bit = nonce % 256n;
        const bitmap = await read<bigint>(c.permit2, permit2Abi, "nonceBitmap", [address, word]);
        const used = (bitmap >> bit) % 2n === 1n;
        const mask = 1n << bit;

        const data = encodeFunctionData({
          abi: permit2Abi,
          functionName: "invalidateUnorderedNonces",
          args: [word, mask],
        });

        response.cancel = {
          nonce: String(nonce),
          used,
          to: c.permit2,
          data,
          castCommand:
            `cast send ${c.permit2} "invalidateUnorderedNonces(uint256,uint256)" ` +
            `"${word}" "${mask}" --rpc-url ${env.rpc} --from ${address}`,
          describes: "Permit2.invalidateUnorderedNonces",
        };
      }

      return response;
    },
  );
}
