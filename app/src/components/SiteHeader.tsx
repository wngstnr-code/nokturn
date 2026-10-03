"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {ConnectWallet} from "./ConnectWallet";
import {MaskIcon} from "./landing/MaskIcon";
import {BRAND} from "./landing/content";
import type {SessionSnapshot} from "./SessionClock";
import type {Network} from "@/lib/network";
import styles from "./SiteHeader.module.css";

const NAV = [
  {href: "/trade", label: "Trade"},
  {href: "/batch", label: "Batches"},
  {href: "/auction", label: "Auctions"},
  {href: "/session", label: "Session"},
  {href: "/allowlist", label: "Allowlist"},
  {href: "/netting", label: "Netting"},
];

export function SiteHeader({snapshot, network}: {snapshot: SessionSnapshot; network: Network}) {
  const pathname = usePathname();

  return (
    <header className={styles.shell}>
      {/*
        Cannot be closed, and sticks with the header. A screenshot of the testnet
        has to say so on its own, wherever on the page it was taken.
      */}
      {network.kind === "testnet" ? (
        <p className={styles.testnet} role="note">
          Testnet {network.chainId}. Test tokens and test liquidity. Prices mirrored from
          Chainlink on mainnet 4663.
        </p>
      ) : null}
      <div className={styles.bar}>
        <Link href="/" className={styles.brand}>
          <MaskIcon src={BRAND.mark} className={styles.mark} />
          Nokturn
        </Link>

        <nav className={styles.nav} aria-label="Primary">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.link} ${active ? styles.active : ""}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <span className={styles.spacer} />

        <div className={styles.right}>
          <ConnectWallet snapshot={snapshot} network={network} />
        </div>
      </div>
    </header>
  );
}
