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
import {provenance, stamp} from "../provenance.ts";

const WAD = 10n ** 18n;

async function inspect(address: Address, symbol: string): Promise<AllowlistEntry> {
  const c = chain();

  const slot = await c.client
    .getStorageAt({address, slot: BEACON_SLOT})
    .catch(() => "0x0000000000000000000000000000000000000000000000000000000000000000" as const);
  const actualBeacon = slot && slot.length === 66 ? `0x${slot.slice(26)}` : "0x";
  const beaconPass = actualBeacon.toLowerCase() === STOCK_TOKEN_BEACON.toLowerCase();

  let multiplier: bigint | null = null;
  try {
    multiplier = await read<bigint>(address, multiplierAbi, "uiMultiplier");
  } catch {
    // Absent rather than zero. A contract without the function is the signature
    // of an impostor, and that difference has to survive into the response.
    multiplier = null;
  }
  // parameter.md section 10.1. Four tokens have already moved above 1e18, so the
  // gate is "present and at least one", never "equal to one".
  const multiplierPass = multiplier !== null && multiplier >= WAD;

  const code = await c.client.getCode({address}).catch(() => undefined);
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
    const at = await stamp();
    const c = chain();

    const extra = request.query.token;
    if (extra !== undefined && !isAddress(extra)) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", `not an address: ${extra}`, {token: extra});
    }

    const entries: AllowlistEntry[] = [];
    for (const t of c.tokens) {
      entries.push(await inspect(t.token, t.symbol));
    }

    if (extra) {
      const address = getAddress(extra);
      const already = entries.some((e) => e.address.toLowerCase() === address.toLowerCase());
      if (!already) {
        let symbol = "unknown";
        try {
          symbol = await read<string>(address, erc20Abi, "symbol");
        } catch {
          // A contract that cannot name itself is still worth reporting on.
        }
        entries.push(await inspect(address, symbol));
      }
    }

    return {entries, provenance: provenance(at)};
  });
}
