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
import {recoverAddress} from "viem";
import type {EscapeHatchRequest, EscapeHatchResponse} from "../../../packages/shared/api-types.ts";
import {badRequest} from "../errors.ts";
import {escapeHatchFor, permit2EoaSignature, validateIntentPayload, witnessDigestNow} from "../intent.ts";
import {intentHash} from "../permit2.ts";
import {provenance, stamp} from "../provenance.ts";

export function escapeRoutes(app: FastifyInstance) {
  app.post<{Body: EscapeHatchRequest}>("/v1/intents/escape", async (request): Promise<EscapeHatchResponse> => {
    const body = request.body;
    if (!body || !body.signature) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "body needs an intent and a signature");
    }

    const at = await stamp();
    const intent = validateIntentPayload(body.intent);
    const hash = intentHash(intent);

    // Recovered against the Permit2 witness digest, not against the Intent hash.
    // The Intent hash is only the witness inside that digest, and checking it
    // directly would call a good signature bad and a bad one good.
    let signatureValid = false;
    try {
      const digest = await witnessDigestNow(intent);
      const asPermit2Reads = permit2EoaSignature(body.signature);
      const recovered = asPermit2Reads ? await recoverAddress({hash: digest, signature: asPermit2Reads}) : null;
      signatureValid = recovered?.toLowerCase() === intent.owner.toLowerCase();
    } catch {
      // A contract owner signs through EIP-1271 and will never recover here.
      // The check is advisory, so a failure to recover is reported as false
      // rather than raised.
      signatureValid = false;
    }

    // The payload goes back whether or not the signature recovered. Withholding
    // it would turn this route into one more place the coordinator gets to say
    // no, which is the thing it exists to route around.
    return {
      intentHash: hash,
      ...escapeHatchFor(intent, body.signature),
      signatureValid,
      provenance: provenance(at),
    };
  });
}
