"use client";

import Link from "next/link";
import {useRef, useState} from "react";
import {ArrowCircleIcon, GithubIcon} from "./Icons";
import styles from "./SiteFooter.module.css";

const REPO = "https://github.com/wngstnr-code/nokturn";
const DUNE =
  "https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026";
const EXPLORER = "https://robinhood-testnet.cloud.blockscout.com";
const CHAIN_DOCS = "https://docs.chain.robinhood.com";

const GROUPS = [
  {
    title: "Protocol",
    links: [
      {href: "/", label: "Trade"},
      {href: "/batch", label: "Batches"},
      {href: "/session", label: "Session"},
      {href: "/allowlist", label: "Allowlist"},
      {href: "/netting", label: "Netting"},
    ],
  },
  {
    title: "Check the numbers",
    links: [
      {href: DUNE, label: "Dune dashboard", external: true},
      {href: EXPLORER, label: "Block explorer", external: true},
    ],
  },
  {
    title: "Project",
    links: [
      {href: REPO, label: "Source", external: true},
      {href: CHAIN_DOCS, label: "Robinhood Chain", external: true},
    ],
  },
];

function Mark({size}: {size: number}) {
  return (
    <span className={styles.mark} style={{width: size, height: size}} aria-hidden="true" />
  );
}

export function SiteFooter() {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLElement>(null);

  const toggle = () => {
    setExpanded((open) => {
      if (!open) {
        setTimeout(() => root.current?.scrollIntoView({behavior: "smooth", block: "end"}), 300);
      }
      return !open;
    });
  };

  return (
    <footer className={`${styles.footer} ${expanded ? styles.open : ""}`} ref={root}>
      {expanded ? (
        <>
          <div className={styles.content}>
            <div className={styles.about}>
              <span className={styles.brand}>
                <Mark size={26} />
                Nokturn
              </span>
              <p className={styles.description}>
                Intent based settlement for tokenized equity on Robinhood Chain. One price for
                everyone in a batch, and a baseline you can recompute yourself from pool state.
              </p>
              <div className={styles.socials}>
                <a
                  className={styles.social}
                  href={REPO}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Nokturn on GitHub"
                >
                  <GithubIcon size={16} />
                </a>
              </div>
            </div>

            <div className={styles.groups}>
              {GROUPS.map((group) => (
                <div className={styles.group} key={group.title}>
                  <h4 className={styles.groupTitle}>{group.title}</h4>
                  <ul className={styles.list}>
                    {group.links.map((link) => (
                      <li key={link.href}>
                        {"external" in link && link.external ? (
                          <a href={link.href} target="_blank" rel="noreferrer">
                            {link.label}
                          </a>
                        ) : (
                          <Link href={link.href}>{link.label}</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.marquee} aria-hidden="true">
            <div className={styles.marqueeTrack}>
              <b>MOOOOOOOOOOOOOOOOOO</b>
              <b>MOOOOOOOOOOOOOOOOOO</b>
              <b>MOOOOOOOOOOOOOOOOOO</b>
              <b>MOOOOOOOOOOOOOOOOOO</b>
            </div>
          </div>
        </>
      ) : null}

      <div className={styles.bottom}>
        <p className={styles.bottomText}>
          <Mark size={16} />
          Nokturn - {new Date().getFullYear()}
        </p>
        <div className={styles.bottomRight}>
          <span className={styles.hint}>{expanded ? "Less" : "See our resources"}</span>
          <button
            type="button"
            className={styles.toggle}
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse the footer" : "Expand the footer"}
          >
            <ArrowCircleIcon size={24} />
          </button>
        </div>
      </div>
    </footer>
  );
}
