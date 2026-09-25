import {http, type HttpTransportConfig, type Transport} from "viem";

/*
 * A load balanced endpoint can hand one request to a node that never held the
 * state being asked for. It answers, so viem sees a definitive result rather
 * than a failure and does not retry, and a whole screen becomes a red card
 * because one read out of six landed on the wrong node.
 *
 * Measured against robinhood-testnet.drpc.org, where the same block answers
 * when asked again. Retrying is not papering over a wrong answer, it is asking
 * a question the last node could not hear.
 */
const MISSING_STATE = [
  "unknown state",
  "missing trie node",
  "header not found",
  "state is not available",
  "unknown block",
];

function asksAnotherNode(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return MISSING_STATE.some((phrase) => message.includes(phrase));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * The first version waited 120ms, 240ms, 360ms. That is faster than the balancer
 * rotates, so all four tries could land on the same node that had already said no
 * and the page still went red. Doubling from 250ms spreads the last try nearly
 * four seconds out, and the jitter keeps several reads from retrying in step and
 * arriving together at whichever node is next.
 */
function backoff(attempt: number): number {
  const base = 250 * 2 ** attempt;
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * @param attempts How many times to ask in total, including the first.
 */
export function resilientHttp(
  url: string,
  options: HttpTransportConfig,
  attempts = 5,
): Transport {
  const inner = http(url, options);

  return (config) => {
    const transport = inner(config);

    return {
      ...transport,
      async request(args, requestOptions) {
        let last: unknown;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            return await transport.request(args, requestOptions);
          } catch (error) {
            last = error;
            if (!asksAnotherNode(error)) throw error;
            if (attempt === attempts - 1) break;
            await sleep(backoff(attempt));
          }
        }

        throw last;
      },
    };
  };
}
