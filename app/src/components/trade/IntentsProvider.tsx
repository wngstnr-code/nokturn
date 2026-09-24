"use client";

import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from "react";
import type {Hex} from "@/lib/coordinator/types";

/*
 * Nothing on the frozen surface lists intents by owner, so a screen that wants
 * them has to remember what it sent and ask about each one.
 */
type Store = {
  hashes: Hex[];
  remember(hash: Hex): void;
};

const IntentsContext = createContext<Store | null>(null);

export function IntentsProvider({children}: {children: ReactNode}) {
  const [hashes, setHashes] = useState<Hex[]>([]);

  const remember = useCallback((hash: Hex) => {
    setHashes((current) => (current.includes(hash) ? current : [hash, ...current]));
  }, []);

  const value = useMemo(() => ({hashes, remember}), [hashes, remember]);

  return <IntentsContext.Provider value={value}>{children}</IntentsContext.Provider>;
}

export function useIntents(): Store {
  const store = useContext(IntentsContext);
  if (store === null) throw new Error("useIntents needs IntentsProvider above it");
  return store;
}
