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
import {publish} from "../events.ts";
import {admit, calendarReader, maxDeviationBps as deviationFor, committed, counts, frozenFeed, getByBatch, getByHash, openWindow, sweep, withdraw, withdrawnFrom} from "../mempool.ts";
import {intentHash} from "../permit2.ts";
import {provenance, recentStamp, stamp, type BlockStamp} from "../provenance.ts";
import {readFacts, screen} from "../revalidate.ts";
import {fillFor} from "./batches.ts";
import {SESSION_NAMES} from "./session.ts";

/** Settlement.SOLUTION_WINDOW, parameter.md section 6. Fixed across sessions. */
const SOLUTION_WINDOW = 10n;

/** Wide enough to stay quiet through ordinary Chainlink noise on a stablecoin. */
const USDG_PEG_WARN_BPS = 200n;

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

/**
 * Takes out every intent of the batch that Permit2 would refuse at this block.
 * Only meaningful up to solveEnd, see revalidate.ts, and callers check that.
 */
async function screenBatch(batchId: bigint, at: BlockStamp): Promise<void> {
  const list = [...getByBatch(batchId)];
  if (list.length === 0) return;
  const {withdrawn} = screen(list, await readFacts(list, at.number));
  for (const w of withdrawn) withdraw(w.intentHash, {...w.rejection, provenance: provenance(at)});
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

    // What the owner's earlier intents on this token still hold, read now so the
    // sum below can run with nothing asynchronous between it and admit. A prior
    // intent whose nonce is spent has already been pulled or burned, and one in
    // a batch past solveEnd with no winning solution can never be pulled. D4.
    const prior = committed(intent.owner, intent.sellToken);
    const priorFacts = prior.length ? await readFacts(prior.map((p) => p.signed)) : null;
    const unwinnable = new Set<bigint>();
    for (const batchId of new Set(prior.map((p) => p.batchId))) {
      if (at.timestamp <= batchId + SOLUTION_WINDOW) continue;
      const [winner] = await read<[Hex, bigint, Hex]>(c.deployment.settlement, settlementAbi, "bestSolution", [batchId]);
      if (BigInt(winner) === 0n) unwinnable.add(batchId);
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
      if (intent.validAfter > Number(lookup.collectEnd)) {
        throw badRequest("IntentExpired", "intent is not valid yet at this batch's collectEnd", {
          validAfter: intent.validAfter,
          validUntil: intent.validUntil,
          collectEnd: String(lookup.collectEnd),
        });
      }
      // Settlement._requireCollectable refuses validUntil <= solveEnd since
      // 0067794, so an intent that expires inside the solving window would be
      // accepted here and then sink every solution that includes it.
      const solveEnd = lookup.collectEnd + SOLUTION_WINDOW;
      if (intent.validUntil <= Number(solveEnd)) {
        throw badRequest("IntentExpired", "intent expires before this batch's solving window closes, so no solution could collect it", {
          validUntil: intent.validUntil,
          solveEnd: String(solveEnd),
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

    // Recounted here rather than trusting the list read above, because another
    // request may have admitted an intent for the same owner in between. Such an
    // intent has no prefetched nonce, so it counts as holding, which errs toward
    // refusing rather than toward a batch that unwinds.
    let held = 0n;
    for (const p of committed(intent.owner, intent.sellToken)) {
      if (unwinnable.has(p.batchId)) continue;
      if (priorFacts?.nonceUsed(intent.owner, BigInt(p.signed.intent.nonce))) continue;
      held += BigInt(p.signed.intent.sellAmount);
    }
    if (balance < held + intent.sellAmount) {
      throw badRequest(
        "COORDINATOR_INSUFFICIENT_BALANCE",
        `owner holds ${balance}, of which ${held} is committed to earlier intents, and sellAmount needs ${intent.sellAmount}`,
        {balance: String(balance), committed: String(held), sellAmount: String(intent.sellAmount)},
      );
    }
    if (allowance < held + intent.sellAmount) {
      throw badRequest(
        "COORDINATOR_PERMIT2_NOT_APPROVED",
        `Permit2 allowance is ${allowance}, of which ${held} is committed to earlier intents, and sellAmount needs ${intent.sellAmount}`,
        {allowance: String(allowance), committed: String(held), sellAmount: String(intent.sellAmount)},
      );
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
    publish(
      {
        type: "batch.intent_added",
        at: signed.receivedAt,
        data: {batchId: String(lookup.batchId), intentHash: hash, ...counts(lookup.batchId)},
      },
      {owner: intent.owner},
    );

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
      const now = await stamp();
      sweep(now.timestamp);
      const stored = getByHash(raw.toLowerCase());
      if (!stored) {
        throw notFound("COORDINATOR_INVALID_REQUEST", `no intent known for ${raw}`);
      }
      // Only while collection is open. After that the frozen feed decides, once,
      // so a status lookup can never change what solvers were already given. N3.
      if (stored.status === "pending" && !isCollectClosed(stored.batchId, now.timestamp)) {
        await screenBatch(stored.batchId, now);
      }

      const decoded = validateIntentPayload(stored.signed.intent);
      const hatch = escapeHatchFor(decoded, stored.signed.signature);
      // From the indexer's IntentSettled row. Without one, or with the database
      // down, the status stays what the coordinator knows and fill stays null.
      const fill = await fillFor(stored.signed.intentHash);

      return {
        intentHash: stored.signed.intentHash,
        status: fill ? (fill.partial ? "partially_settled" : "settled") : stored.status,
        intent: stored.signed.intent,
        batchId: String(stored.batchId),
        fill,
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

      // This is the feed a solver reads the moment collection closes, inside a ten
      // second window. It took five round trips one after another, eight to ten
      // seconds on the official RPC on 2 October 2026, so a solver could not
      // have submitted in time. The calendar answers now come from the reader
      // the batch check fills, and the screening and the prices run together.
      //
      // frozen comes from the head, and a solver refuses a feed that is not
      // frozen, so a head that is not yet past collectEnd is read again fresh.
      // One the lifecycle read a moment ago that is already past it can be used
      // as it is, because chain time only moves forward off a fork and a fresh
      // head could only say frozen too. That saves the solver's first request a
      // round trip. On a fork recentStamp always reads fresh.
      const c = chain();
      const reader = calendarReader();
      const head = async () => {
        const recent = await recentStamp();
        return isCollectClosed(batchId, recent.timestamp) ? recent : stamp();
      };
      const [at, valid] = await Promise.all([
        head(),
        isValidBatchId(reader, batchId).catch((error: unknown) => {
          if (revertReason(error) === null) throw error;
          return false;
        }),
      ]);
      if (!valid) {
        throw badRequest(
          "COORDINATOR_INVALID_REQUEST",
          `batchId ${batchId} does not align to its session or sits in a guard band`,
          {batchId: String(batchId)},
        );
      }

      const session = await reader.sessionAt(batchId);
      const [duration, maxDeviationBps] = await Promise.all([reader.batchDuration(session), deviationFor(session)]);

      const collectEnd = batchId;
      const collectStart = batchId - BigInt(duration);
      const solveEnd = batchId + SOLUTION_WINDOW;

      // N3. While collecting, screened on every request. Once frozen, screened
      // once at the first request and served unchanged after. A first request
      // that only arrives after solveEnd is not screened at all, because by then
      // finalize may have pulled the funds and every intent would look spent.
      const frozen = isCollectClosed(batchId, at.timestamp);
      // The screening and the oracle reads below only share the block, so they
      // run together.
      const screened = (async (): Promise<SignedIntent[]> => {
        if (!frozen) {
          await screenBatch(batchId, at);
          return getByBatch(batchId);
        }
        return frozenFeed(batchId, async () => {
          if (at.timestamp <= solveEnd) await screenBatch(batchId, at);
          return [...getByBatch(batchId)];
        });
      })();

      // One token whose refPrice reverts, FeedNotSet or TwapSourceNotSet, used to
      // take the whole feed down with a 502. It is reported by name instead and
      // the other tokens are still served. A failure that is not a revert is the
      // node, and still fails the request. D10.
      //
      // USDG is read like any other token, because Settlement._verify prices the
      // quote leg from refPrice(USDG) and the row a judge sees has to be the
      // figure the contract settles against. N8.
      const oracleUnavailable: BatchIntentsResponse["oracleUnavailable"] = [];
      const rows = [{token: c.quote.address, symbol: c.quote.symbol, decimals: c.quote.decimals}, ...c.tokens];
      const pricing = Promise.all(
        rows.map(async (t): Promise<OraclePriceRow | null> => {
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
      const [intents, priced] = await Promise.all([screened, pricing]);
      const oraclePrices = priced.filter((row): row is OraclePriceRow => row !== null);

      // A depeg is real data and is served as it is. It is only logged, so an
      // operator notices before a judge does. parameter.md section 4C.
      const quoteRow = oraclePrices.find((row) => row.token === c.quote.address);
      if (quoteRow) {
        const price = BigInt(quoteRow.price);
        const peg = 10n ** 30n;
        const drift = price > peg ? price - peg : peg - price;
        if (drift * 10_000n > peg * USDG_PEG_WARN_BPS) {
          request.log.warn({price: quoteRow.price, block: String(at.number)}, "USDG refPrice is more than 2% off 1e30");
        }
      }

      return {
        batchId: String(batchId),
        session,
        sessionName: SESSION_NAMES[session]!,
        collectStartsAt: Number(collectStart),
        collectEndsAt: Number(collectEnd),
        solveEndsAt: Number(solveEnd),
        chainTime: Number(at.timestamp),
        frozen,
        intents,
        oraclePrices,
        oracleUnavailable,
        withdrawn: withdrawnFrom(batchId),
        maxDeviationBps,
        provenance: provenance(at),
      };
    },
  );
}
