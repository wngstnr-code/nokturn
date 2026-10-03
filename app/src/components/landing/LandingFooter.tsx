"use client";

import Link from "next/link";
import {useRef, useState} from "react";
import {BRAND, FOOTER} from "./content";
import {Icon3DCopy} from "./Icon3D";
import {MaskIcon} from "./MaskIcon";
import styles from "./LandingFooter.module.css";

// The two wing colours in flying-owl.svg, back and front.
const OWL_WINGS = ["#a2bcff", "#f8faff"];

export function LandingFooter() {
  const [expanded, setExpanded] = useState(true);
  const ref = useRef<HTMLElement>(null);

  const toggle = () => {
    setExpanded((state) => {
      if (!state) {
        // Waits for the expanded content to lay out before scrolling to its end.
        setTimeout(() => ref.current?.scrollIntoView({behavior: "smooth", block: "end"}), 300);
      }
      return !state;
    });
  };

  return (
    <footer ref={ref} className={`${styles.footer} ${expanded ? styles.expanded : ""}`}>
      {expanded && (
        <>
          <div className={styles.content}>
            <div className={styles.description}>
              <MaskIcon
                src={BRAND.mark}
                label={BRAND.name}
                className={styles.logo}
                style={{height: 48, width: 48}}
              />
              <p className={styles.text}>{FOOTER.description}</p>
              <div className={styles.social}>
                {FOOTER.social.map((item) => (
                  <a key={item.label} className={styles.socialLink} href={item.href} target="_blank" rel="noopener noreferrer">
                    <MaskIcon src={item.icon} label={item.label} style={{width: "100%", height: "100%"}} />
                  </a>
                ))}
              </div>
            </div>

            <div className={styles.groups}>
              {FOOTER.groups.map((group) => (
                <div key={group.label} className={styles.group}>
                  <h4 className={styles.groupTitle}>{group.label}</h4>
                  <ul className={styles.list}>
                    {group.children.map((child) => (
                      <li key={child.label}>
                        {child.external ? (
                          <a className={styles.link} href={child.href} target="_blank" rel="noopener noreferrer">
                            {child.label}
                          </a>
                        ) : (
                          <Link className={styles.link} href={child.href}>
                            {child.label}
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.marquee} aria-hidden="true" data-icon3d-watch>
            <div className={styles.track}>
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className={styles.segment}>
                  <b>{FOOTER.marquee.text}</b>
                  <Icon3DCopy src={FOOTER.marquee.image} wings={OWL_WINGS} className={styles.owl} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className={styles.bottom}>
        <p className={styles.copyright}>
          &copy; {FOOTER.copyright} - {new Date().getFullYear()}
        </p>
        <div className={styles.products}>
          <Link className={styles.product} href="/" aria-label={`${BRAND.name} home`}>
            <MaskIcon src={BRAND.mark} style={{height: 26, width: 26}} />
            <span className={styles.productName}>{BRAND.name}</span>
          </Link>
        </div>
        <button
          type="button"
          className={`${styles.toggle} ${expanded ? styles.toggleExpanded : ""}`}
          onClick={toggle}
          aria-label="Toggle footer"
          aria-expanded={expanded}
        >
          <MaskIcon src={FOOTER.toggleIcon} style={{width: "100%", height: "100%"}} />
        </button>
      </div>
    </footer>
  );
}
