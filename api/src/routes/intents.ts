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
import type {
  BatchIntentsResponse,
  IntentStatusResponse,
  OraclePriceRow,
  SignedIntent,
  SubmitIntentResponse,
} from "../../../packages/shared/api-types.ts";
import {isBatch, isValidBatchId, type BatchWindow} from "../../../packages/shared/batch.ts";
import {createChainReader} from "../../../packages/shared/batch-viem.ts";
import {
  chain,
  erc20Abi,
  mandateAbi,
  oracleAbi,
  permit2Abi,
  read,
  revertReason,
  sessionAbi,
  settlementAbi,
} from "../chain.ts";
import {badRequest, fail, notFound} from "../errors.ts";
import {canonicalPayload, escapeHatchFor, permit2EoaSignature, validateIntentPayload, witnessDigestNow} from "../intent.ts";
import {admit, openWindow, getByBatch, getByHash, sweep} from "../mempool.ts";
import {intentHash} from "../permit2.ts";
import {provenance, stamp, type BlockStamp} from "../provenance.ts";
import {SESSION_NAMES} from "./session.ts";

/** Settlement.SOLUTION_WINDOW, parameter.md section 6. Fixed across sessions. */
const SOLUTION_WINDOW = 10n;

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** EIP-1271, the four bytes a valid contract signature must return. */
const EIP1271_MAGIC = "0x1626ba7e";

/** EIP-7702's delegation designator prefix, docs/rencana-backend.md section 3C. */
const DELEGATION_PREFIX = "0xef0100";

/**
 * Collection is over once chain time passes collectEnd, which is the batchId.
 * The same predicate opens Settlement's solution window, so the feed's frozen
 * flag and the lifecycle's collect_closed can never disagree with the contract.
 */
export function isCollectClosed(batchId: bigint, chainTime: bigint): boolean {
  return chainTime > batchId;
}

