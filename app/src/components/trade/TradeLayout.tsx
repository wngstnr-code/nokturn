"use client";

import type {ReactNode} from "react";
import {useIntents} from "./IntentsProvider";
import styles from "./TradeLayout.module.css";

/*
 * The second column only exists once there is something in it. An empty panel
 * beside the widget is the largest thing on a first visit and says nothing, and
 * the reference hides its orders table on this screen for the same reason.
 *
 * The widget moves left when the first intent lands, which is after the
 * coordinator accepts rather than on the click. That movement is the signal
 * that it went through.
 */
export function TradeLayout({widget, intents}: {widget: ReactNode; intents: ReactNode}) {
  const {sent} = useIntents();
  const split = sent.length > 0;

  return (
    <div className={`${styles.page} ${split ? styles.split : styles.solo}`}>
      <div className={styles.primary}>{widget}</div>
      {split ? <div className={styles.secondary}>{intents}</div> : null}
    </div>
  );
}
