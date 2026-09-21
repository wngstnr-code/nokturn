// Raw JSON-RPC against the fork, for the torture suite only.
//
// Every helper here changes fork state, so nothing in this file runs until
// requireFork has seen anvil_nodeInfo answer. Chain time only ever moves through
// evm_setNextBlockTimestamp and evm_mine, never through the laptop clock.

export const FORK_RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";

let nextId = 1;

export async function rpc(method, params = [], url = FORK_RPC) {
  const res = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: nextId++, method, params}),
  });
  const body = await res.json();
  if (body.error) {
    const err = new Error(`${method} failed: ${body.error.message}`);
    err.rpcError = body.error;
    throw err;
  }
  return body.result;
}

export async function requireFork() {
  try {
    await rpc("anvil_nodeInfo");
  } catch (error) {
    throw new Error(`torture runs only against an anvil fork, anvil_nodeInfo failed at ${FORK_RPC}. ${error.message}`);
  }
}

async function forkUp() {
  try {
    await rpc("eth_chainId");
    return true;
  } catch {
    return false;
  }
}

/** Kills the anvil that serves FORK_RPC. Only the node restart scenarios call this. */
export async function killFork() {
  const {execFileSync} = await import("node:child_process");
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/F", "/IM", "anvil.exe"], {stdio: "ignore"});
    else execFileSync("pkill", ["-f", "anvil"], {stdio: "ignore"});
  } catch {
    // nothing was running
  }
  for (let i = 0; i < 100 && (await forkUp()); i += 1) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Starts anvil through infra/scripts/fork.sh, detached so it outlives the test
 * process the way a fork started by make would, then deploys and funds it.
 * With bumpNonce the deployer sends one empty transaction first, which moves
 * every contract Deploy creates to a different address.
 */
export async function restartFork({repoRoot, logFile, bumpNonce = false, deployer}) {
  const {spawn, execFileSync} = await import("node:child_process");
  const {openSync} = await import("node:fs");
  // Not append mode. MSYS bash on Windows cannot write to an O_APPEND handle and
  // exits 1 without a word, which looked exactly like anvil failing to start.
  const out = openSync(logFile, "w");
  const child = spawn("bash", ["./infra/scripts/fork.sh"], {cwd: repoRoot, detached: true, stdio: ["ignore", out, out]});
  child.unref();
  for (let i = 0; i < 600 && !(await forkUp()); i += 1) await new Promise((r) => setTimeout(r, 200));
  if (!(await forkUp())) throw new Error(`fork did not come back, see ${logFile}`);
  if (bumpNonce) {
    const hash = await rpc("eth_sendTransaction", [{from: deployer, to: deployer, value: "0x0"}]);
    for (let i = 0; i < 50 && !(await rpc("eth_getTransactionReceipt", [hash])); i += 1) await mine();
  }
  for (const script of ["deploy.sh", "fund.sh"]) {
    execFileSync("bash", [`./infra/scripts/${script}`], {cwd: repoRoot, stdio: ["ignore", out, out], timeout: 20 * 60_000});
  }
}

export async function snapshot() {
  return rpc("evm_snapshot");
}

export async function revert(id) {
  const ok = await rpc("evm_revert", [id]);
  if (ok !== true) throw new Error(`evm_revert ${id} refused`);
}

/** Runs fn inside a snapshot and always reverts, even when fn throws. */
export async function withSnapshot(fn) {
  const id = await snapshot();
  try {
    return await fn();
  } finally {
    await revert(id);
  }
}

export async function latestBlock() {
  const b = await rpc("eth_getBlockByNumber", ["latest", false]);
  return {number: BigInt(b.number), timestamp: BigInt(b.timestamp)};
}

export async function chainNow() {
  return (await latestBlock()).timestamp;
}

export async function mine() {
  await rpc("evm_mine");
}

/**
 * Moves chain time to ts and mines a block there. The fork also mines on an
 * interval, so a block can land between the two calls. Either way the first
 * block after this returns carries ts or later.
 */
export async function warpTo(ts) {
  const target = BigInt(ts);
  const now = await chainNow();
  // Already there is not an error. The interval miner can reach the target
  // second on its own between a scenario reading the clock and asking to warp.
  if (target === now) return;
  if (target < now) throw new Error(`cannot warp backwards, chain is at ${now}, asked for ${target}`);
  await rpc("evm_setNextBlockTimestamp", [`0x${target.toString(16)}`]);
  await mine();
}

export async function setBalance(address, wei) {
  await rpc("anvil_setBalance", [address, `0x${BigInt(wei).toString(16)}`]);
}

export async function impersonate(address) {
  await rpc("anvil_impersonateAccount", [address]);
}

export async function setCode(address, code) {
  await rpc("anvil_setCode", [address, code]);
}

export async function getStorageAt(address, slot) {
  return rpc("eth_getStorageAt", [address, slot, "latest"]);
}

export async function setStorageAt(address, slot, value) {
  await rpc("anvil_setStorageAt", [address, slot, value]);
}

/**
 * Sets an ERC-20 balance by finding the storage slot that backs balanceOf, the
 * way forge's deal does. Tries the plain mapping slots and the OpenZeppelin v5
 * namespaced layout, and keeps whichever one balanceOf actually reads.
 */
export async function dealErc20(token, holder, amount, {readBalance}) {
  const {encodeAbiParameters, keccak256, numberToHex} = await import("viem");
  const oz5 = "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00";
  const bases = [...Array.from({length: 12}, (_, i) => BigInt(i)), BigInt(oz5)];
  const marker = 0x1234567890abcdefn;
  for (const base of bases) {
    const slot = keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}], [holder, base]));
    const original = await getStorageAt(token, slot);
    await setStorageAt(token, slot, numberToHex(marker, {size: 32}));
    if ((await readBalance()) === marker) {
      await setStorageAt(token, slot, numberToHex(BigInt(amount), {size: 32}));
      return slot;
    }
    await setStorageAt(token, slot, original);
  }
  throw new Error(`no balance slot found for ${token}`);
}

export async function ethCall({from, to, data}, block = "latest") {
  return rpc("eth_call", [{from, to, data}, block]);
}

/**
 * Sends as `from` through auto impersonation and waits for the receipt. The
 * fork starts with --auto-impersonate, so no key is needed and none is held.
 */
export async function sendAs({from, to, data, gas = 1_000_000n}) {
  await setBalance(from, 10n ** 20n);
  try {
    await rpc("eth_call", [{from, to, data}, "latest"]);
  } catch (error) {
    throw new Error(`call from ${from} to ${to} would revert: ${error.message} ${JSON.stringify(error.rpcError?.data ?? "")}`);
  }
  const hash = await rpc("eth_sendTransaction", [{from, to, data, gas: `0x${gas.toString(16)}`}]);
  for (let i = 0; i < 100; i += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
      return receipt;
    }
    await mine();
  }
  throw new Error(`no receipt for ${hash}`);
}