export function intentRoutes(app: FastifyInstance) {
  app.post<{Body: {intent?: unknown; signature?: Hex}}>("/v1/intents", async (request): Promise<SubmitIntentResponse> => {
    const body = request.body;
    if (!body || !body.signature || !isHex(body.signature)) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "body needs an intent and a hex signature");
    }

    const c = chain();
    const at = await stamp();
    const intent = validateIntentPayload(body.intent);

    // Two intents no batch can ever settle, refused here rather than relayed.
    // Settlement pays buyToken to receiver with safeTransfer, which reverts for
    // the zero address and takes the whole finalize down with it, line 435. And
    // a pair of one token has no pool to quote a baseline from. Not in the
    // shared validator, so the escape hatch still encodes them. D15.
    if (BigInt(intent.receiver) === 0n) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "receiver is the zero address, and paying it reverts the whole batch");
    }
    if (intent.sellToken.toLowerCase() === intent.buyToken.toLowerCase()) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "sellToken and buyToken are the same token");
    }

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
      const asPermit2Reads = permit2EoaSignature(body.signature);
      if (!asPermit2Reads) {
        throw fail(
          401,
          "COORDINATOR_BAD_SIGNATURE",
          "Permit2 accepts 65 bytes with v at 27 or 28, or 64 bytes in EIP-2098 form, and this is neither",
          {verifiedDigest: digest, path: signatureKind},
        );
      }
      let recovered: Hex | null = null;
      try {
        recovered = await recoverAddress({hash: digest, signature: asPermit2Reads});
      } catch {
        // Malformed r, s or v never reaches recovery math worth naming, so it
        // is reported the same way a mismatch is rather than as a crash.
        recovered = null;
      }
      if (recovered?.toLowerCase() !== intent.owner.toLowerCase()) {
        throw fail(401, "COORDINATOR_BAD_SIGNATURE", `recovered ${recovered ?? "nothing"}, expected owner ${intent.owner}`, {
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
    // caller sees never depends on network timing. Settled rather than awaited
    // together, because a sellToken with no code makes balanceOf throw, and
    // that throw used to win over the TokenNotAllowed that step 4 owes. N2.
    //
    // Not pinned to at.number, unlike the feed. This route publishes no block,
    // and anvil stopped accepting connections under sixteen concurrent pinned
    // reads while blocks were being mined, measured 21 September 2026.
    const settled = await Promise.allSettled([
      read<boolean>(c.deployment.settlement, settlementAbi, "tokenAllowed", [intent.sellToken]),
      read<boolean>(c.deployment.settlement, settlementAbi, "tokenAllowed", [intent.buyToken]),
      read<bigint>(c.permit2, permit2Abi, "nonceBitmap", [intent.owner, intent.nonce >> 8n]),
      read<bigint>(intent.sellToken, erc20Abi, "balanceOf", [intent.owner]),
      read<bigint>(intent.sellToken, erc20Abi, "allowance", [intent.owner, c.permit2]),
    ]);
    const step = <T>(index: number): T => {
      const r = settled[index]!;
      if (r.status === "rejected") throw r.reason;
      return r.value as T;
    };

    if (!step<boolean>(0)) throw badRequest("TokenNotAllowed", `sellToken not allowed: ${intent.sellToken}`, {token: intent.sellToken});
    if (!step<boolean>(1)) throw badRequest("TokenNotAllowed", `buyToken not allowed: ${intent.buyToken}`, {token: intent.buyToken});

    const nonceBitmap = step<bigint>(2);
    const balance = step<bigint>(3);
    const allowance = step<bigint>(4);
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
    const windowAt = async (when: BlockStamp): Promise<BatchWindow> => {
      const lookup = await openWindow(when);
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
      return lookup;
    };

    // Every read above can take seconds, and a window chosen against the chain
    // time this request started with may have closed by now. An intent admitted
    // then sat pending in a batch solvers had already frozen. So chain time is
    // read once more with nothing asynchronous between it and admit, and the
    // window is chosen again if it has passed. D7.
    let lookup = await windowAt(at);
    for (let attempt = 0; ; attempt += 1) {
      const now = await stamp();
      if (now.timestamp < lookup.collectEnd) break;
      if (attempt === 2) {
        throw fail(503, "COORDINATOR_NO_OPEN_BATCH", "chain time kept passing collectEnd while this intent was checked", {
          reason: "window_closed",
        });
      }
      lookup = await windowAt(now);
    }

    // Step 9. Admitted, and the mempool is the single place both this route
    // and the solver feed read from, so they cannot disagree about who is in.
    const signed: SignedIntent = {
      intentHash: hash,
      intent: canonicalPayload(intent),
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

  app.get<{Params: {intentHash: string}}>(
    "/v1/intents/:intentHash",
    async (request): Promise<IntentStatusResponse> => {
      const raw = request.params.intentHash;
      if (!HASH_PATTERN.test(raw)) {
        throw notFound("COORDINATOR_INVALID_REQUEST", `not an intent hash: ${raw}`);
      }
      sweep((await stamp()).timestamp);
      const stored = getByHash(raw.toLowerCase());
      if (!stored) {
        throw notFound("COORDINATOR_INVALID_REQUEST", `no intent known for ${raw}`);
      }

      const decoded = validateIntentPayload(stored.signed.intent);
      const hatch = escapeHatchFor(decoded, stored.signed.signature);

      return {
        intentHash: stored.signed.intentHash,
        status: stored.status,
        intent: stored.signed.intent,
        batchId: String(stored.batchId),
        // The indexer is what fills these in. Not written yet, and null is the
        // honest answer rather than a guess dressed up as data.
        fill: null,
        rejection: stored.rejection,
        escapeHatch: {to: hatch.to, data: hatch.data, castCommand: hatch.castCommand},
      };
    },
  );

  app.get<{Params: {batchId: string}}>(
    "/v1/batches/:batchId/intents",
    async (request): Promise<BatchIntentsResponse> => {
      // batchId is a uint64 in the contract. BigInt took "-1", " 123 " and 2^256
      // as well, and the first read that had to encode one threw as a 502. And a
      // timestamp the calendar cannot place, zero among them, reverts in
      // sessionAt, which is an answer about the id rather than about the node. D11.
      const raw = request.params.batchId;
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) >= 1n << 64n) {
        throw badRequest("COORDINATOR_INVALID_REQUEST", "batchId is a decimal uint64", {batchId: raw});
      }
      const batchId = BigInt(raw);

      const c = chain();
      const at = await stamp();
      const reader = createChainReader(c.client, c.deployment.sessions);
      let valid: boolean;
      try {
        valid = await isValidBatchId(reader, batchId);
      } catch (error) {
        if (revertReason(error) === null) throw error;
        valid = false;
      }
      if (!valid) {
        throw badRequest(
          "COORDINATOR_INVALID_REQUEST",
          `batchId ${batchId} does not align to its session or sits in a guard band`,
          {batchId: String(batchId)},
        );
      }

      const session = await read<number>(c.deployment.sessions, sessionAbi, "sessionAt", [batchId], at.number);
      const [duration, maxDeviationBps] = await Promise.all([
        read<number>(c.deployment.sessions, sessionAbi, "batchDuration", [session], at.number),
        read<number>(c.deployment.sessions, sessionAbi, "maxDeviationBps", [session], at.number),
      ]);

      const collectEnd = batchId;
      const collectStart = batchId - BigInt(duration);
      const solveEnd = batchId + SOLUTION_WINDOW;

      // One token whose refPrice reverts, FeedNotSet or TwapSourceNotSet, used to
      // take the whole feed down with a 502. It is reported by name instead and
      // the other tokens are still served. A failure that is not a revert is the
      // node, and still fails the request. D10.
      const oracleUnavailable: BatchIntentsResponse["oracleUnavailable"] = [];
      const priced = await Promise.all(
        c.tokens.map(async (t): Promise<OraclePriceRow | null> => {
          let answer: [bigint, bigint, boolean];
          try {
            answer = await read<[bigint, bigint, boolean]>(c.deployment.oracle, oracleAbi, "refPrice", [t.token], at.number);
          } catch (error) {
            const reason = revertReason(error);
            if (reason === null) throw error;
            oracleUnavailable.push({token: t.token, symbol: t.symbol, reason});
            return null;
          }
          const [price, ts, healthy] = answer;
          return {
            token: t.token,
            symbol: t.symbol,
            decimals: t.decimals,
            // parameter.md section 4C. USD 18 decimals per smallest unit.
            price: String((price * 10n ** 18n) / 10n ** BigInt(t.decimals)),
            refPrice: String(price),
            healthy,
            updatedAt: Number(ts),
          };
        }),
      );
      const stockPrices = priced.filter((row): row is OraclePriceRow => row !== null);

      // USDG is the numeraire. PriceOracle tracks the stock tokens against it
      // and never USDG itself, so its row is the fixed peg rather than a read.
      const quoteRefPrice = 10n ** 18n;
      const quotePrice = (quoteRefPrice * 10n ** 18n) / 10n ** BigInt(c.quote.decimals);
      if (c.quote.decimals === 6 && quotePrice !== 10n ** 30n) {
        throw new Error(`USDG at 6 decimals must price to 1e30, computed ${quotePrice}. parameter.md section 4C`);
      }
      const oraclePrices: OraclePriceRow[] = [
        {
          token: c.quote.address,
          symbol: "USDG",
          decimals: c.quote.decimals,
          price: String(quotePrice),
          refPrice: String(quoteRefPrice),
          healthy: true,
          updatedAt: Number(at.timestamp),
        },
        ...stockPrices,
      ];

      return {
        batchId: String(batchId),
        session,
        sessionName: SESSION_NAMES[session]!,
        collectStartsAt: Number(collectStart),
        collectEndsAt: Number(collectEnd),
        solveEndsAt: Number(solveEnd),
        chainTime: Number(at.timestamp),
        frozen: isCollectClosed(batchId, at.timestamp),
        intents: getByBatch(batchId),
        oraclePrices,
        oracleUnavailable,
        maxDeviationBps,
        provenance: provenance(at),
      };
    },
  );
}
