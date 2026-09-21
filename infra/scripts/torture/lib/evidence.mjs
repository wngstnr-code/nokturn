// Where each scenario writes what it saw, for report.mjs to turn into a table.
//
// One file per group under infra/.torture, truncated when that group starts, so
// rerunning one group replaces its rows without touching the others.

import {appendFileSync, mkdirSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {REPO_ROOT} from "./api.mjs";

export const EVIDENCE_DIR = join(REPO_ROOT, "infra", ".torture");

export function openGroup(testFileUrl) {
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  const name = basename(new URL(testFileUrl).pathname).replace(/\.test\.mjs$/, "");
  const file = join(EVIDENCE_DIR, `${name}.jsonl`);
  writeFileSync(file, "");

  /**
   * outcome is pass when the correct behaviour held, finding when it did not,
   * measure for a number recorded without a threshold, and skip with a reason.
   * suspect names the D item the scenario proves or refutes, when there is one.
   */
  return function record(id, {outcome, suspect = null, summary, evidence = {}}) {
    const row = {id, outcome, suspect, summary, evidence, at: new Date().toISOString()};
    appendFileSync(file, `${JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
    return row;
  };
}

export function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}
