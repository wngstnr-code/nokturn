// One error shape for the whole surface, and the two helpers that build it.
//
// The codes that mirror a contract check carry the contract's own error name,
// so a rejection at the API and the same rejection on chain read identically
// and the frontend keeps one message table rather than two.

import type {FastifyReply} from "fastify";
import type {ApiError, ApiErrorCode} from "../../packages/shared/api-types.ts";
import type {Provenance} from "../../packages/shared/api-types.ts";

// Fields are declared and assigned rather than written as constructor parameter
// properties. Node strips types at run time and does not implement that TS only
// form, so the shorter spelling fails at import with a syntax error.
export class HttpError extends Error {
  status: number;
  body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

export function fail(
  status: number,
  code: ApiErrorCode,
  message: string,
  detail?: ApiError["detail"],
  prov?: Provenance,
): HttpError {
  return new HttpError(status, {code, message, detail, provenance: prov});
}

export function badRequest(code: ApiErrorCode, message: string, detail?: ApiError["detail"]) {
  return fail(400, code, message, detail);
}

export function notFound(code: ApiErrorCode, message: string) {
  return fail(404, code, message);
}

/**
 * The honest answer for a route whose shape is frozen and whose implementation
 * is not written yet. It is a 503 with the agreed body rather than a 404,
 * because the route exists, it simply cannot answer today.
 *
 * It never returns invented data. A stub that makes a screen look full is the
 * mock this project lost a competition to, CLAUDE.md rule 9.
 */
export function notImplemented(reply: FastifyReply, needs: string) {
  const body: ApiError = {
    code: "COORDINATOR_NOT_IMPLEMENTED",
    message: `this route is frozen in packages/shared/api-types.ts but not implemented yet. it needs ${needs}`,
    detail: {needs},
  };
  return reply.code(503).send(body);
}
