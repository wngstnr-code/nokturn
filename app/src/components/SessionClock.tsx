import {Session} from "@shared/types";

export type SessionSnapshot = {
  session: Session;
  name: string;
  nextTransition: number;
  readAt: number;
  chainId: number;
} | null;

export function countdown(seconds: number): string {
  if (seconds <= 0) return "due";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
