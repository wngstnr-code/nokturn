"use client";

import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from "react";
import type {Hex} from "@/lib/coordinator/types";

/*
 * Nothing on the frozen surface lists intents by owner, so a screen that wants
 * them has to remember what it sent and ask about each one.
 *
 * What is kept here is first hand. This tab built the intent and watched the
 * wallet sign it, so the summary is a record rather than a guess, and it is what
 * keeps a row from vanishing when the coordinator restarts and forgets its
 * mempool. Anything the coordinator itself reports stays clearly separate.
 */
export type Sent = {
  hash: Hex;
  sentAt: number;
  /// What this tab sent, already formatted. For example "120.0000 tNVDA".
  sold: string;
  buySymbol: string;
};

const KEY = "nokturn.intents.v1";
const MAX_KEPT = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Store = {
  sent: Sent[];
  remember(entry: Sent): void;
  forget(hash: Hex): void;
};

const IntentsContext = createContext<Store | null>(null);

function prune(entries: Sent[], now: number): Sent[] {
  return entries
    .filter((entry) => now - entry.sentAt < MAX_AGE_MS)
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, MAX_KEPT);
}

function load(): Sent[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(
      (entry): entry is Sent =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Sent).hash === "string" &&
        typeof (entry as Sent).sentAt === "number",
    );
    return prune(entries, Date.now());
  } catch {
    // Private windows and blocked site data both throw here, and neither is a
    // reason for the panel to stop working.
    return [];
  }
}

function save(entries: Sent[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Nothing to do. The list still works for this tab.
  }
}

export function IntentsProvider({children}: {children: ReactNode}) {
  const [sent, setSent] = useState<Sent[]>([]);

  // Read after mount rather than during render, because the server has no
  // localStorage and a mismatch there is a hydration error.
  useEffect(() => {
    setSent(load());
  }, []);

  // A tab left open past the retention window would otherwise keep showing a
  // row until something else made the list change.
  useEffect(() => {
    const timer = setInterval(() => {
      setSent((current) => {
        const next = prune(current, Date.now());
        if (next.length === current.length) return current;
        save(next);
        return next;
      });
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const remember = useCallback((entry: Sent) => {
    setSent((current) => {
      if (current.some((held) => held.hash === entry.hash)) return current;
      const next = prune([entry, ...current], Date.now());
      save(next);
      return next;
    });
  }, []);

  const forget = useCallback((hash: Hex) => {
    setSent((current) => {
      const next = current.filter((entry) => entry.hash !== hash);
      save(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({sent, remember, forget}), [sent, remember, forget]);

  return <IntentsContext.Provider value={value}>{children}</IntentsContext.Provider>;
}

export function useIntents(): Store {
  const store = useContext(IntentsContext);
  if (store === null) throw new Error("useIntents needs IntentsProvider above it");
  return store;
}
