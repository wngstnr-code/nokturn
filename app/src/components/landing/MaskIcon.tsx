import type {CSSProperties} from "react";

// The icons are drawn in currentColor. A mask keeps that behaviour without an SVG loader.
export function MaskIcon({
  src,
  label,
  className,
  style,
}: {
  src: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
      style={{
        display: "inline-block",
        backgroundColor: "currentColor",
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskSize: "contain",
        WebkitMaskSize: "contain",
        ...style,
      }}
    />
  );
}
