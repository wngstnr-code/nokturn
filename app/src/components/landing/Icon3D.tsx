"use client";

import {useEffect, useRef, useState, type CSSProperties} from "react";
import {MaskIcon} from "./MaskIcon";
import styles from "./Icon3D.module.css";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The flat picture is what renders on the server and stays when WebGL is missing, so
// the box never changes size and the section never jumps when the solid appears.
// colored keeps the SVG's own colours. Without it the icon takes currentColor.
export function Icon3D({
  src,
  colored = false,
  className,
  style,
}: {
  src: string;
  colored?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const holder = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    const box = holder.current;
    if (!element || !box) return;
    let cleanup: (() => void) | undefined;
    let gone = false;
    const color = colored ? null : getComputedStyle(box).color;

    import("./icon3d-scene")
      .then(({mountIcon3D}) => mountIcon3D(element, {src, color, still: reducedMotion(), watch: element}))
      .then((stop) => {
        if (gone) stop();
        else {
          cleanup = stop;
          setReady(true);
        }
      })
      .catch(() => setReady(false));

    return () => {
      gone = true;
      cleanup?.();
    };
  }, [src, colored]);

  const flat = `${styles.flat} ${ready ? styles.hidden : ""}`;
  return (
    <span ref={holder} className={`${styles.holder} ${className ?? ""}`} style={style} aria-hidden="true">
      {colored ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className={flat} />
      ) : (
        <MaskIcon src={src} className={flat} />
      )}
      <canvas ref={canvas} className={`${styles.canvas} ${ready ? styles.shown : ""}`} />
    </span>
  );
}

/*
 * The same solid shown in several places, like the owl that repeats along the footer
 * marquee. One WebGL context draws it and every copy is a plain 2D canvas that takes
 * the frame, because a context per copy runs into the browser's limit on contexts.
 */
type Shared = {targets: Set<HTMLCanvasElement>; stop?: () => void; users: number};
const shared = new Map<string, Shared>();

export function Icon3DCopy({src, wings, className}: {src: string; wings?: string[]; className?: string}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    let entry = shared.get(src);
    if (!entry) {
      entry = {targets: new Set(), users: 0};
      shared.set(src, entry);
      const owner = entry;
      const source = document.createElement("canvas");
      const ratio = Math.min(window.devicePixelRatio, 2);
      const width = Math.round(target.clientWidth * ratio);
      const height = Math.round(target.clientHeight * ratio);
      const watch = target.closest("[data-icon3d-watch]") ?? target;

      import("./icon3d-scene")
        .then(({mountIcon3D}) =>
          mountIcon3D(source, {
            src,
            color: null,
            still: reducedMotion(),
            watch,
            size: {width, height},
            wings,
            onFrame: () => {
              owner.targets.forEach((copy) => {
                if (copy.width !== width) copy.width = width;
                if (copy.height !== height) copy.height = height;
                const context = copy.getContext("2d");
                context?.clearRect(0, 0, width, height);
                context?.drawImage(source, 0, 0, width, height);
                copy.dataset.live = "true";
              });
            },
          }),
        )
        .then((stop) => {
          if (owner.users === 0) stop();
          else owner.stop = stop;
        })
        .catch(() => undefined);
    }
    entry.users += 1;
    entry.targets.add(target);

    const mine = entry;
    return () => {
      mine.targets.delete(target);
      mine.users -= 1;
      if (mine.users === 0) {
        mine.stop?.();
        shared.delete(src);
      }
    };
  }, [src, wings]);

  return (
    <span className={`${styles.copy} ${className ?? ""}`} aria-hidden="true">
      <canvas ref={canvas} className={styles.copyCanvas} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={styles.flat} />
    </span>
  );
}
