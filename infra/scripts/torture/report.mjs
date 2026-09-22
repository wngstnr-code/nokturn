// Turns infra/.torture/*.jsonl into infra/torture-report.md.
//
// The report is local on purpose. It depends on one laptop and one fork block,
// so it is ignored by git and none of its numbers belong in a pitch.

import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {REPO_ROOT} from "./lib/api.mjs";
import {EVIDENCE_DIR} from "./lib/evidence.mjs";

const TORTURE_DIR = join(REPO_ROOT, "infra", "scripts", "torture");

/**
 * Suspects still waiting on a design decision, read from the todo markers in
 * the test files rather than typed into this report.
 */
function awaitingDecision() {
  const ids = new Set();
  for (const f of readdirSync(TORTURE_DIR).filter((n) => n.endsWith(".test.mjs"))) {
    for (const m of readFileSync(join(TORTURE_DIR, f), "utf8").matchAll(/todo: "KEPUTUSAN ([DN]\d+)"/g)) ids.add(m[1]);
  }
  return ids;
}

/**
 * The fix commits for each suspect, from git log. Every fix commit on this
 * branch ends its body with the suspect it closes, so only that last sentence
 * is read, and an ID mentioned in passing earlier in the body does not count.
 */
function fixCommits() {
  const out = execFileSync("git", ["log", "--format=%h%x1f%s%x1f%b%x1e"], {cwd: REPO_ROOT, encoding: "utf8"});
  const bySuspect = new Map();
  for (const entry of out.split("\x1e")) {
    const [hash, subject, body] = entry.trim().split("\x1f");
    if (!hash || !subject?.startsWith("fix ")) continue;
    const sentences = (body ?? "").trim().split(/(?<=\.)\s+/).filter(Boolean);
    const last = sentences.at(-1) ?? "";
    for (const m of last.matchAll(/\b([DN]\d+)\b/g)) {
      const list = bySuspect.get(m[1]) ?? [];
      if (!list.includes(hash)) list.push(hash);
      bySuspect.set(m[1], list);
    }
  }
  return bySuspect;
}

const ORDER = ["c0-shared", "c1-mempool", "c2-submit", "c3-read", "c4-tooling", "h-http", "r-rpc", "l-load", "f9-lifecycle", "f10-stream", "s-soak"];
const LABEL = {pass: "lulus", finding: "TEMUAN", measure: "ukur", skip: "lewati"};

const pinned = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "pinned-block.json"), "utf8"));

function cell(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function evidenceText(evidence) {
  const parts = Object.entries(evidence ?? {}).map(([k, v]) => `${k}=${cell(v)}`);
  const joined = parts.join(", ");
  return joined.length > 600 ? `${joined.slice(0, 600)} (dipotong)` : joined;
}

if (!existsSync(EVIDENCE_DIR)) {
  console.error("no evidence yet, run make torture first");
  process.exit(1);
}

const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".jsonl"));
files.sort((a, b) => ORDER.indexOf(a.replace(".jsonl", "")) - ORDER.indexOf(b.replace(".jsonl", "")));

const rows = [];
for (const f of files) {
  for (const line of readFileSync(join(EVIDENCE_DIR, f), "utf8").split("\n")) {
    if (line.trim()) rows.push({group: f.replace(".jsonl", ""), ...JSON.parse(line)});
  }
}

const bySuspect = new Map();
for (const r of rows) {
  if (!r.suspect) continue;
  const list = bySuspect.get(r.suspect) ?? [];
  list.push(r);
  bySuspect.set(r.suspect, list);
}

const lines = [];
lines.push("# Laporan uji skenario terburuk, intent coordinator", "");
lines.push(
  `Fork dari blok ${pinned.block} (${pinned.timestampUtc}). Ukuran satu laptop di atas fork, bukan klaim produk.`,
  "Jangan disalin ke dokumen publik atau pitch.",
  "",
);

// A suspect that was proven and then fixed passes in the latest run, and
// reading only the latest run would call it refuted. So the verdict also asks
// git for a fix commit and the tests for a KEPUTUSAN marker.
const decisions = awaitingDecision();
const fixes = fixCommits();
lines.push(
  "## Ringkasan dugaan",
  "",
  "Hasil diturunkan dari tiga sumber. Baris bukti run terakhir, commit `fix` di git log yang menyebut dugaan itu di kalimat terakhirnya, dan penanda `todo: \"KEPUTUSAN ...\"` di file test.",
  "",
  "| Dugaan | Hasil | Commit fix | Skenario di run terakhir |",
  "|---|---|---|---|",
);
const suspects = [...new Set([...bySuspect.keys(), ...decisions, ...fixes.keys()])].sort(
  (a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)),
);
for (const s of suspects) {
  const list = bySuspect.get(s) ?? [];
  const stillFinding = list.some((r) => r.outcome === "finding");
  const hashes = fixes.get(s) ?? [];
  let verdict;
  if (decisions.has(s)) verdict = "terbukti, KEPUTUSAN";
  else if (hashes.length && stillFinding) verdict = "terbukti, perbaikan belum menutup";
  else if (hashes.length) verdict = "terbukti, diperbaiki";
  else if (stillFinding) verdict = "terbukti, belum ditangani";
  else if (list.length && list.every((r) => r.outcome === "skip")) verdict = "tidak diuji";
  else verdict = "gugur";
  const scenarios = list.map((r) => `${r.id} ${LABEL[r.outcome] ?? r.outcome}`).join(", ") || "tidak ada baris";
  lines.push(`| ${s} | ${verdict} | ${hashes.join(", ")} | ${scenarios} |`);
}
lines.push("");

let currentGroup = null;
for (const r of rows) {
  if (r.group !== currentGroup) {
    currentGroup = r.group;
    lines.push(`## ${currentGroup}`, "", "| ID | Hasil | Dugaan | Ringkasan | Bukti |", "|---|---|---|---|---|");
  }
  lines.push(
    `| ${r.id} | ${LABEL[r.outcome] ?? r.outcome} | ${r.suspect ?? ""} | ${cell(r.summary ?? "")} | ${evidenceText(r.evidence)} |`,
  );
}
lines.push("");

const out = join(REPO_ROOT, "infra", "torture-report.md");
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}, ${rows.length} rows, ${rows.filter((r) => r.outcome === "finding").length} findings`);
