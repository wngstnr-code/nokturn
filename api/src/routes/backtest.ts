// GET /v1/backtest/netting-curve
//
// The curve the netting screen draws, read from the export of Dune query
// 8595303 in data/backtest rather than typed into the screen. The file is
// checked at boot, so a copy that lost its label or a row fails loudly here
// instead of reaching a judge. F30.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {FastifyInstance} from "fastify";
import type {NettingCurveResponse, NettingCurveRow} from "../../../packages/shared/api-types.ts";
import {REPO_ROOT} from "../config.ts";

export const CURVE_FILE = join(REPO_ROOT, "data", "backtest", "netting-vs-share-august-2026.json");
const SESSIONS = ["nyse_open", "off_hours_weekday", "weekend"] as const;

export function loadNettingCurve(text: string): NettingCurveResponse {
  const raw = JSON.parse(text) as Omit<NettingCurveResponse, "rows"> & {rows: Omit<NettingCurveRow, "label">[]};
  if (raw.label !== "BACKTEST") throw new Error("the netting curve file is not labelled BACKTEST");
  if (!Number.isInteger(raw.source?.duneQueryId)) throw new Error("the netting curve file names no Dune query");
  for (const s of SESSIONS) {
    if (!raw.rows.some((r) => r.session === s)) throw new Error(`the netting curve file has no ${s} rows`);
  }
  return {...raw, rows: raw.rows.map((r) => ({label: "BACKTEST", ...r}))};
}

export function backtestRoutes(app: FastifyInstance) {
  const curve = loadNettingCurve(readFileSync(CURVE_FILE, "utf8"));
  app.get("/v1/backtest/netting-curve", async (): Promise<NettingCurveResponse> => curve);
}
