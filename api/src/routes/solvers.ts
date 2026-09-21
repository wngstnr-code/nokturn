// GET /v1/solvers
//
// The scoreboard is derived entirely from settlement facts, so there is nothing
// self reported to launder. docs/interfaces.md section 6. Sybils gain nothing,
// because the only way to move a number here is to have actually produced
// savings for a real user.

import type {FastifyInstance} from "fastify";
import type {SolverBoardResponse, SolverRow} from "../../../packages/shared/api-types.ts";
import {chain, read, registryAbi} from "../chain.ts";
import {provenance, stamp} from "../provenance.ts";
import {loadKnownSolvers} from "../config.ts";

export function solverRoutes(app: FastifyInstance) {
  app.get("/v1/solvers", async (): Promise<SolverBoardResponse> => {
    const c = chain();
    const at = await stamp();
    const known = loadKnownSolvers();

    const solvers: SolverRow[] = await Promise.all(
      known.map(async ({address, label}) => {
        const [bonded] = await read<[bigint, bigint]>(c.deployment.solvers, registryAbi, "bondOf", [address]);
        const [batchesWon, savingsGeneratedUsd, failedFinalizes, slashCount] = await read<
          [bigint, bigint, bigint, bigint]
        >(c.deployment.solvers, registryAbi, "stats", [address]);
        const active = await read<boolean>(c.deployment.solvers, registryAbi, "isActive", [address]);
        return {
          address,
          label,
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
