// POST /v1/intents
//
// The coordinator's front door. Every check here mirrors a real contract check
// so a rejection at the API and the same rejection onchain read identically,
// docs/rencana-backend.md section 2.1 and 2.2.
//
// The owner's signature is verified against the Permit2 witness digest, never
// against the Intent hash alone, because the Intent hash is only the witness
// inside that digest. And the path taken to verify it, ECDSA recovery or
// EIP-1271, is chosen from whether the owner address carries code, never from
// what the client claims it signed with. A client cannot make itself trusted
// by asking nicely.

import type {FastifyInstance} from "fastify";
import {isHex, recoverAddress, type Hex} from "viem";
import type {SignedIntent, SubmitIntentResponse} from "../../../packages/shared/api-types.ts";
import {isBatch} from "../../../packages/shared/batch.ts";
import {chain, erc20Abi, mandateAbi, permit2Abi, read, settlementAbi} from "../chain.ts";
import {badRequest, fail} from "../errors.ts";
import {validateIntentPayload, witnessDigestNow} from "../intent.ts";
import {admit, currentWindow} from "../mempool.ts";
import {intentHash} from "../permit2.ts";
import {provenance, stamp} from "../provenance.ts";

/** EIP-1271, the four bytes a valid contract signature must return. */
const EIP1271_MAGIC = "0x1626ba7e";

/** EIP-7702's delegation designator prefix, docs/rencana-backend.md section 3C. */
const DELEGATION_PREFIX = "0xef0100";

export function intentRoutes(app: FastifyInstance) {
  app.post<{Body: {intent?: unknown; signature?: Hex}}>("/v1/intents", async (request): Promise<SubmitIntentResponse> => {
    const body = request.body;
    if (!body || !body.signature || !isHex(body.signature)) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "body needs an intent and a hex signature");
    }

    const c = chain();
    const at = await stamp();
    const intent = validateIntentPayload(body.intent);
    const hash = intentHash(intent);
    const digest = await witnessDigestNow(intent);

    // Step 3. The path is chosen from the owner's own code, not from anything
    // the client sent, because the client's word is exactly what this check
    // exists to not trust.
    const code = await c.client.getCode({address: intent.owner});
    const hasCode = !!code && code !== "0x";
    let signatureKind: "eoa" | "erc1271";

    if (!hasCode) {
      signatureKind = "eoa";
      const recovered = await recoverAddress({hash: digest, signature: body.signature});
      if (recovered.toLowerCase() !== intent.owner.toLowerCase()) {
        throw fail(401, "COORDINATOR_BAD_SIGNATURE", `recovered ${recovered}, expected owner ${intent.owner}`, {
          verifiedDigest: digest,
          path: signatureKind,
        });
      }
    } else {
      signatureKind = "erc1271";
      let returned: Hex | null = null;
      try {
        returned = await read<Hex>(intent.owner, mandateAbi, "isValidSignature", [digest, body.signature]);
      } catch {
        returned = null;
      }
      if (returned?.toLowerCase() !== EIP1271_MAGIC) {
        const delegated = code!.toLowerCase().startsWith(DELEGATION_PREFIX);
        const hint = delegated
          ? "owner carries an EIP-7702 delegation with no isValidSignature, docs/rencana-backend.md section 3C"
          : "isValidSignature did not return the EIP-1271 magic value";
        throw fail(401, "COORDINATOR_BAD_SIGNATURE", hint, {verifiedDigest: digest, path: signatureKind});
      }
    }

    // Steps 4 to 7 read four independent facts in parallel. They are reported
    // in table order regardless of which read finished first, so the failure a
    // caller sees never depends on network timing.
    const [sellAllowed, buyAllowed, nonceBitmap, balance, allowance] = await Promise.all([
      read<boolean>(c.deployment.settlement, settlementAbi, "tokenAllowed", [intent.sellToken]),
      read<boolean>(c.deployment.settlement, settlementAbi, "tokenAllowed", [intent.buyToken]),
      read<bigint>(c.permit2, permit2Abi, "nonceBitmap", [intent.owner, intent.nonce >> 8n]),
      read<bigint>(intent.sellToken, erc20Abi, "balanceOf", [intent.owner]),
      read<bigint>(intent.sellToken, erc20Abi, "allowance", [intent.owner, c.permit2]),
    ]);

    if (!sellAllowed) throw badRequest("TokenNotAllowed", `sellToken not allowed: ${intent.sellToken}`, {token: intent.sellToken});
    if (!buyAllowed) throw badRequest("TokenNotAllowed", `buyToken not allowed: ${intent.buyToken}`, {token: intent.buyToken});

    const nonceUsed = (nonceBitmap >> (intent.nonce % 256n)) % 2n === 1n;
    if (nonceUsed) {
      throw fail(409, "NonceAlreadyUsed", `nonce ${intent.nonce} already used by ${intent.owner}`, {
        owner: intent.owner,
        nonce: String(intent.nonce),
      });
    }

    if (balance < intent.sellAmount) {
      throw badRequest(
        "COORDINATOR_INSUFFICIENT_BALANCE",
        `owner holds ${balance}, sellAmount needs ${intent.sellAmount}`,
        {balance: String(balance), sellAmount: String(intent.sellAmount)},
      );
    }
    if (allowance < intent.sellAmount) {
      throw badRequest(
        "COORDINATOR_PERMIT2_NOT_APPROVED",
        `Permit2 allowance is ${allowance}, sellAmount needs ${intent.sellAmount}`,
        {allowance: String(allowance), sellAmount: String(intent.sellAmount)},
      );
    }

    // Step 8. The window this intent joins, and the same session bit check
    // Settlement._pull makes against collectEnd, contracts/src/Settlement.sol
    // line 387.
    const lookup = await currentWindow(at);
    if (!isBatch(lookup)) {
      throw fail(503, "COORDINATOR_NO_OPEN_BATCH", `no batch open right now: ${lookup.reason}`, {
        reason: lookup.reason,
      });
    }
    if (intent.validUntil < Number(lookup.collectEnd) || intent.validAfter > Number(lookup.collectEnd)) {
      throw badRequest("IntentExpired", "intent is not valid at this batch's collectEnd", {
        validAfter: intent.validAfter,
        validUntil: intent.validUntil,
        collectEnd: String(lookup.collectEnd),
      });
    }
    const sessionBit = 1 << lookup.session;
    if ((intent.allowedSessions & sessionBit) === 0) {
      throw badRequest("SessionNotAllowed", `session ${lookup.session} is not in allowedSessions`, {
        session: lookup.session,
        allowedSessions: intent.allowedSessions,
      });
    }

    // Step 9. Admitted, and the mempool is the single place both this route
    // and the solver feed read from, so they cannot disagree about who is in.
    const signed: SignedIntent = {
      intentHash: hash,
      intent: body.intent as SignedIntent["intent"],
      signature: body.signature,
      signatureKind,
      receivedAt: Number(at.timestamp),
    };
    admit(hash, signed, lookup.batchId);

    return {
      intentHash: hash,
      batchId: String(lookup.batchId),
      collectEndsAt: Number(lookup.collectEnd),
      solveEndsAt: Number(lookup.solveEnd),
      status: "pending",
      verifiedDigest: digest,
      indicativeBaseline: null,
    };
  });
}
