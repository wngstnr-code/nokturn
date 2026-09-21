// The Fastify app.
//
// Two things here are not boilerplate. BigInt is serialised as a decimal string
// rather than allowed to throw, because every amount on this surface is a string
// by design and a stray bigint reaching the serialiser would otherwise take a
// whole response down. And every error leaves through one handler, so a caller
// never sees a shape that is not ApiError.

import Fastify, {type FastifyInstance} from "fastify";
import type {ApiError} from "../../packages/shared/api-types.ts";
import {env} from "./config.ts";
import {chain, deploymentMoved} from "./chain.ts";
import {HttpError, fail} from "./errors.ts";
import {allowlistRoutes} from "./routes/allowlist.ts";
import {configRoutes} from "./routes/config.ts";
import {escapeRoutes} from "./routes/escape.ts";
import {intentRoutes} from "./routes/intents.ts";
import {nonceRoutes} from "./routes/nonces.ts";
import {quoteRoutes} from "./routes/quote.ts";
import {sessionRoutes} from "./routes/session.ts";
import {solverRoutes} from "./routes/solvers.ts";
import {stubRoutes} from "./routes/stubs.ts";

function bigintSafe(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: {level: env.logLevel},
    // Amounts here routinely exceed 2^53, so anything that leaks through as a
    // bigint becomes a decimal string rather than a thrown serialiser.
    serializerOpts: undefined,
  });

  app.setReplySerializer((payload) => JSON.stringify(payload, bigintSafe));

  // The browser calls this from a different origin during development, and the
  // whole surface is public read anyway.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());

  app.addHook("onRequest", async () => {
    if (deploymentMoved()) {
      throw fail(
        503,
        "COORDINATOR_UPSTREAM_DOWN",
        "the deployment record changed under this running API, so every address it holds may name the wrong contract. restart it with make api",
        {settlement: chain().deployment.settlement},
      );
    }
  });

  // A POST carrying the json content type and no body is how every http client
  // probes a route, and Fastify treats that as a parse failure by default. It
  // reached the generic handler and came back 502, which made a stub look like a
  // broken upstream. Found by the Postman collection.
  app.addContentTypeParser("application/json", {parseAs: "string"}, (_request, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (raw === "") return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(
        new HttpError(400, {
          code: "COORDINATOR_INVALID_REQUEST",
          message: "body is not valid json",
        }),
        undefined,
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send(error.body);
    }
    // Fastify's own rejections, a body over the limit or a content type with no
    // parser, carry a 4xx statusCode. They are the caller's mistake and keep
    // their status, rather than being reported as a dead node. D13.
    const status = (error as {statusCode?: number}).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const body: ApiError = {
        code: "COORDINATOR_INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      };
      return reply.code(status).send(body);
    }
    request.log.error({err: error}, "unhandled");
    const body: ApiError = {
      // Almost every unhandled failure on a read only surface is the node, so
      // that is what it is reported as rather than a bare five hundred.
      code: "COORDINATOR_UPSTREAM_DOWN",
      message: error instanceof Error ? error.message : String(error),
    };
    return reply.code(502).send(body);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const body: ApiError = {
      code: "COORDINATOR_NOT_IMPLEMENTED",
      message: `no route ${request.method} ${request.url}. the frozen surface is listed in packages/shared/api-types.ts ROUTES`,
    };
    return reply.code(404).send(body);
  });

  configRoutes(app);
  sessionRoutes(app);
  allowlistRoutes(app);
  quoteRoutes(app);
  nonceRoutes(app);
  escapeRoutes(app);
  intentRoutes(app);
  solverRoutes(app);
  stubRoutes(app);

  app.get("/", async () => {
    const c = chain();
    return {
      name: "nokturn coordinator",
      apiVersion: "v1",
      chainId: c.chainId,
      network: c.isFork ? "fork" : c.isTestnet ? "testnet" : "mainnet",
      routes: "see packages/shared/api-types.ts ROUTES",
    };
  });

  return app;
}
