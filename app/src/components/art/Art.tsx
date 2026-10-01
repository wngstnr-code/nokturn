import styles from "./Art.module.css";

/*
 * The app's own pictures, drawn in the language the landing page speaks. Flat
 * fields of amber, periwinkle, mint and cream, thick rounded strokes, and the four
 * point sparkle that sits on every landing card. No outline icon set, because a
 * stock outline says nothing about whose product this is.
 *
 * Every picture is drawn on a 48 box. The colours are fixed rather than taken
 * from currentColor, since a picture with one colour is an icon again.
 */
const AMBER = "#ffb825";
const AMBER_DEEP = "#e09600";
const AMBER_DARK = "#b97800";
const AMBER_PALE = "#ffd574";
const CREAM = "#fff1cf";
const PERI = "#5f80e0";
const PERI_PALE = "#a2bcff";
const PERI_DEEP = "#1c2369";
const MINT = "#5fe6c1";
const MINT_DEEP = "#00ab89";
const CORAL = "#ff6b5e";
const CORAL_DEEP = "#c8402f";
const WHITE = "#ffffff";

type ArtProps = {size?: number; className?: string};

function frame(size: number, className?: string) {
  return {width: size, height: size, viewBox: "0 0 48 48", fill: "none", "aria-hidden": true, className};
}

/** The landing page's four point sparkle, centred on a point. */
function Sparkle({x, y, r, fill = WHITE}: {x: number; y: number; r: number; fill?: string}) {
  const a = r * 0.3;
  return (
    <path
      fill={fill}
      d={`M${x} ${y - r}L${x + a} ${y - a}L${x + r} ${y}L${x + a} ${y + a}L${x} ${y + r}L${x - a} ${y + a}L${x - r} ${y}L${x - a} ${y - a}Z`}
    />
  );
}

