"use client";

import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from "react";
import type {Hex} from "@/lib/coordinator/types";

/*
 * Nothing on the frozen surface lists intents by owner, so a screen that wants
 * them has to remember what it sent and ask about each one.
 */
export type Sent = {hash: Hex; sentAt: number};

type Store = {
  sent: Sent[];
  remember(hash: Hex): void;
};

const IntentsContext = createContext<Store | null>(null);

export function IntentsProvider({children}: {children: ReactNode}) {
  const [sent, setSent] = useState<Sent[]>([]);

  const remember = useCallback((hash: Hex) => {
    setSent((current) =>
      current.some((entry) => entry.hash === hash)
        ? current
        : // This tab's own clock, and it only ever labels when this tab sent
          // something. No chain fact is derived from it.
          [{hash, sentAt: Date.now()}, ...current],
    );
  }, []);

  const value = useMemo(() => ({sent, remember}), [sent, remember]);

  return <IntentsContext.Provider value={value}>{children}</IntentsContext.Provider>;
}

export function useIntents(): Store {
  const store = useContext(IntentsContext);
  if (store === null) throw new Error("useIntents needs IntentsProvider above it");
  return store;
}
