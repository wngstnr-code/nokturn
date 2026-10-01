type IconProps = {size?: number; className?: string};

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export function WalletIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 8a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
      <path d="M3 8v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z" />
      <path d="M16 13h.01" />
    </svg>
  );
}

export function GlobeIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
    </svg>
  );
}

export function WarningIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function CopyIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function ExternalIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

export function PowerIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v9" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </svg>
  );
}

export function CloseIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function CheckIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function BoltIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}

export function MoonIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export function ShieldIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 21s7-3.4 7-9V5.5l-7-2.5-7 2.5V12c0 5.6 7 9 7 9Z" />
      <path d="M12 9v3.5" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function OfflineIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  );
}

export function GithubIcon({size = 16, className}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.4 5.2 18.4 5.5 18.4 5.5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

/** Points right when closed, swung up when the footer is open. */
export function ArrowCircleIcon({size = 24, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 12h6" />
      <path d="m12.5 9 3 3-3 3" />
    </svg>
  );
}

export function ChevronIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function InfoIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

export function LayersIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

export function BellIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function ClockIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function UsersIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </svg>
  );
}

/** Two flows meeting, which is what netting is. */
export function NettingIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 8h13" />
      <path d="m13 5 3 3-3 3" />
      <path d="M21 16H8" />
      <path d="m11 13-3 3 3 3" />
    </svg>
  );
}

export function CoinsIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <ellipse cx="9" cy="8" rx="6" ry="3" />
      <path d="M3 8v4c0 1.7 2.7 3 6 3" />
      <ellipse cx="15" cy="15" rx="6" ry="3" />
      <path d="M9 15v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-3" />
    </svg>
  );
}

/** A band with a mark inside it, for how far a price may sit from the reference. */
export function BandIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 6h18" />
      <path d="M3 18h18" />
      <path d="M12 9v6" />
      <path d="m9.5 11.5 2.5-2.5 2.5 2.5" />
      <path d="m9.5 12.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

export function BlockIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </svg>
  );
}

export function SunIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </svg>
  );
}

export function CrossIcon({size = 16, className}: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </svg>
  );
}
