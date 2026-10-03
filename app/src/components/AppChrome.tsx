import {SiteFooter} from "@/components/SiteFooter";
import {SiteHeader} from "@/components/SiteHeader";
import {WalletProvider} from "@/components/WalletProvider";
import shell from "@/components/AppShell.module.css";
import type {SessionSnapshot} from "@/components/SessionClock";
import {session as servedSession} from "@/lib/coordinator/client";
import {activeNetwork, servedConfig} from "@/lib/network";
import {readSession, SESSION_NAMES} from "@/lib/session";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import type {Session} from "@shared/types";

/*
 * The header says which session the active chain is in. With a coordinator that is
 * the chain it serves, so the session comes from it too rather than from the
 * testnet this app would otherwise fall back to.
 */
async function headerSnapshot(served: boolean): Promise<SessionSnapshot> {
  if (served) {
    const result = await servedSession();
    if (!result.ok) return null;
    const session = result.value.session as Session;
    return {
      session,
      name: SESSION_NAMES[session],
      nextTransition: result.value.nextTransition,
      readAt: result.value.chainTime,
      chainId: result.value.provenance.chainId,
    };
  }

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
  const [served, network] = await Promise.all([servedConfig(), activeNetwork()]);
  const snapshot = await headerSnapshot(served !== null);

  return (
    <WalletProvider>
      <div className={shell.app}>
        <SiteHeader snapshot={snapshot} network={network} />
        <div className={shell.body}>
          <main className={shell.main}>{children}</main>
        </div>
        <div className={shell.footerSlot}>
          <SiteFooter network={network} />
        </div>
      </div>
    </WalletProvider>
  );
}
