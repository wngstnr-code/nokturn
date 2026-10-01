"use client";

import {useEffect, useState, type CSSProperties} from "react";
import styles from "./HeroRain.module.css";

// Mid tones, so the white glyphs still read on them.
const COINS = ["var(--nk-amber-mid)", "var(--nk-mint-mid)", "var(--nk-peri-mid)"];

const GLYPHS = [
  // crescent moon
  "M23 12a11 11 0 1 0 9.5 16.5A9 9 0 0 1 23 12Z",
  // four point star
  "M24 10l3.2 10.8L38 24l-10.8 3.2L24 38l-3.2-10.8L10 24l10.8-3.2Z",
  // diamond
  "M24 11l8 13-8 13-8-13Z",
  // ring
  "M24 14a10 10 0 1 0 0 20a10 10 0 1 0 0-20Zm0 6a4 4 0 1 1 0 8a4 4 0 1 1 0-8Z",
  // pentagon
  "M24 12l11 8-4 13H17l-4-13Z",
  // five point star
  "M24 11l3.8 8.2 9 1-6.7 6.1 1.9 8.8L24 30.6l-8 4.5 1.9-8.8-6.7-6.1 9-1Z",
  // half disc
  "M12 24a12 12 0 0 1 24 0Z",
  // triangle
  "M24 13l12 21H12Z",
  // plus
  "M21 12h6v9h9v6h-9v9h-6v-9h-9v-6h9Z",
  // hexagon
  "M24 12l10.4 6v12L24 36l-10.4-6V18Z",
  // bolt
  "M27 10L15 27h8l-3 11 13-18h-8Z",
  // two eyes
  "M17 19a5 5 0 1 0 0 10a5 5 0 1 0 0-10ZM31 19a5 5 0 1 0 0 10a5 5 0 1 0 0-10Z",
  // square
  "M15 15h18v18H15Z",
  // heart
  "M24 35s-11-6.6-11-14a6 6 0 0 1 11-3.3A6 6 0 0 1 35 21c0 7.4-11 14-11 14Z",
];

const SPARKLE = "M12 0l2.6 9.4L24 12l-9.4 2.6L12 24l-2.6-9.4L0 12l9.4-2.6Z";
const TEARDROP = "M12 1C12 1 4 10.5 4 15.5a8 8 0 0 0 16 0C20 10.5 12 1 12 1Z";

const LANES = 13;
const PER_LANE = 2;
const LANE_FILL = 0.9;

type Kind = "coin" | "sparkle" | "teardrop";

// Lane, speed and start time are fixed, because they are what keep the drops apart.
type Track = {lane: number; turn: number; duration: number; delay: number};

// Everything else is redrawn each time a drop goes round again.
type Look = {kind: Kind; jitter: number; size: number; spin: number; fill: string; glyph: string};

const pick = <T,>(items: readonly T[], fallback: T): T => items[Math.floor(Math.random() * items.length)] ?? fallback;

// Collisions are ruled out by construction. Lanes never overlap sideways, because a drop
// is never wider than LANE_FILL of its lane. The drops that share a lane share a speed
// and start half a cycle apart, so the gap between them never closes. Every lane carries
// exactly one coin, so the coins cover the full width instead of bunching on one side.
function makeTracks(): Track[] {
  return Array.from({length: LANES}, (_, lane) => {
    const duration = 1.1 + Math.random() * 0.7;
    const offset = Math.random();
    return Array.from({length: PER_LANE}, (_, turn) => ({
      lane,
      turn,
      duration,
      delay: -(((offset + turn / PER_LANE) % 1) * duration),
    }));
  }).flat();
}

function makeLook(turn: number): Look {
  const kind: Kind = turn === 0 ? "coin" : Math.random() < 0.3 ? "teardrop" : "sparkle";
  const scale = Math.random();
  return {
    kind,
    jitter: Math.random(),
    size: kind === "coin" ? 64 + scale * 76 : kind === "sparkle" ? 18 + scale * 30 : 22 + scale * 24,
    spin: (Math.random() < 0.5 ? 1 : -1) * (120 + Math.random() * 300),
    fill: pick(COINS, "var(--nk-amber-mid)"),
    glyph: pick(GLYPHS, ""),
  };
}

function Shape({look}: {look: Look}) {
  if (look.kind === "coin") {
    return (
      <svg viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="24" fill={look.fill} />
        <path d={look.glyph} fill="#fff" fillRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24">
      <path d={look.kind === "sparkle" ? SPARKLE : TEARDROP} fill="#fff" />
    </svg>
  );
}

export function HeroRain() {
  // Built after mount, since a random layout cannot match between server and client.
  const [tracks, setTracks] = useState<Track[]>([]);
  const [looks, setLooks] = useState<Look[]>([]);

  useEffect(() => {
    const next = makeTracks();
    setTracks(next);
    setLooks(next.map((track) => makeLook(track.turn)));
  }, []);

  const redraw = (index: number, turn: number) =>
    setLooks((current) => current.map((look, i) => (i === index ? makeLook(turn) : look)));

  return (
    <div className={styles.rain} aria-hidden="true">
      {tracks.map((track, index) => {
        const look = looks[index];
        if (!look) return null;
        return (
          <span
            key={index}
            className={styles.drop}
            onAnimationIteration={() => redraw(index, track.turn)}
            style={
              {
                "--lane": `calc(100% / ${LANES})`,
                "--size": `min(${look.size}px, calc(100% / ${LANES} * ${LANE_FILL}))`,
                left: `calc(var(--lane) * ${track.lane} + (var(--lane) - var(--size)) * ${look.jitter})`,
                width: "var(--size)",
                animationDuration: `${track.duration}s`,
                animationDelay: `${track.delay}s`,
                "--spin": `${look.spin}deg`,
              } as CSSProperties
            }
          >
            <Shape look={look} />
          </span>
        );
      })}
    </div>
  );
}
