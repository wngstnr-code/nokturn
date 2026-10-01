"use client";

import Link from "next/link";
import {useEffect, useRef, useState} from "react";
import {BRAND, LAUNCH_CTA, NAV_ITEMS, type NavChild, type NavIcon} from "./content";
import {MaskIcon} from "./MaskIcon";
import styles from "./LandingHeader.module.css";

const ICONS: Record<NavIcon, string> = {
  trade: "M7 7h11l-3-3M17 17H6l3 3",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 8h6M9 12h6",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18ZM12 7v5l3 2",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6ZM9 12l2 2 4-4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  data: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  contract: "M7 3h7l5 5v13H7ZM14 3v5h5M10 13h6M10 17h6",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2ZM4 19V5",
  glossary: "M4 19l5-14h2l5 14M6.5 13h7M18 9v10",
  risk: "M12 3l10 18H2ZM12 10v5M12 18v.5",
};

function ChildLink({child, onNavigate}: {child: NavChild; onNavigate: () => void}) {
  const body = (
    <>
      <span className={styles.icon} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d={ICONS[child.icon]} />
        </svg>
      </span>
      <span className={styles.text}>
        <span className={styles.title}>
          {child.label}
          {child.external && <span className={styles.external}>&#8599;</span>}
        </span>
        <span className={styles.description}>{child.description}</span>
      </span>
    </>
  );

  if (child.external) {
    return (
      <a className={styles.dropdownItem} href={child.href} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
        {body}
      </a>
    );
  }
  return (
    <Link className={styles.dropdownItem} href={child.href} onClick={onNavigate}>
      {body}
    </Link>
  );
}

export function LandingHeader() {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const closeAll = () => {
    setOpen(null);
    setMobile(false);
  };

  return (
    <div className={styles.wrapper} ref={ref}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo} aria-label={`${BRAND.name} home`}>
          <MaskIcon src={BRAND.mark} className={styles.mark} />
          <span className={styles.wordmark}>{BRAND.name}</span>
        </Link>

        <ul className={`${styles.nav} ${mobile ? styles.navOpen : ""}`}>
          {NAV_ITEMS.map((item) => {
            const isOpen = open === item.label;
            return (
              <li key={item.label} className={styles.item}>
                <button
                  type="button"
                  className={styles.trigger}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : item.label)}
                >
                  {item.label}
                  <svg className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`} viewBox="0 0 13 8">
                    <path d="M1 1l5.5 5.5L12 1" stroke="currentColor" strokeWidth="2" fill="none" />
                  </svg>
                </button>
                {isOpen && (
                  <ul className={styles.dropdown}>
                    {item.children.map((child) => (
                      <li key={child.label}>
                        <ChildLink child={child} onNavigate={closeAll} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        <div className={styles.right}>
          <a className={styles.cta} href={LAUNCH_CTA.href} target="_blank" rel="noopener noreferrer">
            {LAUNCH_CTA.text}
          </a>
          <button
            type="button"
            className={styles.burger}
            aria-label="Menu"
            aria-expanded={mobile}
            onClick={() => setMobile((value) => !value)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>
    </div>
  );
}
