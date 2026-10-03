import type {Metadata} from "next";
import {Plus_Jakarta_Sans} from "next/font/google";
import {SITE_HOST} from "@/lib/hosts";
import "./globals.css";

// brand.md sets one family for headings and text, the same one the landing page wears.
const body = Plus_Jakarta_Sans({subsets: ["latin"], variable: "--font-body", display: "swap"});

const TESTNET = SITE_HOST.startsWith("testnet.");

const TITLE = "Nokturn · Tokenized stocks, settled around the clock";

// The same sentence a link preview, a search result and a crawler read. The testnet
// deployment says so up front, because its tokens are test tokens.
const DESCRIPTION = TESTNET
  ? "Nokturn on Robinhood Chain testnet, with test tokens. Sign an intent, watch it settle in a batch, and read a receipt with the Uniswap V3 baseline next to every fill."
  : "Intent based batch settlement for tokenized equities on Robinhood Chain. Batches sized to the market session, one clearing price, and the venue baseline published next to every fill.";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${SITE_HOST}`),
  title: {
    default: TITLE,
    template: "%s · Nokturn",
  },
  description: DESCRIPTION,
  applicationName: "Nokturn",
  keywords: ["Nokturn", "Robinhood Chain", "Arbitrum", "tokenized equities", "stock tokens", "batch settlement", "intents", "Uniswap V3"],
  openGraph: {
    type: "website",
    siteName: "Nokturn",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    images: ["/apple-icon.png"],
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/apple-icon.png"],
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={body.variable}>
      <body>{children}</body>
    </html>
  );
}
