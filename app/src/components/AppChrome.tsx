import {SiteFooter} from "@/components/SiteFooter";
import {SiteHeader} from "@/components/SiteHeader";
import {WalletProvider} from "@/components/WalletProvider";
import shell from "@/components/AppShell.module.css";
import type {SessionSnapshot} from "@/components/SessionClock";
import {readSession, SESSION_NAMES} from "@/lib/session";
import {CHAIN_ID_TESTNET} from "@shared/addresses";

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

export async function AppChrome({children}: {children: React.ReactNode}) {
  const snapshot = await headerSnapshot();

  return (
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
  );
}
