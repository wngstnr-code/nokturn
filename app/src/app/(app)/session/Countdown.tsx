"use client";

import {useEffect, useState} from "react";
import {countdown} from "@/components/SessionClock";

export function Countdown({target, readAt}: {target: number; readAt: number}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return <span className="chainvalue">{countdown(target - readAt - elapsed)}</span>;
}