/** A coloured tile for a picture to sit on, the way a landing card holds its art. */
export function Tile({
  tone,
  size = 68,
  children,
}: {
  tone: "amber" | "mint" | "night" | "peri" | "coral";
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`${styles.tile} ${styles[tone]}`}
      style={{width: size, height: size, borderRadius: Math.round(size * 0.32)}}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/*
 * A batch has a face. The owl is the logo's own head, and the sheet beside it is
 * the receipt the batch leaves behind. The colours come from the batch number, so
 * one batch looks the same on the list, on its receipt and after a reload, and
 * two batches side by side can be told apart before their numbers are read.
 */
const BATCH_COATS = [
  {tile: PERI_DEEP, owls: [AMBER, MINT, CREAM], sheet: CREAM, rule: PERI_PALE},
  {tile: AMBER, owls: [PERI_DEEP, WHITE, PERI], sheet: WHITE, rule: AMBER_DEEP},
  {tile: MINT, owls: [PERI_DEEP, WHITE, PERI], sheet: WHITE, rule: MINT_DEEP},
  {tile: PERI, owls: [CREAM, AMBER, PERI_DEEP], sheet: WHITE, rule: PERI_PALE},
  {tile: CREAM, owls: [PERI, AMBER_DEEP, PERI_DEEP], sheet: WHITE, rule: AMBER},
  {tile: PERI_PALE, owls: [PERI_DEEP, WHITE, AMBER_DARK], sheet: WHITE, rule: PERI},
  {tile: MINT_DEEP, owls: [CREAM, AMBER, PERI_DEEP], sheet: WHITE, rule: MINT},
] as const;

/// Where the owl is looking. A second way two batches differ when their coats match.
const GAZES = [
  [0, 0],
  [-3.4, 0],
  [3.4, 0],
  [0, -3.4],
  [0, 3.4],
] as const;

/*
 * A batch is numbered by the second its collection closes, and windows are 10,
 * 30 or 60 seconds long. Counting in tens of seconds and taking the remainder by
 * seven, which shares no factor with one, three or six, walks neighbouring
 * batches through the coats rather than landing them on the same one. The owl's
 * own colour and where it looks turn once per lap of the coats, so two batches
 * that do land on one tile still do not share a face.
 */
function faceFor(seed: string) {
  const second = Number(seed);
  let count: number;
  if (Number.isFinite(second)) {
    count = Math.floor(second / 10);
  } else {
    count = 0;
    for (const char of seed) count = (count * 31 + char.charCodeAt(0)) >>> 0;
  }
  const coat = BATCH_COATS[count % BATCH_COATS.length]!;
  const turn = Math.floor(count / BATCH_COATS.length) % GAZES.length;
  return {coat, owl: coat.owls[turn % coat.owls.length]!, gaze: GAZES[turn]!};
}

export function BatchOwl({seed, size = 44, className}: ArtProps & {seed: string}) {
  const {coat, owl, gaze} = faceFor(seed);

  return (
    <svg {...frame(size, className)}>
      <rect width="48" height="48" rx="15" fill={coat.tile} />
      <g transform="rotate(8 34 22)">
        <rect x="25" y="8" width="17" height="24" rx="3.5" fill={coat.sheet} />
        <rect x="28.5" y="13" width="7" height="2.6" rx="1.3" fill={coat.rule} />
        <rect x="28.5" y="18.5" width="10" height="2.2" rx="1.1" fill={coat.rule} />
        <rect x="28.5" y="23" width="8" height="2.2" rx="1.1" fill={coat.rule} />
      </g>
      <g transform="translate(4 14) scale(0.5)">
        <path
          d="M3 13L19 19.5Q32 16 45 19.5L61 13Q62.5 28 59 40Q53.5 58.5 32 60.5Q10.5 58.5 5 40Q1.5 28 3 13Z"
          fill={owl}
        />
        <circle cx="21" cy="35" r="11.4" fill={coat.tile} />
        <circle cx="43" cy="35" r="11.4" fill={coat.tile} />
        <circle cx={21 + gaze[0]} cy={35 + gaze[1]} r="5.4" fill={owl} />
        <circle cx={43 + gaze[0]} cy={35 + gaze[1]} r="5.4" fill={owl} />
        <path d="M27.5 43.5H36.5L32 52Z" fill={coat.tile} />
      </g>
    </svg>
  );
}

/** Night. The market is shut and the owl is up. */
export function MoonArt({size = 40, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M31 8a16 16 0 1 0 9.6 27.4A13 13 0 0 1 31 8Z" fill={AMBER} />
      <circle cx="20" cy="22" r="2.6" fill={AMBER_DEEP} />
      <circle cx="26" cy="32" r="1.8" fill={AMBER_DEEP} />
      <Sparkle x={12} y={13} r={4.5} fill={PERI_PALE} />
      <Sparkle x={40} y={15} r={3} />
      <Sparkle x={9} y={34} r={2.5} fill={MINT} />
    </svg>
  );
}

/** Day. A session that is trading. */
export function SunArt({size = 40, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <g stroke={AMBER_PALE} strokeWidth="3.4" strokeLinecap="round">
        <path d="M24 4.5v5M24 38.5v5M4.5 24h5M38.5 24h5M10.2 10.2l3.5 3.5M34.3 34.3l3.5 3.5M37.8 10.2l-3.5 3.5M13.7 34.3l-3.5 3.5" />
      </g>
      <circle cx="24" cy="24" r="10.5" fill={AMBER} />
      <path d="M16.5 20a8.5 8.5 0 0 1 9-4.8" stroke={CREAM} strokeWidth="2.4" strokeLinecap="round" />
      <Sparkle x={41} y={8} r={3.2} />
    </svg>
  );
}

/** The bell. An opening or a closing cross. */
export function BellArt({size = 40, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <circle cx="24" cy="38.5" r="4.2" fill={PERI} />
      <path d="M24 8.5c-7.2 0-11.5 5.3-11.5 12.4v5.6L8 34h32l-4.5-7.5v-5.6c0-7.1-4.3-12.4-11.5-12.4Z" fill={AMBER} />
      <path d="M24 8.5c7.2 0 11.5 5.3 11.5 12.4v5.6L40 34H24Z" fill={AMBER_DEEP} />
      <circle cx="24" cy="7" r="3" fill={AMBER_PALE} />
      <path d="M6 15.5a14 14 0 0 1 3.4-6M42 15.5a14 14 0 0 0-3.4-6" stroke={PERI_PALE} strokeWidth="2.6" strokeLinecap="round" />
      <Sparkle x={41} y={25} r={3} />
    </svg>
  );
}

/** A shield, split down the middle the way the landing draws depth. */
function Shield({left, right}: {left: string; right: string}) {
  return (
    <>
      <path d="M24 5l15 5.4v11.2c0 9.6-6.2 17-15 21.4-8.8-4.4-15-11.8-15-21.4V10.4Z" fill={left} />
      <path d="M24 5l15 5.4v11.2c0 9.6-6.2 17-15 21.4Z" fill={right} />
    </>
  );
}

/** Held. A token or a session in the protective state. */
export function HeldArt({size = 40, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <Shield left={CORAL} right={CORAL_DEEP} />
      <path d="M24 15v10" stroke={WHITE} strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="24" cy="31.5" r="2.2" fill={WHITE} />
    </svg>
  );
}

/** The gate. A contract on one side and the seal it has to earn on the other. */
export function GateArt({size = 40, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M9 6h20l8 8v26a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" fill={WHITE} />
      <path d="M29 6l8 8h-6a2 2 0 0 1-2-2Z" fill={PERI_PALE} />
      <rect x="11" y="13" width="11" height="3.4" rx="1.7" fill={PERI} />
      <rect x="11" y="20.5" width="18" height="2.6" rx="1.3" fill={PERI_PALE} />
      <rect x="11" y="25.5" width="14" height="2.6" rx="1.3" fill={PERI_PALE} />
      <rect x="11" y="30.5" width="16" height="2.6" rx="1.3" fill={PERI_PALE} />
      <circle cx="35" cy="35" r="9.5" fill={MINT_DEEP} />
      <circle cx="35" cy="35" r="6.6" fill={MINT} />
      <path d="M31.4 35.2l2.6 2.6 4.8-5.2" stroke={WHITE} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <Sparkle x={5} y={41} r={2.6} fill={AMBER} />
    </svg>
  );
}

/** Two flows meeting head on, which is what netting is. */
export function NettingArt({size = 40, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M5 16h22" stroke={AMBER} strokeWidth="5" strokeLinecap="round" />
      <path d="M22 9l8 7-8 7" stroke={AMBER} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M43 32H21" stroke={PERI} strokeWidth="5" strokeLinecap="round" />
      <path d="M26 25l-8 7 8 7" stroke={PERI} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <Sparkle x={39} y={12} r={4} />
      <Sparkle x={8} y={35} r={2.8} fill={MINT} />
    </svg>
  );
}

/** A stopwatch, for how long a batch collects. */
export function WindowArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <rect x="19" y="3" width="10" height="6" rx="2" fill={AMBER_DEEP} />
      <circle cx="24" cy="27" r="17" fill={PERI} />
      <circle cx="24" cy="27" r="12" fill={PERI_PALE} />
      <path d="M24 18v9l6 4" stroke={PERI_DEEP} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A price held between two rails. */
export function BandArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <rect x="4" y="7" width="40" height="6" rx="3" fill={PERI} />
      <rect x="4" y="35" width="40" height="6" rx="3" fill={PERI} />
      <path d="M8 27l8-5 7 4 8-7 9 5" stroke={AMBER} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="31" cy="19" r="4" fill={AMBER_PALE} />
    </svg>
  );
}

