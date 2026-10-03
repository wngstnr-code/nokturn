import {JetBrains_Mono, Plus_Jakarta_Sans} from "next/font/google";
import {LandingFooter} from "@/components/landing/LandingFooter";
import {LandingHeader} from "@/components/landing/LandingHeader";
import {SmoothScroll} from "@/components/landing/SmoothScroll";
import styles from "./landing.module.css";

const sans = Plus_Jakarta_Sans({subsets: ["latin"], variable: "--font-landing-sans", display: "swap"});
const mono = JetBrains_Mono({subsets: ["latin"], variable: "--font-landing-mono", display: "swap"});

export default function LandingLayout({children}: {children: React.ReactNode}) {
  return (
    <div className={`${styles.root} ${sans.variable} ${mono.variable}`}>
      <SmoothScroll />
      <LandingHeader />
      <div className={styles.wrapper}>{children}</div>
      <LandingFooter />
    </div>
  );
}
