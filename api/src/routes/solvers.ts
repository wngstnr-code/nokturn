// GET /v1/solvers
//
// The scoreboard is derived entirely from settlement facts, so there is nothing
// self reported to launder. docs/interfaces.md section 6. Sybils gain nothing,
// because the only way to move a number here is to have actually produced
// savings for a real user.
//
// Who is on the board comes from the indexer, every address SolverRegistry ever
// emitted an event for in this deployment. What the board says about each is
// read from the registry at one block, never from the indexer's copy.

import type {FastifyInstance} from "fastify";
import {getAddress, type Address} from "viem";
import type {SolverBoardResponse, SolverRow} from "../../../packages/shared/api-types.ts";
import {db} from "../../../indexer/src/db.ts";
import {chain, read, registryAbi} from "../chain.ts";
import {fail} from "../errors.ts";
import {provenance, recentStamp} from "../provenance.ts";
import {loadKnownSolvers} from "../config.ts";

async function indexedSolvers(chainId: number, settlement: string): Promise<Address[] | null> {
  try {
    const rows = await db().query("SELECT DISTINCT solver FROM solvers WHERE chain_id = $1 AND deployment = $2 ORDER BY solver", [chainId, settlement.toLowerCase()]);
    return rows.rows.map((r: {solver: string}) => r.solver as Address);
  } catch {
    return null;
  }
}

export function solverRoutes(app: FastifyInstance) {
  app.get("/v1/solvers", async (): Promise<SolverBoardResponse> => {
    const c = chain();
    const at = await recentStamp();
    const known = loadKnownSolvers(c.isFork);
    const indexed = await indexedSolvers(c.chainId, c.deployment.settlement);
    // On a fork the two demo solvers are known without the indexer. Anywhere
    // else nobody is known in advance, and an empty board would read as a
    // registry nobody bonded to.
    if (indexed === null && !c.isFork) {
      throw fail(503, "COORDINATOR_UPSTREAM_DOWN", "the indexer database is not answering, and off a fork it is the only list of who bonded", {needs: "the indexer database"});
    }

    const labels = new Map(known.map((k) => [k.address.toLowerCase(), k.label]));
    const addresses = [...new Set([...known.map((k) => k.address), ...(indexed ?? [])].map((a) => getAddress(a)))];

    const solvers: SolverRow[] = await Promise.all(
      addresses.map(async (address) => {
        const [[bonded], [batchesWon, savingsGeneratedUsd, failedFinalizes, slashCount], active] = await Promise.all([
          read<[bigint, bigint]>(c.deployment.solvers, registryAbi, "bondOf", [address], at.number),
          read<[bigint, bigint, bigint, bigint]>(c.deployment.solvers, registryAbi, "stats", [address], at.number),
          read<boolean>(c.deployment.solvers, registryAbi, "isActive", [address], at.number),
        ]);
        return {
          address,
          label: labels.get(address.toLowerCase()) ?? null,
          bonded: String(bonded),
          active,
          batchesWon: Number(batchesWon),
          savingsGeneratedUsd: String(savingsGeneratedUsd),
          failedFinalizes: Number(failedFinalizes),
          slashCount: Number(slashCount),
        };
      }),
    );

    return {solvers, provenance: provenance(at)};
  });
}
