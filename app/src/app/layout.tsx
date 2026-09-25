import type {Metadata} from "next";
import {Inter} from "next/font/google";
import {SiteFooter} from "@/components/SiteFooter";
import {SiteHeader} from "@/components/SiteHeader";
import {WalletProvider} from "@/components/WalletProvider";
import shell from "@/components/AppShell.module.css";
import type {SessionSnapshot} from "@/components/SessionClock";
import {readSession, SESSION_NAMES} from "@/lib/session";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import "./globals.css";

const body = Inter({subsets: ["latin"], variable: "--font-body", display: "swap"});

export const metadata: Metadata = {
  title: "Nokturn",
  description:
    "Intent based settlement for tokenized equities on Robinhood Chain. Every number on screen carries the block it was read at.",
};

async function headerSnapshot(): Promise<SessionSnapshot> {
  try {
    const report = await readSession(CHAIN_ID_TESTNET, []);
    return {
      session: report.session,
      name: SESSION_NAMES[report.session],
      nextTransition: Number(report.nextTransition),
      readAt: Number(report.blockTimestamp),
      chainId: report.chainId,
    };
  } catch {
    return null;
  }
}

export default async function RootLayout({children}: {children: React.ReactNode}) {
  const snapshot = await headerSnapshot();

  return (
    <html lang="en" className={body.variable}>
      <body>
        <WalletProvider>
          <div className={shell.app}>
            <SiteHeader snapshot={snapshot} />
            <div className={shell.body}>
              <main className={shell.main}>{children}</main>
            </div>
            <div className={shell.footerSlot}>
              <SiteFooter />
            </div>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
