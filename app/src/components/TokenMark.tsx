"use client";

import {useState} from "react";
import styles from "./TokenMark.module.css";

/*
 * The mark of the company a Stock Token tracks, so a row is recognised before it
 * is read. The three single colour marks are the paths published in the Simple
 * Icons set, which is CC0, and the Google one is its standard four colour G. The
 * marks remain trademarks of their owners and are used here only to say which
 * stock a token follows.
 *
 * Only the exact mainnet symbols are matched. A test token named tNVDA is not
 * NVDA, and it keeps its initials so the screen does not dress it as the real one.
 *
 * A mark that is not drawn here can be supplied as a file in public/tokens and
 * listed in FROM_FILE. A raster file is used as it came. Tracing one into paths
 * would bend a mark its owner drew with care, and at these sizes two hundred
 * pixels is already more than the screen can show. Until a file is there the
 * token shows its initials.
 */
type Mark = {background: string; viewBox: string; paths: Array<{d: string; fill: string}>; inset: number};

const MARKS: Record<string, Mark> = {
  NVDA: {
    background: "#76b900",
    viewBox: "0 0 24 24",
    inset: 0.2,
    paths: [
      {
        fill: "#ffffff",
        d: "M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z",
      },
    ],
  },
  AAPL: {
    background: "#ffffff",
    viewBox: "0 0 24 24",
    inset: 0.24,
    paths: [
      {
        fill: "#000000",
        d: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
      },
    ],
  },
  TSLA: {
    background: "#cc0000",
    viewBox: "0 0 24 24",
    inset: 0.24,
    paths: [
      {
        fill: "#ffffff",
        d: "M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.188.354-4.335 1.792 0 0-2.146-.795-3.229-2.43C5.28 2.431 9.525 2.34 9.525 2.34L12 5.362l-.004.002H12v-.002zm0-3.899c3.415-.03 7.326.528 11.328 2.28.535-.968.672-1.395.672-1.395C19.625.612 15.528.015 12 0 8.472.015 4.375.61 0 2.349c0 0 .195.525.672 1.396C4.674 1.989 8.585 1.435 12 1.46v.003z",
      },
    ],
  },
  GOOGL: {
    background: "#ffffff",
    viewBox: "0 0 48 48",
    inset: 0.22,
    paths: [
      {
        fill: "#ea4335",
        d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
      },
      {
        fill: "#4285f4",
        d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
      },
      {
        fill: "#fbbc05",
        d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
      },
      {
        fill: "#34a853",
        d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
      },
    ],
  },
};

/*
 * Marks kept as files. A background is given where the artwork is transparent
 * and dark, which would otherwise vanish against a dark card.
 */
const FROM_FILE: Record<string, {file: string; background?: string; inset: number}> = {
  GME: {file: "GME.png", background: "#ffffff", inset: 0.04},
  USDG: {file: "USDG.png", inset: 0},
};

/**
 * @param unverified The token only claims this symbol. It gets initials, never the
 *   company mark, since the mark is exactly what an impostor is borrowing.
 */
export function TokenMark({
  symbol,
  size = 36,
  unverified = false,
}: {
  symbol: string;
  size?: number;
  unverified?: boolean;
}) {
  const mark = unverified ? undefined : MARKS[symbol];
  const filed = unverified ? undefined : FROM_FILE[symbol];
  const [missing, setMissing] = useState(false);

  if (mark === undefined && filed !== undefined && !missing) {
    return (
      <span
        className={styles.mark}
        style={{
          width: size,
          height: size,
          padding: Math.round(size * filed.inset),
          background: filed.background,
        }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.file}
          src={`/tokens/${filed.file}`}
          alt=""
          onError={() => setMissing(true)}
        />
      </span>
    );
  }

  if (mark === undefined) {
    return (
      <span
        className={styles.initials}
        style={{width: size, height: size, fontSize: Math.round(size * 0.33)}}
        aria-hidden="true"
      >
        {symbol.replace(/^t(?=[A-Z])/, "").slice(0, 2).toUpperCase()}
      </span>
    );
  }

  const pad = Math.round(size * mark.inset);

  return (
    <span
      className={styles.mark}
      style={{width: size, height: size, padding: pad, background: mark.background}}
      aria-hidden="true"
    >
      <svg viewBox={mark.viewBox} width="100%" height="100%">
        {mark.paths.map((path) => (
          <path key={path.fill} d={path.d} fill={path.fill} />
        ))}
      </svg>
    </span>
  );
}
