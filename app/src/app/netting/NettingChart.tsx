"use client";

import {useState} from "react";
import styles from "./NettingChart.module.css";

export type Point = {share: number; counterparty: number; gross: number; traders: number};

/*
 * Both curves are drawn because the argument is that the stricter definition
 * produced the higher number, and that only shows with the looser one beside it.
 * The colours are not the brand cyan, which fails contrast against this surface.
 */
const COUNTERPARTY = "#0d9ddb";
const GROSS = "#b8831f";

const W = 720;
const H = 380;
const PAD = {top: 24, right: 96, bottom: 48, left: 56};

const X0 = PAD.left;
const X1 = W - PAD.right;
const Y0 = H - PAD.bottom;
const Y1 = PAD.top;

const Y_MAX = 70;

function x(share: number): number {
  return X0 + ((share - 5) / 95) * (X1 - X0);
}

function y(value: number): number {
  return Y0 - (value / Y_MAX) * (Y0 - Y1);
}

function path(points: Point[], pick: (p: Point) => number): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.share)} ${y(pick(p))}`).join(" ");
}

export function NettingChart({points}: {points: Point[]}) {
  const [active, setActive] = useState<Point | null>(null);

  const gridValues = [0, 10, 20, 30, 40, 50, 60, 70];
  const last = points[points.length - 1];

  function nearest(clientX: number, target: SVGSVGElement) {
    const box = target.getBoundingClientRect();
    const local = ((clientX - box.left) / box.width) * W;
    let best = points[0] ?? null;
    let bestGap = Infinity;
    for (const p of points) {
      const gap = Math.abs(x(p.share) - local);
      if (gap < bestGap) {
        bestGap = gap;
        best = p;
      }
    }
    setActive(best);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.swatch} style={{background: COUNTERPARTY}} />
          Between counterparties
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatch} style={{background: GROSS}} />
          Gross, bots included
        </span>
      </div>

      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Netting ratio against Nokturn's share of flow, August 2026 backtest"
        onMouseMove={(event) => nearest(event.clientX, event.currentTarget)}
        onMouseLeave={() => setActive(null)}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line className={styles.grid} x1={X0} x2={X1} y1={y(value)} y2={y(value)} />
            <text className={styles.axisText} x={X0 - 10} y={y(value) + 4} textAnchor="end">
              {value}%
            </text>
          </g>
        ))}

        {/* The share range this project actually quotes, called out rather than left
            for the reader to find. parameter.md section 4. */}
        <rect className={styles.band} x={x(10)} y={Y1} width={x(20) - x(10)} height={Y0 - Y1} />
        <text className={styles.bandText} x={x(20) + 8} y={Y1 + 12} textAnchor="start">
          10 to 20%, the share we quote
        </text>

        {points.map((p) => (
          <text key={p.share} className={styles.axisText} x={x(p.share)} y={Y0 + 20} textAnchor="middle">
            {p.share}%
          </text>
        ))}
        <text className={styles.axisTitle} x={(X0 + X1) / 2} y={H - 8} textAnchor="middle">
          Nokturn share of flow
        </text>

        <path className={styles.line} d={path(points, (p) => p.gross)} stroke={GROSS} />
        <path className={styles.line} d={path(points, (p) => p.counterparty)} stroke={COUNTERPARTY} />

        {points.map((p) => (
          <g key={`m${p.share}`}>
            <circle className={styles.dot} cx={x(p.share)} cy={y(p.gross)} r={4} fill={GROSS} />
            <circle className={styles.dot} cx={x(p.share)} cy={y(p.counterparty)} r={4} fill={COUNTERPARTY} />
          </g>
        ))}

        {last === undefined ? null : (
          <>
            <text className={styles.endLabel} x={X1 + 10} y={y(last.gross) + 4} fill={GROSS}>
              {last.gross.toFixed(1)}%
            </text>
            <text className={styles.endLabel} x={X1 + 10} y={y(last.counterparty) + 4} fill={COUNTERPARTY}>
              {last.counterparty.toFixed(1)}%
            </text>
          </>
        )}

        {active === null ? null : (
          <g>
            <line className={styles.crosshair} x1={x(active.share)} x2={x(active.share)} y1={Y1} y2={Y0} />
            <circle className={styles.hit} cx={x(active.share)} cy={y(active.gross)} r={7} fill={GROSS} />
            <circle
              className={styles.hit}
              cx={x(active.share)}
              cy={y(active.counterparty)}
              r={7}
              fill={COUNTERPARTY}
            />
          </g>
        )}
      </svg>

      <div className={styles.readout} aria-live="polite">
        {active === null ? (
          <span className={styles.readoutHint}>Hover the chart to read one share level</span>
        ) : (
          <>
            <span className={styles.readoutShare}>At {active.share}% of flow</span>
            <span className={styles.readoutValue} style={{color: COUNTERPARTY}}>
              {active.counterparty.toFixed(2)}% between counterparties
            </span>
            <span className={styles.readoutValue} style={{color: GROSS}}>
              {active.gross.toFixed(2)}% gross
            </span>
            <span className={styles.readoutValue}>{active.traders.toFixed(2)} traders per batch</span>
          </>
        )}
      </div>
    </div>
  );
}
