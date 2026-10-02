// GET /v1/allowlist
//
// The allowlist gate screen, docs/demo.md priority 1.
//
// It reports the raw value each check read, not just the verdict, because the
// point of the screen is that a judge can click through to Blockscout and see
// the same bytes. A screen that only says PASS is asking to be trusted.
//
// Any address can be checked through ?token=0x..., so the memecoin that trades
// under the GME symbol can be put next to the real one without that address
// being written into the code. Hardcoding a demo reject would make this a
// staged screen rather than a working gate.

import type {FastifyInstance} from "fastify";
import {getAddress, isAddress, type Address} from "viem";
import type {AllowlistEntry, AllowlistResponse} from "../../../packages/shared/api-types.ts";
import {
  BEACON_SLOT,
  STOCK_TOKEN_BEACON,
  chain,
  erc20Abi,
  explorerAddress,
  multiplierAbi,
  read,
} from "../chain.ts";
import {badRequest} from "../errors.ts";
import {provenance, recentStamp} from "../provenance.ts";

const WAD = 10n ** 18n;

// The three reads are independent, and so are the tokens, so they run together.
// One after another they took 17 seconds on Railway on 2 October 2026, about a
// second per call to the official RPC. All of them read the block the
// provenance names, rather than whatever latest is by the time each one lands.
async function inspect(address: Address, symbol: string, blockNumber: bigint): Promise<AllowlistEntry> {
  const c = chain();

  const [slot, multiplier, code] = await Promise.all([
    c.client
      .getStorageAt({address, slot: BEACON_SLOT, blockNumber})
      .catch(() => "0x0000000000000000000000000000000000000000000000000000000000000000" as const),
    // Absent rather than zero. A contract without the function is the signature
    // of an impostor, and that difference has to survive into the response.
    read<bigint>(address, multiplierAbi, "uiMultiplier", [], blockNumber).catch(() => null),
    c.client.getCode({address, blockNumber}).catch(() => undefined),
  ]);

  const actualBeacon = slot && slot.length === 66 ? `0x${slot.slice(26)}` : "0x";
  const beaconPass = actualBeacon.toLowerCase() === STOCK_TOKEN_BEACON.toLowerCase();

  // parameter.md section 10.1. Four tokens have already moved above 1e18, so the
  // gate is "present and at least one", never "equal to one".
  const multiplierPass = multiplier !== null && multiplier >= WAD;

  const codeSize = code ? (code.length - 2) / 2 : 0;
  // A real Stock Token is a beacon proxy, which is a few hundred bytes. The
  // memecoin measured in CLAUDE.md section 5 is 44.
  const codePass = codeSize > 100;

  const verdict = beaconPass && multiplierPass && codePass ? "pass" : "reject";

  const reasons: string[] = [];
  if (!beaconPass) reasons.push("ERC-1967 beacon slot does not hold the Stock Token beacon");
  if (!multiplierPass) {
    reasons.push(multiplier === null ? "uiMultiplier() is absent" : "uiMultiplier() is below 1e18");
  }
  if (!codePass) reasons.push(`code is ${codeSize} bytes, too small for a beacon proxy`);

  return {
    symbol,
    address,
    verdict,
    checks: {
      beaconSlot: {expected: STOCK_TOKEN_BEACON, actual: actualBeacon as `0x${string}`, pass: beaconPass},
      uiMultiplier: {value: multiplier === null ? null : String(multiplier), pass: multiplierPass},
      codeSize: {value: codeSize, pass: codePass},
    },
    reason: reasons.length ? reasons.join(". ") : undefined,
    explorerUrl: explorerAddress(address),
  };
}

export function allowlistRoutes(app: FastifyInstance) {
  app.get<{Querystring: {token?: string}}>("/v1/allowlist", async (request): Promise<AllowlistResponse> => {
    const at = await recentStamp();
    const c = chain();

    const extra = request.query.token;
    if (extra !== undefined && !isAddress(extra)) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", `not an address: ${extra}`, {token: extra});
    }

    const block = BigInt(at.number);
    const listed = c.tokens.map((t) => inspect(t.token, t.symbol, block));

    const address = extra ? getAddress(extra) : null;
    const checkExtra = address !== null && !c.tokens.some((t) => t.token.toLowerCase() === address.toLowerCase());
    // A contract that cannot name itself is still worth reporting on.
    const extraEntry = checkExtra ? read<string>(address, erc20Abi, "symbol", [], block).catch(() => "unknown").then((symbol) => inspect(address, symbol, block)) : null;

    const entries: AllowlistEntry[] = await Promise.all(listed);
    if (extraEntry) entries.push(await extraEntry);

    return {entries, provenance: provenance(at)};
  });
}
