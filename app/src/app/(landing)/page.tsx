import {GOVERNANCE, GRANTS, HERO, INNOVATION, PRODUCTS} from "@/components/landing/content";
import {HeroRain} from "@/components/landing/HeroRain";
import {Icon3D} from "@/components/landing/Icon3D";
import styles from "./landing.module.css";

const TAG = {mint: styles.tagMint, night: styles.tagNight, amber: styles.tagAmber};

function External({
  href,
  className,
  style,
  children,
}: {
  href: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <a href={href} className={className} style={style} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <HeroRain />
        <div className={styles.heroContent}>
          <h1 className={styles.heroTitle}>{HERO.title}</h1>
        </div>
      </section>

      <section className={`${styles.card} ${styles.cardWhite}`}>
        <div className={styles.cardSection}>
          <div className={`${styles.titleWrapper} ${styles.productsTitle}`}>
            <h2 className={`${styles.titleText} ${styles.productsLead}`}>
              {PRODUCTS.lead.map((part, index) =>
                part.tag ? (
                  <span key={index} className={`${styles.tag} ${TAG[part.tag]}`}>
                    {part.text}
                  </span>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </h2>
          </div>

          <div className={`${styles.topicList} ${styles.columns2}`}>
            {PRODUCTS.cards.map((card) => (
              <div key={card.title} className={`${styles.topicCard} ${styles.productCard} ${styles[card.variant]}`}>
                <div className={styles.topicCardInner}>
                  <h3 className={styles.productTitle}>{card.title}</h3>
                  <p className={styles.productDescription}>{card.description}</p>
                  <External href={card.href} className={styles.topicButton}>
                    {card.linkText}
                  </External>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.productImage} src={card.image} alt={card.title} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={`${styles.card} ${styles.cardTransparent}`}>
        <div className={styles.cardSection}>
          <div className={`${styles.titleWrapper} ${styles.narrow}`}>
            <Icon3D src={INNOVATION.icon} className={styles.titleIcon} style={{height: 126}} />
            <h2 className={styles.titleText}>{INNOVATION.title}</h2>
            <p className={`${styles.titleDescription} ${styles.muted30}`}>
              {INNOVATION.body[0]} <br />
              {INNOVATION.body[1]}
            </p>
            <External href={INNOVATION.cta.href} className={styles.sectionButton}>
              {INNOVATION.cta.text}
            </External>
          </div>
        </div>
      </section>

      <section className={`${styles.card} ${styles.cardDark}`}>
        <div className={styles.cardSection}>
          <div className={`${styles.titleWrapper} ${styles.narrow} ${styles.governanceTitle}`}>
            <Icon3D src={GOVERNANCE.icon} className={styles.titleIcon} style={{height: 90}} />
            <h2 className={styles.titleText}>{GOVERNANCE.title}</h2>
            <p className={`${styles.titleDescription} ${styles.muted60} ${styles.normal}`}>
              {GOVERNANCE.before}
              <External href={GOVERNANCE.link.href} className={styles.inlineLink}>
                {GOVERNANCE.link.text}
              </External>
              {GOVERNANCE.after}
            </p>
          </div>

          <div className={`${styles.topicList} ${styles.columns3}`}>
            {GOVERNANCE.channels.map((channel) => (
              <External
                key={channel.title}
                href={channel.href}
                className={`${styles.topicCard} ${styles.channelCard}`}
                style={{background: channel.bg, color: channel.fg}}
              >
                <Icon3D src={channel.image} colored className={styles.channelImage} />
                <span className={styles.channelTitle}>{channel.title}</span>
              </External>
            ))}
          </div>
        </div>
      </section>

      <section className={`${styles.card} ${styles.cardLight} ${styles.touchFooter}`}>
        <div className={styles.cardSection}>
          <div className={`${styles.titleWrapper} ${styles.narrow}`}>
            <Icon3D src={GRANTS.icon} className={styles.titleIcon} style={{height: 90}} />
            <h2 className={styles.titleText}>{GRANTS.title}</h2>
            <p className={`${styles.titleDescription} ${styles.muted30} ${styles.normal}`}>{GRANTS.body}</p>
            <External href={GRANTS.cta.href} className={styles.sectionButton}>
              {GRANTS.cta.text}
            </External>
          </div>
        </div>
      </section>
    </div>
  );
}
