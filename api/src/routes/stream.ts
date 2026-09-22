// WS /v1/stream
//
// Carries what the batch lifecycle and the mempool publish, and nothing else.
// Topics whose source does not exist yet are refused by name rather than
// accepted and left silent, because a socket that never fires looks exactly
// like a quiet market. CLAUDE.md rule 9.

import type {FastifyInstance} from "fastify";
import {isAddress} from "viem";
import type {WebSocket} from "ws";
import type {ApiError, StreamEvent, StreamFrame, StreamSubscribe} from "../../../packages/shared/api-types.ts";
import {subscribe as onEvent, type EventMeta} from "../events.ts";
import {stamp} from "../provenance.ts";
import {buildCurrentBatch} from "./session.ts";

// parameter.md, batas operasional coordinator.
export const STREAM_MAX_CLIENTS = 200;
export const STREAM_MAX_MESSAGE_BYTES = 16 * 1024;
const STREAM_MAX_BUFFERED_BYTES = 1024 * 1024;
const STREAM_PING_SECONDS = 30;

const MAX_INVALID_MESSAGES = 5;
const MISSED_PINGS_TO_CLOSE = 2;

type Topic = StreamEvent["type"];

const SERVED = new Set<Topic>([
  "batch.opened",
  "batch.intent_added",
  "batch.collect_closed",
  "session.changed",
  "token.protective",
  "oracle.unhealthy",
]);

const NEEDS: Partial<Record<Topic, string>> = {
  "batch.solution_submitted": "the event indexer",
  "batch.solution_rejected": "the event indexer",
  "batch.settled": "the event indexer",
  "batch.failed": "the event indexer",
  "auction.indicative": "the auction keeper",
  "auction.crossed": "the auction keeper",
};

const bigintSafe = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

function invalid(message: string): ApiError {
  return {code: "COORDINATOR_INVALID_REQUEST", message};
}

function parseSubscribe(raw: string): StreamSubscribe | string {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return "message is not valid json";
  }
  if (!msg || typeof msg !== "object") return "message is not an object";
  const {type, topics, owner} = msg as Record<string, unknown>;
  if (type !== "subscribe") return `unknown message type ${JSON.stringify(type)}, the only one is subscribe`;
  if (!Array.isArray(topics) || topics.length === 0) return "topics is a non empty array";
  for (const t of topics) {
    if (typeof t !== "string" || !(SERVED.has(t as Topic) || t in NEEDS)) return `unknown topic ${JSON.stringify(t)}`;
  }
  if (owner !== undefined && (typeof owner !== "string" || !isAddress(owner))) return "owner is an address";
  return {type, topics: topics as Topic[], ...(owner ? {owner: owner as `0x${string}`} : {})};
}

export function streamRoutes(app: FastifyInstance) {
  const clients = new Set<WebSocket>();

  app.route({
    method: "GET",
    url: "/v1/stream",
    handler: async (_request, reply) => {
      const body = invalid("this route is a websocket, connect with an upgrade and send a subscribe message");
      return reply.code(426).header("upgrade", "websocket").send(body);
    },
    wsHandler: (socket) => {
      if (clients.size >= STREAM_MAX_CLIENTS) {
        socket.close(1013, `at the limit of ${STREAM_MAX_CLIENTS} clients, try again later`);
        return;
      }
      clients.add(socket);

      let topics = new Set<Topic>();
      let owner: string | null = null;
      let invalidCount = 0;
      let missedPings = 0;

      const send = (frame: StreamFrame) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify(frame, bigintSafe));
        // A client that stops reading makes the server hold every frame for it.
        if (socket.bufferedAmount > STREAM_MAX_BUFFERED_BYTES) {
          socket.close(1013, "client is not reading, buffer limit reached");
          setTimeout(() => socket.terminate(), 1000).unref();
        }
      };

      const unsubscribe = onEvent((event: StreamEvent, meta: EventMeta) => {
        if (!topics.has(event.type)) return;
        if (event.type === "batch.intent_added" && owner !== null && meta.owner?.toLowerCase() !== owner) return;
        send(event);
      });

      // Measures the connection, not the chain, so the laptop clock is right here.
      const ping = setInterval(() => {
        if (missedPings >= MISSED_PINGS_TO_CLOSE) {
          socket.terminate();
          return;
        }
        missedPings += 1;
        socket.ping();
      }, STREAM_PING_SECONDS * 1000);
      socket.on("pong", () => {
        missedPings = 0;
      });

      socket.on("message", (data) => {
        const parsed = parseSubscribe(data.toString());
        if (typeof parsed === "string") {
          invalidCount += 1;
          if (invalidCount > MAX_INVALID_MESSAGES) {
            socket.close(1008, `more than ${MAX_INVALID_MESSAGES} invalid messages`);
            return;
          }
          send(invalid(parsed));
          return;
        }

        const refused = parsed.topics.filter((t) => !SERVED.has(t));
        topics = new Set(parsed.topics.filter((t) => SERVED.has(t)));
        owner = parsed.owner?.toLowerCase() ?? null;
        if (refused.length > 0) {
          send({
            code: "COORDINATOR_NOT_IMPLEMENTED",
            message: `no real source yet for ${refused.join(", ")}, the other topics are live`,
            detail: {topics: refused.join(","), needs: [...new Set(refused.map((t) => NEEDS[t]!))].join(",")},
          });
        }

        // The present, so a solver that connects mid batch does not wait for
        // the next one. Read from the chain now, not remembered.
        if (topics.has("batch.opened")) {
          void (async () => {
            const at = await stamp();
            send({type: "batch.opened", at: Number(at.timestamp), data: await buildCurrentBatch(at)});
          })().catch((error) => app.log.error({err: error}, "stream snapshot failed"));
        }
      });

      socket.on("close", () => {
        clients.delete(socket);
        clearInterval(ping);
        unsubscribe();
      });
    },
  });
}
