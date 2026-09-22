// Entry point. Reads the chain once, then serves.
//
// Chain discovery happens before the socket opens on purpose. A server that
// starts and only then finds it has no deployment record answers every request
// with a five hundred, and the operator sees a healthy process. Failing at boot
// puts the reason on the terminal instead.

import {env} from "./config.ts";
import {initChain} from "./chain.ts";
import {useEventLog} from "./events.ts";
import {startLifecycle} from "./lifecycle.ts";
import {buildServer} from "./server.ts";

async function main() {
  const c = await initChain();
  const app = buildServer();

  app.log.info(
    {
      chainId: c.chainId,
      network: c.isFork ? "fork" : c.isTestnet ? "testnet" : "mainnet",
      settlement: c.deployment.settlement,
      pinnedBlock: c.pinned?.block,
      tokens: c.tokens.map((t) => t.symbol).join(","),
    },
    "chain resolved",
  );

  useEventLog(app.log);
  await app.listen({host: env.host, port: env.port});
  const stopLifecycle = startLifecycle(app.log);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info(`${signal}, closing`);
      stopLifecycle();
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(`\nfailed to start\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
