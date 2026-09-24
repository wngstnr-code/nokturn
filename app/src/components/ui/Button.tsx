import type {ButtonHTMLAttributes, ReactNode} from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  compact?: boolean;
  children: ReactNode;
}

export function Button({variant = "primary", compact = false, className, children, ...rest}: ButtonProps) {
  const classes = [styles.base, styles[variant], compact ? styles.compact : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
