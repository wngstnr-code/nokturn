// F22 against the fork. make fund bonds both solvers, and an account that was
// never bonded is refused with the command that fixes it.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {test} from "node:test";
import type {Address} from "viem";
import {REPO_ROOT} from "../../src/abi.ts";
import {client, contracts, settlementAddress} from "../../src/chain.ts";
import {assertReady, readiness} from "../../src/preflight.ts";
import {users} from "./lib.ts";

const accounts = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "accounts.json"), "utf8")) as {solverA: Address; solverB: Address};

test("both solvers are bonded, active and ready", async () => {
  const c = client();
  const k = await contracts(c, settlementAddress());
  for (const [name, address] of [["solverA", accounts.solverA], ["solverB", accounts.solverB]] as const) {
    const r = await assertReady(c, k, address);
    console.log(`${name} ${address} active ${r.active}, bond ${r.bonded} of ${r.minBond}, gas ${r.balance}`);
    assert.equal(r.active, true);
  }
});

test("an account that was never bonded is refused and told to run make fund", async () => {
  const c = client();
  const k = await contracts(c, settlementAddress());
  const stranger = users()[0]!.address;
  const r = await readiness(c, k, stranger);
  assert.equal(r.active, false);
  await assert.rejects(assertReady(c, k, stranger), (error: Error) => {
    assert.match(error.message, /refuses to start/);
    assert.match(error.message, /under minBond .* run: make fund/);
    return true;
  });
});
