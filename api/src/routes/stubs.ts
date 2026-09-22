// The routes whose shape is frozen and whose implementation is not written yet.
//
// They answer 503 with the agreed ApiError body, never a 404 and never invented
// data. The route exists, it simply cannot answer today, and saying so in the
// frozen shape is what lets the frontend build its loading and error paths now.
//
// A stub that returned plausible numbers so a screen looked full would be the
// mock this project already lost a competition to. CLAUDE.md rule 9.

import type {FastifyInstance} from "fastify";
import {notImplemented} from "../errors.ts";

/** What each one is still waiting for, reported to the caller verbatim. */
const PENDING: {method: "get" | "post"; path: string; needs: string}[] = [
  {method: "get", path: "/v1/batches", needs: "the event indexer"},
  {method: "get", path: "/v1/batches/:batchId", needs: "the event indexer"},
  {method: "get", path: "/v1/auctions/:auctionId", needs: "an auction that has actually opened"},
];

export function stubRoutes(app: FastifyInstance) {
  for (const route of PENDING) {
    app[route.method](route.path, async (_request, reply) => notImplemented(reply, route.needs));
  }
}