/** The fence around a session edge. */
export function GuardArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <Shield left={PERI_PALE} right={PERI} />
      <path d="M17 24.5l5 5 9.5-10" stroke={WHITE} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A calendar page with the sun on it. */
export function DayArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <rect x="5" y="9" width="38" height="34" rx="6" fill={CREAM} />
      <path d="M5 15a6 6 0 0 1 6-6h26a6 6 0 0 1 6 6v5H5Z" fill={AMBER} />
      <rect x="13" y="4" width="5" height="10" rx="2.5" fill={AMBER_DARK} />
      <rect x="30" y="4" width="5" height="10" rx="2.5" fill={AMBER_DARK} />
      <circle cx="24" cy="31" r="6" fill={AMBER_DEEP} />
    </svg>
  );
}

/** A stack of coins. */
export function CoinsArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <ellipse cx="20" cy="36" rx="15" ry="6" fill={AMBER_DARK} />
      <ellipse cx="20" cy="29" rx="15" ry="6" fill={AMBER_DEEP} />
      <ellipse cx="20" cy="22" rx="15" ry="6" fill={AMBER} />
      <ellipse cx="20" cy="22" rx="8" ry="2.8" fill={AMBER_PALE} />
      <Sparkle x={40} y={12} r={5} />
    </svg>
  );
}

