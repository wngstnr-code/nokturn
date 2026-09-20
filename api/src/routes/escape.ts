// POST /v1/intents/escape
//
// The censorship escape hatch.
//
// It hands back the calldata for Settlement.submitIntentOnchain so an owner can
// publish their own intent when this coordinator will not relay it. That is the
// only case that matters, so it deliberately does not require the coordinator
// to have accepted anything first. IntentStatusResponse carries an escape hatch
// too, but that one is reachable only for an intent already in the mempool,
// which is no use to somebody being refused.
//
// The single mempool is an acknowledged point of centralisation,
// docs/spek-teknis.md section 9.3, and this is the technical shape of that
// admission rather than a convenience.
//
// It encodes. It never signs and never sends.

import type {FastifyInstance} from "fastify";
import {encodeFunctionData, isAddress, recoverAddress, type Abi, type Hex} from "viem";
import type {EscapeHatchRequest, EscapeHatchResponse} from "../../../packages/shared/api-types.ts";
import {chain, permit2Abi, read, settlementAbi} from "../chain.ts";
import {badRequest} from "../errors.ts";
import {env} from "../config.ts";
import {decodeIntent, intentHash, witnessDigest, type DecodedIntent} from "../permit2.ts";
import {provenance, stamp} from "../provenance.ts";

const intentTuple = {
  name: "i",
  type: "tuple",
  components: [
    {name: "owner", type: "address"},
    {name: "receiver", type: "address"},
    {name: "sellToken", type: "address"},
    {name: "buyToken", type: "address"},
    {name: "sellAmount", type: "uint256"},
    {name: "minBuyAmount", type: "uint256"},
    {name: "validAfter", type: "uint32"},
    {name: "validUntil", type: "uint32"},
    {name: "flags", type: "uint8"},
    {name: "kind", type: "uint8"},
    {name: "maxDevFromRefBps", type: "uint16"},
    {name: "allowedSessions", type: "uint8"},
    {name: "batchSpan", type: "uint16"},
    {name: "nonce", type: "uint256"},
  ],
} as const;

const submitAbi: Abi = [
  {
    type: "function",
    name: "submitIntentOnchain",
    stateMutability: "nonpayable",
    inputs: [intentTuple, {name: "sig", type: "bytes"}],
    outputs: [],
  },
];

const REQUIRED = intentTuple.components.map((c) => c.name);

function validate(payload: unknown): DecodedIntent {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) throw badRequest("COORDINATOR_INVALID_REQUEST", "intent is missing");
  for (const field of REQUIRED) {
    if (p[field] === undefined || p[field] === null) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", `intent.${field} is missing`);
    }
  }
  for (const field of ["owner", "receiver", "sellToken", "buyToken"]) {
    if (!isAddress(String(p[field]))) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", `intent.${field} is not an address`);
    }
  }
  try {
    return decodeIntent(payload as never);
  } catch {
    throw badRequest(
      "COORDINATOR_INVALID_REQUEST",
      "sellAmount, minBuyAmount and nonce are decimal strings in the smallest unit",
    );
  }
}

export function escapeRoutes(app: FastifyInstance) {
  app.post<{Body: EscapeHatchRequest}>("/v1/intents/escape", async (request): Promise<EscapeHatchResponse> => {
    const body = request.body;
    if (!body || !body.signature) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "body needs an intent and a signature");
    }

    const c = chain();
    const at = await stamp();
    const intent = validate(body.intent);
    const hash = intentHash(intent);

    // Recovered against the Permit2 witness digest, not against the Intent hash.
    // The Intent hash is only the witness inside that digest, and checking it
    // directly would call a good signature bad and a bad one good.
    let signatureValid = false;
    try {
      const [domainSeparator, witnessTypeString] = await Promise.all([
        read<Hex>(c.permit2, permit2Abi, "DOMAIN_SEPARATOR"),
        read<string>(c.deployment.settlement, settlementAbi, "WITNESS_TYPE_STRING"),
      ]);
      const digest = witnessDigest({
        domainSeparator,
        witnessTypeString,
        intent,
        spender: c.deployment.settlement,
      });
      const recovered = await recoverAddress({hash: digest, signature: body.signature});
      signatureValid = recovered.toLowerCase() === intent.owner.toLowerCase();
    } catch {
      // A contract owner signs through EIP-1271 and will never recover here.
      // The check is advisory, so a failure to recover is reported as false
      // rather than raised.
      signatureValid = false;
    }

    const data = encodeFunctionData({
      abi: submitAbi,
      functionName: "submitIntentOnchain",
      args: [intent, body.signature],
    });

    // The payload goes back whether or not the signature recovered. Withholding
    // it would turn this route into one more place the coordinator gets to say
    // no, which is the thing it exists to route around.
    return {
      intentHash: hash,
      to: c.deployment.settlement,
      data,
      castCommand: `cast send ${c.deployment.settlement} ${data} --rpc-url ${env.rpc} --from ${intent.owner}`,
      describes: "Settlement.submitIntentOnchain",
      signatureValid,
      provenance: provenance(at),
    };
  });
}
