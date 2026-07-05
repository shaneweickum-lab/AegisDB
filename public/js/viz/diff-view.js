import { colorForBand } from './colors.js';

// Raw<->Cipher Diff View (spec 5.2): source text colored by the band that
// produced each output symbol, with the resulting 2-byte cipher value
// shown beneath each character.
export function drawDiffView(canvas, steps, currentIndex) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (steps.length === 0) return;

  const cellWidth = Math.max(10, Math.min(20, (width - 16) / steps.length));
  const rowHeight = 26;

  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= currentIndex && i < steps.length; i++) {
    const step = steps[i];
    const x = 8 + i * cellWidth;
    const color = colorForBand(step.band);

    ctx.fillStyle = color;
    ctx.fillRect(x, 8, cellWidth - 1, rowHeight - 2);
    ctx.fillStyle = '#111';
    const ch = step.byte >= 33 && step.byte < 127 ? String.fromCharCode(step.byte) : '·';
    ctx.fillText(ch, x + cellWidth / 2, 8 + rowHeight / 2);

    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, 8 + rowHeight, cellWidth - 1, rowHeight - 2);
    ctx.fillStyle = color;
    const hex = ((step.outHigh << 8) | step.outLow).toString(16).padStart(4, '0');
    ctx.font = '9px monospace';
    ctx.fillText(hex, x + cellWidth / 2, 8 + rowHeight + rowHeight / 2);
    ctx.font = '11px monospace';
  }

  if (currentIndex >= 0 && currentIndex < steps.length) {
    const x = 8 + currentIndex * cellWidth;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, 7, cellWidth - 2, rowHeight * 2 - 2);
  }
}
