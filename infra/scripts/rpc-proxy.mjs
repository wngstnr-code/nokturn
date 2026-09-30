// A local door to the official mainnet RPC that does not depend on DNS.
//
//   node infra/scripts/rpc-proxy.mjs [--port 8547]
//
// Indonesian ISPs resolve rpc.mainnet.chain.robinhood.com to their block page,
// and Node's fetch has no --resolve, so every backend process failed to reach
// the official endpoint from here (CLAUDE.md section 9). This listens on
// 127.0.0.1 and opens TLS to the real address with the real name, so the
// certificate is still checked against the hostname.
//
// Why the official endpoint at all. Alchemy's free tier refuses eth_getLogs
// over more than 10 blocks, and the official RPC served 460,000 in one call,
// measured 1 October 2026. It keeps only about ten minutes of state, so reads
// at old blocks still need the archive endpoint in NOKTURN_RPC_MAINNET.

import {createServer} from "node:http";
import {request} from "node:https";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";

export const HOST = "rpc.mainnet.chain.robinhood.com";
/** customer-origin.offchainlabs.com, CLAUDE.md section 9. */
export const ADDRESS = process.env.NOKTURN_RPC_MAINNET_IP ?? "172.66.147.70";

export function startProxy(port) {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, {"content-type": "application/json"}).end(JSON.stringify({error: "JSON-RPC over POST only"}));
      return;
    }
    const upstream = request(
      {host: ADDRESS, servername: HOST, port: 443, path: "/", method: "POST", headers: {host: HOST, "content-type": "application/json"}, timeout: 30_000},
      (up) => {
        res.writeHead(up.statusCode ?? 502, {"content-type": up.headers["content-type"] ?? "application/json"});
        up.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out after 30s")));
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, {"content-type": "application/json"});
      res.end(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32603, message: `rpc-proxy, ${error.message}`}}));
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const {values} = parseArgs({options: {port: {type: "string", default: process.env.NOKTURN_RPC_PROXY_PORT ?? "8547"}}});
  await startProxy(Number(values.port));
  console.log(`rpc-proxy on http://127.0.0.1:${values.port} to https://${HOST} at ${ADDRESS}`);
}
