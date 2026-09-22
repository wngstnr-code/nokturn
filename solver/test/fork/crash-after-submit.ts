// E1's victim. Solves one batch, submits it, and kills itself with SIGKILL the
// moment the receipt is in, before anything can finalize.
//
//   NOKTURN_SOLVER_STATE=<dir> node solver/test/fork/crash-after-submit.ts <batchId>

import {solverAccount} from "../../src/account.ts";
import {client, contracts, settlementAddress} from "../../src/chain.ts";
import {feed, solveAt} from "../../src/feed.ts";
import {untilBlock} from "../../src/finalize.ts";
import {submit} from "../../src/send.ts";
import {Store, storeDir} from "../../src/store.ts";

const batchId = BigInt(process.argv[2]!);
const c = client();
const account = solverAccount();
const k = await contracts(c, settlementAddress());
const store = new Store(storeDir(await c.getChainId(), k.settlement));

await untilBlock(c, (ts) => ts > batchId, batchId + 10n);
const {signed} = await feed(batchId);
const {plan} = await solveAt(c, k, batchId, signed, account.address, await c.getBlockNumber());
const sent = await submit(c, account, k, plan.solution, store);
console.log(JSON.stringify({status: sent.status, tx: "tx" in sent ? sent.tx : null}));
process.kill(process.pid, "SIGKILL");
