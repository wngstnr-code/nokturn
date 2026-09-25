import {coordinatorUrl} from "./client";

/*
 * The socket announces that something happened, it does not carry the answer.
 * batch.settled still needs the indexer wired into the stream, so the reliable
 * shape is to let an event trigger a read rather than to trust the socket alone.
 * A slow interval stays underneath, so a refused or dropped socket degrades to
 * the behaviour there was before rather than to silence.
 */
const SERVED = ["batch.opened", "batch.intent_added", "batch.collect_closed"] as const;

const CLOSE_CODES: Record<number, string> = {
  1008: "the coordinator refused too many bad messages",
  1009: "a message was over the size limit",
  1013: "the coordinator is at its client limit",
};

export type Nudge = {
  /// True once the socket is open, so a caller can slow its own polling down.
  live: boolean;
  reason: string | null;
};

export function watchBatches(
  owner: string | undefined,
  onNudge: () => void,
  onState: (state: Nudge) => void,
): () => void {
  const base = coordinatorUrl();
  if (base === null || typeof WebSocket === "undefined") {
    onState({live: false, reason: null});
    return () => {};
  }

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let backoff = 1000;

  function open() {
    if (closed) return;

    const url = `${base!.replace(/^http/, "ws")}/v1/stream`;
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch {
      onState({live: false, reason: "the stream could not be opened"});
      return;
    }
    socket = next;

    next.onopen = () => {
      backoff = 1000;
      onState({live: true, reason: null});
      next.send(
        JSON.stringify({
          type: "subscribe",
          topics: SERVED,
          ...(owner === undefined ? {} : {owner}),
        }),
      );
    };

    next.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {type?: string; code?: string};
        // An ApiError frame carries a code and no type. It is the coordinator
        // saying which topics it cannot serve, and the socket stays open.
        if (typeof frame.type === "string") onNudge();
      } catch {
        // A frame this client cannot parse is not a reason to drop the socket.
      }
    };

    next.onclose = (event) => {
      socket = null;
      onState({live: false, reason: CLOSE_CODES[event.code] ?? null});
      if (closed) return;
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };

    next.onerror = () => next.close();
  }

  open();

  return () => {
    closed = true;
    if (retry !== null) clearTimeout(retry);
    socket?.close();
  };
}
