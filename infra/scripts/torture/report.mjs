// Turns infra/.torture/*.jsonl into infra/torture-report.md.
//
// The report is local on purpose. It depends on one laptop and one fork block,
// so it is ignored by git and none of its numbers belong in a pitch.

import {existsSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {REPO_ROOT} from "./lib/api.mjs";
import {EVIDENCE_DIR} from "./lib/evidence.mjs";

const ORDER = ["c0-shared", "c1-mempool", "c2-submit", "c3-read", "c4-tooling", "h-http", "r-rpc", "l-load", "s-soak"];
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

lines.push("## Ringkasan dugaan", "", "| Dugaan | Hasil | Skenario |", "|---|---|---|");
const suspects = [...bySuspect.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b));
for (const s of suspects) {
  const list = bySuspect.get(s);
  const proven = list.some((r) => r.outcome === "finding");
  const verdict = proven ? "terbukti" : list.every((r) => r.outcome === "skip") ? "tidak diuji" : "gugur";
  lines.push(`| ${s} | ${verdict} | ${list.map((r) => `${r.id} ${LABEL[r.outcome] ?? r.outcome}`).join(", ")} |`);
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
