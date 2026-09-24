"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {ConnectWallet} from "./ConnectWallet";
import {SessionClock, type SessionSnapshot} from "./SessionClock";
import styles from "./SiteHeader.module.css";

/*
 * /auction is deliberately absent. The route exists, but docs/demo.md section 3b
 * priority 3 has an open decision above it about who its participants are, and
 * rule 9 says a feature that cannot run on real data is not shown. It stays
 * reachable by address until that is settled.
 */
const NAV = [
  {href: "/", label: "Trade"},
  {href: "/batch", label: "Batches"},
  {href: "/session", label: "Session"},
  {href: "/allowlist", label: "Allowlist"},
  {href: "/netting", label: "Netting"},
];

export function SiteHeader({snapshot}: {snapshot: SessionSnapshot}) {
  const pathname = usePathname();

  return (
    <header className={styles.shell}>
      <div className={styles.bar}>
        <Link href="/" className={styles.brand}>
          <span className={styles.moon} aria-hidden="true" />
          Nokturn
        </Link>

        <nav className={styles.nav} aria-label="Primary">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
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
          <span className={styles.sessionPill}>
            <SessionClock snapshot={snapshot} />
          </span>
          <span className={`${styles.pill} ${styles.networkPill}`}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.pillStrong}>Testnet</span>
            <span className={`${styles.pillMuted} chainvalue`}>46630</span>
          </span>
          <ConnectWallet />
        </div>
      </div>
    </header>
  );
}
