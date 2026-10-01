const GROUPED = new Intl.NumberFormat("en-US", {maximumFractionDigits: 0});

export function units(value: bigint, decimals: number, places: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const rest = value % base;
  if (places === 0) return GROUPED.format(whole);
  const scaled = (rest * 10n ** BigInt(places)) / base;
  return `${GROUPED.format(whole)}.${scaled.toString().padStart(places, "0")}`;
}

export function compactSupply(value: bigint, decimals: number): string {
  const whole = value / 10n ** BigInt(decimals);
  const steps: Array<[bigint, string]> = [
    [1_000_000_000_000n, " trillion"],
    [1_000_000_000n, " billion"],
    [1_000_000n, " million"],
    [1_000n, " thousand"],
  ];
  for (const [size, label] of steps) {
    if (whole >= size) {
      const tenths = (whole * 10n) / size;
      return `${Number(tenths) / 10}${label}`;
    }
  }
  return GROUPED.format(whole);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function bytesLabel(count: number): string {
  return `${GROUPED.format(count)} byte${count === 1 ? "" : "s"}`;
}

/// CLOSED_WEEKEND, as the coordinator names a session, read as Closed weekend.
export function sessionLabel(name: string): string {
  const words = name.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
