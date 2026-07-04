import { colorForBand } from './colors.js';

// Frequency Histogram panel (spec 5.2): live per-symbol counts, colored
// by whichever band most recently produced that symbol's output — this is
// the panel that's meant to visually demonstrate the flattening effect
// the frequency-band drift is supposed to have (see docs/CIPHER.md).
export function drawHistogram(canvas, counts, bandByByte) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return;

  const padding = 20;
  const maxCount = Math.max(...entries.map(([, c]) => c));
  const barWidth = Math.max(3, (width - padding * 2) / entries.length - 2);

  ctx.font = '10px monospace';
  ctx.textAlign = 'center';

  entries.forEach(([byte, count], i) => {
    const x = padding + i * (barWidth + 2);
    const barHeight = ((height - padding * 2) * count) / maxCount;
    const y = height - padding - barHeight;
    ctx.fillStyle = colorForBand(bandByByte.get(byte) ?? 0);
    ctx.fillRect(x, y, barWidth, barHeight);

    const label = byte >= 33 && byte < 127 ? String.fromCharCode(byte) : '·';
    ctx.fillStyle = '#888';
    ctx.fillText(label, x + barWidth / 2, height - padding + 12);
  });
}
