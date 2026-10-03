"use client";

import Link from "next/link";
import {useRef, useState} from "react";
import {ArrowCircleIcon, GithubIcon} from "./Icons";
import {Icon3DCopy} from "./landing/Icon3D";
import {MaskIcon} from "./landing/MaskIcon";
import {BRAND, FOOTER} from "./landing/content";
import {chainFor} from "@/lib/chain";
import type {Network} from "@/lib/network";
import styles from "./SiteFooter.module.css";

const REPO = "https://github.com/wngstnr-code/nokturn";
const DUNE =
  "https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026";
const CHAIN_DOCS = "https://docs.chain.robinhood.com";

// The two wing colours in flying-owl.svg, the same pair the landing footer flies.
const OWL_WINGS = ["#a2bcff", "#f8faff"];

/* The explorer follows the chain the app is reading, so it is filled in per render. */
const groups = (explorer: string, testnet: boolean) => [
  {
    title: "Protocol",
    links: [
      {href: "/trade", label: "Trade"},
      {href: "/batch", label: "Batches"},
      {href: "/auction", label: "Auctions"},
      {href: "/session", label: "Session"},
      {href: "/allowlist", label: "Allowlist"},
      ...(testnet ? [] : [{href: "/netting", label: "Netting"}]),
    ],
  },
  {
    title: "Check the numbers",
    links: [
      {href: DUNE, label: "Dune dashboard", external: true},
      {href: explorer, label: "Block explorer", external: true},
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

export function SiteFooter({network}: {network: Network}) {
  const linkGroups = groups(chainFor(network.chainId).blockExplorers.default.url, network.kind === "testnet");
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
                <MaskIcon src={BRAND.mark} style={{width: 26, height: 26}} />
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
              {linkGroups.map((group) => (
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

          <div className={styles.marquee} aria-hidden="true" data-icon3d-watch>
            <div className={styles.marqueeTrack}>
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className={styles.marqueeSegment}>
                  <b>{FOOTER.marquee.text}</b>
                  <Icon3DCopy src={FOOTER.marquee.image} wings={OWL_WINGS} className={styles.owl} />
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <div className={styles.bottom}>
        <p className={styles.bottomText}>
          <MaskIcon src={BRAND.mark} style={{width: 18, height: 18}} />
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
