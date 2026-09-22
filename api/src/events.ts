// In process bus between the batch lifecycle and the stream route.
//
// Nothing is kept. A client that connects late learns the present from the
// snapshot the stream sends on subscribe, never from a replay of the past.

import type {Address, StreamEvent} from "../../packages/shared/api-types.ts";

/** Routing facts about an event that are not part of what a client receives. */
export interface EventMeta {
  owner?: Address;
}

export type EventHandler = (event: StreamEvent, meta: EventMeta) => void;

interface ErrorLog {
  error(obj: object, msg: string): void;
}

const handlers = new Set<EventHandler>();
let log: ErrorLog = {error: (obj, msg) => console.error(msg, obj)};

export function useEventLog(logger: ErrorLog): void {
  log = logger;
}

export function subscribe(handler: EventHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

// One broken subscriber must not stop the others from hearing the event, and
// must never reach the publisher, which is the lifecycle or a POST.
export function publish(event: StreamEvent, meta: EventMeta = {}): void {
  for (const handler of handlers) {
    try {
      handler(event, meta);
    } catch (error) {
      log.error({err: error, type: event.type}, "stream handler threw");
    }
  }
}
