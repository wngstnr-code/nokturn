import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {PublicClient} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {SOLVER_A_INDEX, signer, solverAccount} from "../../src/account.ts";

const node = (fork: boolean) =>
  ({
    request: async () => {
      if (fork) return {};
      throw Object.assign(new Error("the method anvil_nodeInfo does not exist"), {code: -32601});
    },
  }) as unknown as PublicClient;

async function withKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.NOKTURN_SOLVER_PRIVATE_KEY;
  if (value === undefined) delete process.env.NOKTURN_SOLVER_PRIVATE_KEY;
  else process.env.NOKTURN_SOLVER_PRIVATE_KEY = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.NOKTURN_SOLVER_PRIVATE_KEY;
    else process.env.NOKTURN_SOLVER_PRIVATE_KEY = before;
  }
}

describe("the solver's key off a fork", () => {
  test("a fork signs with the repo mnemonic", async () => {
    assert.equal((await signer(node(true))).address, solverAccount("a").address);
  });

  test("a real chain without a key is refused, naming the variable", async () => {
    await withKey(undefined, () => assert.rejects(signer(node(false)), /NOKTURN_SOLVER_PRIVATE_KEY.*not set/));
  });

  test("a key of the public repo mnemonic is refused on a real chain", async () => {
    // Index 4 is solverA. Its key is derivable by anyone who reads the repo.
    const repoKey = solverAccount("a").getHdKey().privateKey!;
    assert.equal(SOLVER_A_INDEX, 4);
    await withKey(`0x${Buffer.from(repoKey).toString("hex")}`, () => assert.rejects(signer(node(false)), /public repo mnemonic/));
  });

  test("a key nobody else holds signs", async () => {
    const key = generatePrivateKey();
    await withKey(key, async () => assert.equal((await signer(node(false))).address, privateKeyToAccount(key).address));
  });
});
