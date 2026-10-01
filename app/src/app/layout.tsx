import type {Metadata} from "next";
import {Inter} from "next/font/google";
import "./globals.css";

const body = Inter({subsets: ["latin"], variable: "--font-body", display: "swap"});

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
