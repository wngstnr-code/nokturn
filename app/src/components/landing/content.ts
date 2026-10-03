// Ported from cowprotocol/cowswap apps/cow-fi (MIT, Copyright 2021 Gnosis Ltd).
// Layout and design follow cow.fi, used as a template. All copy and links here are Nokturn's.

import {appUrl} from "@/lib/hosts";

export const ASSET = (name: string) => `/landing/${name}`;

export type NavIcon = "trade" | "receipt" | "clock" | "shield" | "chart" | "data" | "contract" | "code" | "book" | "glossary" | "risk";

export type NavChild = {label: string; description: string; href: string; icon: NavIcon; external?: boolean};
export type NavItem = {label: string; children: NavChild[]};

export const BRAND = {
  name: "Nokturn",
  mark: ASSET("logo-nokturn-owl.svg"),
};

export const LAUNCH_CTA = {text: "Launch app", href: appUrl("/trade")};

const REPO = "https://github.com/wngstnr-code/nokturn";
const DUNE_DASHBOARD = "https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026";
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

// docs/runbook-deploy.md, Mainnet 4663.
export const SETTLEMENT_MAINNET = "0x92075BaA431Cb3A4CeaD3F6E676d26F6c0bCb934";
export const TIMELOCK_MAINNET = "0x578368Fff29f855A44f6535a07C75fb8dFF9b473";

// Every entry points at something that exists today. Nothing here is a placeholder.
export const NAV_ITEMS: NavItem[] = [
  {
    label: "Product",
    children: [
      {label: "Trade", description: "Sign an intent, one price for the whole batch", href: appUrl("/trade"), icon: "trade", external: true},
      {label: "Batches", description: "A receipt for every batch, failed ones included", href: appUrl("/batch"), icon: "receipt", external: true},
      {label: "Session", description: "The market session, read from the contract", href: appUrl("/session"), icon: "clock", external: true},
      {label: "Allowlist", description: "Why a real Stock Token passes and an impostor fails", href: appUrl("/allowlist"), icon: "shield", external: true},
      {label: "Netting backtest", description: "August 2026 trades replayed through batches", href: appUrl("/netting"), icon: "chart", external: true},
    ],
  },
  {
    label: "Verify",
    children: [
      {
        label: "Dune dashboard",
        description: "The market numbers, every query public",
        href: DUNE_DASHBOARD,
        icon: "data",
        external: true,
      },
      {
        label: "Contracts",
        description: "Settlement on Robinhood Chain mainnet",
        href: `${BLOCKSCOUT}/address/${SETTLEMENT_MAINNET}`,
        icon: "contract",
        external: true,
      },
      {label: "Source code", description: "Contracts, solver and app, all of it", href: REPO, icon: "code", external: true},
    ],
  },
  {
    label: "Learn",
    children: [
      {label: "Docs", description: "Design, parameters and decisions", href: `${REPO}/blob/main/docs/README.md`, icon: "book", external: true},
      {label: "Glossary", description: "What intent, batch and session mean here", href: `${REPO}/blob/main/docs/glosarium.md`, icon: "glossary", external: true},
      {
        label: "Threat model",
        description: "The risks that remain, listed openly",
        href: `${REPO}/blob/main/docs/threat-model.md`,
        icon: "risk",
        external: true,
      },
    ],
  },
];

export const HERO = {
  title: "The owl never sleeps.",
};

export const PRODUCTS = {
  lead: [
    {text: "Nokturn settles "},
    {text: "tokenized stocks", tag: "mint"},
    {text: " around the clock, even "},
    {text: "after the bell", tag: "night"},
    {text: ", and every trade comes with "},
    {text: "a receipt", tag: "amber"},
    {text: " you can check yourself"},
  ] as {text: string; tag?: "mint" | "night" | "amber"}[],
  cards: [
    {
      title: "Nokturn App",
      description: "One price for everyone in the batch",
      linkText: "Launch app",
      href: appUrl("/trade"),
      variant: "night",
      image: ASSET("image-batch.svg"),
    },
    {
      title: "Batch receipts",
      description: "Every fill beside its reference price, failures included",
      linkText: "See receipts",
      href: appUrl("/batch"),
      variant: "amber",
      image: ASSET("image-receipt.svg"),
    },
  ] as const,
};

export const INNOVATION = {
  icon: ASSET("icon-verify.svg"),
  iconHeight: 126,
  title: "Don't trust, verify",
  body: [
    "Every number Nokturn puts on screen carries the block it was read at, so nothing has to be taken on faith.",
    "Whether you're a trader, a builder or a skeptic, the market data behind it sits in public Dune queries you can rerun yourself.",
  ],
  cta: {text: "Open the dashboard", href: DUNE_DASHBOARD},
};

export const GOVERNANCE = {
  icon: ASSET("icon-open.svg"),
  iconHeight: 112,
  title: "Built in the open",
  before:
    "Nokturn's contracts are immutable, with no proxy and no key that can move user funds. Any parameter change waits 48 hours in a ",
  link: {text: "public timelock", href: `${BLOCKSCOUT}/address/${TIMELOCK_MAINNET}`},
  after: ", so anyone can read what is coming before it runs.",
  channels: [
    {
      title: "Contracts",
      href: `${BLOCKSCOUT}/address/${SETTLEMENT_MAINNET}`,
      bg: "var(--nk-amber)",
      fg: "var(--nk-ink-10)",
      image: ASSET("image-contracts.svg"),
    },
    {
      title: "Source code",
      href: REPO,
      bg: "var(--nk-mint)",
      fg: "var(--nk-ink-10)",
      image: ASSET("image-code.svg"),
    },
    {
      title: "Docs",
      href: `${REPO}/blob/main/docs/README.md`,
      bg: "var(--nk-peri-deep)",
      fg: "var(--nk-ink-98)",
      image: ASSET("image-docs.svg"),
    },
  ],
};

export const GRANTS = {
  icon: ASSET("icon-risk.svg"),
  iconHeight: 116,
  title: "Risks, listed openly",
  body: "Nokturn's code has not been audited by a third party yet, and the intent coordinator is still a single point of trust. Our threat model lists every risk that remains, with what limits it, so you can judge them yourself.",
  cta: {text: "Read the threat model", href: `${REPO}/blob/main/docs/threat-model.md`},
};

// A social entry without a real link is not shown.
const X_ACCOUNT: string | null = "https://x.com/nokturn_xyz";

export const FOOTER = {
  description:
    "Nokturn is an intent based settlement layer for tokenized stocks on Robinhood Chain, built so that every price it gives can be checked.",
  social: [
    {label: "X", href: X_ACCOUNT, icon: ASSET("icon-social-x.svg")},
    {label: "GitHub", href: REPO, icon: ASSET("icon-social-github.svg")},
  ].filter((item): item is {label: string; href: string; icon: string} => item.href !== null),
  groups: NAV_ITEMS.map((item) => ({
    label: item.label,
    children: item.children.map((child) => ({label: child.label, href: child.href, external: child.external ?? false})),
  })),
  marquee: {text: "HOOOOOOOOOOOOOOT", image: ASSET("flying-owl.svg")},
  copyright: "Nokturn",
  toggleIcon: ASSET("arrow-right-circular.svg"),
};
