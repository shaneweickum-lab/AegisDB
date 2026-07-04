// Deterministic per-band color so the same band always renders the same
// hue across every panel — a prime-ish multiplier spreads hues around the
// wheel without needing a curated palette for up to BAND_MAX+1 bands.
export function colorForBand(band) {
  const hue = (band * 47) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export function colorForBandDim(band) {
  const hue = (band * 47) % 360;
  return `hsl(${hue}, 40%, 30%)`;
}
