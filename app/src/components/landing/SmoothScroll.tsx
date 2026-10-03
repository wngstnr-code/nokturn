"use client";

import {useEffect} from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

// Landing only. The app screens keep native scrolling, because a trade card that lags
// the wheel reads as a slow page rather than a heavy one.
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({lerp: 0.045, wheelMultiplier: 0.8, anchors: true});
    let frame = requestAnimationFrame(function raf(time) {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    });

    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, []);

  return null;
}