/** Two people, for how many owners stood in a book. */
export function PeopleArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <circle cx="32" cy="16" r="7" fill={MINT} />
      <path d="M20 42a12 12 0 0 1 24 0Z" fill={MINT_DEEP} />
      <circle cx="17" cy="18" r="8" fill={PERI_PALE} />
      <path d="M3 42a14 14 0 0 1 28 0Z" fill={PERI} />
    </svg>
  );
}

/** Sheets in a pile, for how many intents a batch held. */
export function SheetsArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <rect x="14" y="5" width="28" height="32" rx="5" fill={PERI} />
      <rect x="6" y="11" width="28" height="32" rx="5" fill={CREAM} />
      <rect x="11" y="18" width="12" height="3.6" rx="1.8" fill={AMBER} />
      <rect x="11" y="25.5" width="18" height="3" rx="1.5" fill={PERI_PALE} />
      <rect x="11" y="32" width="14" height="3" rx="1.5" fill={PERI_PALE} />
    </svg>
  );
}

/** A small clock, for a time read from the chain. */
export function ClockArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <circle cx="24" cy="24" r="19" fill={AMBER} />
      <circle cx="24" cy="24" r="13.5" fill={CREAM} />
      <path d="M24 15v9l6 4" stroke={AMBER_DARK} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One block of the chain. */
export function BlockArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M24 4l18 10v20L24 44 6 34V14Z" fill={PERI} />
      <path d="M24 24l18-10v20L24 44Z" fill={PERI_DEEP} opacity="0.55" />
      <path d="M24 4l18 10-18 10L6 14Z" fill={PERI_PALE} />
    </svg>
  );
}

/** The globe, for which chain a figure was read on. */
export function ChainArt({size = 22, className}: ArtProps) {
  return (
    <svg {...frame(size, className)}>
      <circle cx="24" cy="24" r="19" fill={MINT} />
      <path d="M24 5c8 6 8 32 0 38-8-6-8-32 0-38Z" fill={MINT_DEEP} />
      <path d="M6 24h36" stroke={WHITE} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/*
 * The seal. A ring in the deeper shade with the lighter one inside it, which is
 * how the landing page draws a thing that has been checked. Passed, failed and
 * not answered each have their own shape as well as their own colour.
 */
export function Seal({state, size = 18, className}: {state: "pass" | "fail" | "unknown"; size?: number; className?: string}) {
  const [outer, inner] =
    state === "pass" ? [MINT_DEEP, MINT] : state === "fail" ? [CORAL_DEEP, CORAL] : [AMBER_DARK, AMBER];

  return (
    <svg {...frame(size, className)}>
      <circle cx="24" cy="24" r="22" fill={outer} />
      <circle cx="24" cy="24" r="15.5" fill={inner} />
      {state === "pass" ? (
        <path d="M15.5 24.5l6 6 11.5-12.5" stroke={WHITE} strokeWidth="5.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : state === "fail" ? (
        <path d="M17 17l14 14M31 17L17 31" stroke={WHITE} strokeWidth="5.4" strokeLinecap="round" />
      ) : (
        <>
          <path d="M24 14.5v11" stroke={WHITE} strokeWidth="5.4" strokeLinecap="round" />
          <circle cx="24" cy="33" r="3" fill={WHITE} />
        </>
      )}
    </svg>
  );
}
