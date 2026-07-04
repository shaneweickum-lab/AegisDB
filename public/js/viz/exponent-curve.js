import { colorForBand } from './colors.js';

// Band/Drift Curve panel (spec 5.2's "Exponent Curve Panel"): plots each
// step's band as playback advances, current point marked — this is the
// bounded, integer replacement for the original spec's unbounded
// floating-point exponent curve (see docs/CIPHER.md for why).
export function drawExponentCurve(canvas, steps, currentIndex) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (steps.length === 0) return;

  const padding = 20;
  const maxBand = Math.max(1, ...steps.map((s) => s.band));
  const xStep = steps.length > 1 ? (width - padding * 2) / (steps.length - 1) : 0;
  const yFor = (band) => height - padding - (band / maxBand) * (height - padding * 2);

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  steps.forEach((step, i) => {
    const x = padding + i * xStep;
    const y = yFor(step.band);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  for (let i = 0; i <= currentIndex && i < steps.length; i++) {
    const x = padding + i * xStep;
    const y = yFor(steps[i].band);
    ctx.fillStyle = colorForBand(steps[i].band);
    ctx.beginPath();
    ctx.arc(x, y, i === currentIndex ? 5 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
}
