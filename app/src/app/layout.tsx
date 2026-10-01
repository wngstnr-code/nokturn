import type {Metadata} from "next";
import {Plus_Jakarta_Sans} from "next/font/google";
import "./globals.css";

// brand.md sets one family for headings and text, the same one the landing page wears.
const body = Plus_Jakarta_Sans({subsets: ["latin"], variable: "--font-body", display: "swap"});

export const metadata: Metadata = {
  title: {
    default: "Nokturn · Tokenized stocks, settled around the clock",
    template: "%s · Nokturn",
  },
  description:
    "Intent based settlement for tokenized equities on Robinhood Chain. Every number on screen carries the block it was read at.",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={body.variable}>
      <body>{children}</body>
    </html>
  );
}
