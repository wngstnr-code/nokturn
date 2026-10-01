"use client";

import {useState} from "react";
import styles from "./NettingChart.module.css";

export type Point = {share: number; counterparty: number; gross: number; traders: number};

/*
 * Both curves are drawn because the argument is that the stricter definition
 * produced the higher number, and that only shows with the looser one beside it.
 * The blue is the periwinkle the landing page uses for its coins and the amber is
 * a step below the brand one, which sits outside the band a line needs on this
 * surface. The pair passes all five palette checks against the chart well.
 */
const COUNTERPARTY = "#5f80e0";
const GROSS = "#b8831f";

const W = 760;
const H = 380;
const PAD = {top: 36, right: 132, bottom: 48, left: 48};

const X0 = PAD.left;
const X1 = W - PAD.right;
const Y0 = H - PAD.bottom;
const Y1 = PAD.top;

const Y_MAX = 70;
const GRID = [0, 20, 40, 60];

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
  const [index, setIndex] = useState<number | null>(null);
  const active = index === null ? null : (points[index] ?? null);
  const last = points[points.length - 1];


  function nearest(clientX: number, target: SVGSVGElement) {
    const box = target.getBoundingClientRect();
    const local = ((clientX - box.left) / box.width) * W;
    let best = 0;
    let bestGap = Infinity;
    points.forEach((p, i) => {
      const gap = Math.abs(x(p.share) - local);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    setIndex(best);
  }

  // The card flips to the other side of the line past the middle, so it never
  // leaves the plot or covers the point it describes.
  const left = active === null ? 0 : (x(active.share) / W) * 100;
  const flipped = left > 55;

  return (
    <div className={styles.wrap}>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.stroke} style={{background: COUNTERPARTY}} />
          Between counterparties
        </span>
        <span className={styles.legendItem}>
          <span className={styles.stroke} style={{background: GROSS}} />
          Gross, bots included
        </span>
      </div>

      <div className={styles.plot}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Netting ratio against Nokturn's share of flow, August 2026 backtest."
          onMouseMove={(event) => nearest(event.clientX, event.currentTarget)}
          onMouseLeave={() => setIndex(null)}
        >
          {/* The share range this project actually quotes, called out rather than
              left for the reader to find. parameter.md section 4. */}
          <rect className={styles.band} x={x(10)} y={Y1} width={x(20) - x(10)} height={Y0 - Y1} rx={6} />
          <text className={styles.bandText} x={(x(10) + x(20)) / 2} y={Y1 - 12} textAnchor="middle">
            the share we quote
          </text>

          {GRID.map((value) => (
            <g key={value}>
              <line className={styles.grid} x1={X0} x2={X1} y1={y(value)} y2={y(value)} />
              <text className={styles.axisText} x={X0 - 10} y={y(value) + 4} textAnchor="end">
                {value}%
              </text>
            </g>
          ))}

          {points.map((p) => (
            <text key={p.share} className={styles.axisText} x={x(p.share)} y={Y0 + 20} textAnchor="middle">
              {p.share}%
            </text>
          ))}
          <text className={styles.axisTitle} x={(X0 + X1) / 2} y={H - 6} textAnchor="middle">
            Nokturn share of flow
          </text>

          <path className={styles.line} d={path(points, (p) => p.gross)} stroke={GROSS} />
          <path className={styles.line} d={path(points, (p) => p.counterparty)} stroke={COUNTERPARTY} />

          {last === undefined ? null : (
            <>
              <text className={styles.endValue} x={X1 + 12} y={y(last.gross) + 1} fill={GROSS}>
                {last.gross.toFixed(1)}%
              </text>
              <text className={styles.endName} x={X1 + 12} y={y(last.gross) + 16}>
                gross
              </text>
              <text className={styles.endValue} x={X1 + 12} y={y(last.counterparty) + 1} fill={COUNTERPARTY}>
                {last.counterparty.toFixed(1)}%
              </text>
              <text className={styles.endName} x={X1 + 12} y={y(last.counterparty) + 16}>
                between counterparties
              </text>
            </>
          )}

          {active === null ? null : (
            <g>
              <line className={styles.crosshair} x1={x(active.share)} x2={x(active.share)} y1={Y1} y2={Y0} />
              <circle className={styles.hit} cx={x(active.share)} cy={y(active.gross)} r={6} fill={GROSS} />
              <circle
                className={styles.hit}
                cx={x(active.share)}
                cy={y(active.counterparty)}
                r={6}
                fill={COUNTERPARTY}
              />
            </g>
          )}
        </svg>

        {active === null ? null : (
          <div
            className={`${styles.tip} ${flipped ? styles.tipLeft : ""}`}
            style={{left: `${left}%`}}
            role="status"
          >
            <p className={styles.tipHead}>At {active.share}% of flow</p>
            <p className={styles.tipRow}>
              <span className={styles.stroke} style={{background: COUNTERPARTY}} />
              Between counterparties
              <strong>{active.counterparty.toFixed(2)}%</strong>
            </p>
            <p className={styles.tipRow}>
              <span className={styles.stroke} style={{background: GROSS}} />
              Gross
              <strong>{active.gross.toFixed(2)}%</strong>
            </p>
            <p className={styles.tipFoot}>{active.traders.toFixed(2)} traders per batch</p>
          </div>
        )}
      </div>

      <p className={styles.readoutHint}>
        Hover the chart to read one share level
      </p>
    </div>
  );
}
