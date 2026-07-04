import { connectTelemetry } from './viz/ws-client.js';
import { drawHistogram } from './viz/histogram.js';
import { drawExponentCurve } from './viz/exponent-curve.js';
import { drawDiffView } from './viz/diff-view.js';
import { TracePlayer } from './viz/trace-player.js';

let sessionToken = null;
let currentTrace = null;
let liveIndicatorTimer = null;

const player = new TracePlayer({ onTick: render });

const els = {
  unlockForm: document.getElementById('unlock-form'),
  passphrase: document.getElementById('passphrase'),
  sessionStatus: document.getElementById('session-status'),
  workbench: document.getElementById('workbench'),
  inputText: document.getElementById('input-text'),
  outputText: document.getElementById('output-text'),
  ivInput: document.getElementById('iv-input'),
  ivDisplay: document.getElementById('iv-display'),
  encryptBtn: document.getElementById('encrypt-btn'),
  decryptBtn: document.getElementById('decrypt-btn'),
  playBtn: document.getElementById('play-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  stepBtn: document.getElementById('step-btn'),
  tickRate: document.getElementById('tick-rate'),
  tickRateLabel: document.getElementById('tick-rate-label'),
  positionLabel: document.getElementById('position-label'),
  liveIndicator: document.getElementById('live-indicator'),
  histogram: document.getElementById('histogram'),
  exponentCurve: document.getElementById('exponent-curve'),
  diffView: document.getElementById('diff-view'),
};

function render(index, total) {
  if (!currentTrace) return;
  const steps = currentTrace.steps;
  const counts = new Map();
  const bandByByte = new Map();
  for (let i = 0; i <= index; i++) {
    const step = steps[i];
    counts.set(step.byte, (counts.get(step.byte) ?? 0) + 1);
    bandByByte.set(step.byte, step.band);
  }
  drawHistogram(els.histogram, counts, bandByByte);
  drawExponentCurve(els.exponentCurve, steps, index);
  drawDiffView(els.diffView, steps, index);
  els.positionLabel.textContent = total > 0 ? `${index + 1} / ${total}` : '0 / 0';
}

async function api(path, body) {
  const res = await fetch(`${window.AEGIS_BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function flashLiveIndicator() {
  els.liveIndicator.classList.add('active');
  clearTimeout(liveIndicatorTimer);
  liveIndicatorTimer = setTimeout(() => els.liveIndicator.classList.remove('active'), 150);
}

els.unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/auth/unlock', { passphrase: els.passphrase.value });
    sessionToken = result.token;
    els.sessionStatus.textContent = 'unlocked';
    els.sessionStatus.classList.add('ok');
    els.workbench.hidden = false;
    connectTelemetry(sessionToken, () => flashLiveIndicator());
  } catch (err) {
    els.sessionStatus.textContent = `error: ${err.message}`;
    els.sessionStatus.classList.remove('ok');
  }
});

els.encryptBtn.addEventListener('click', async () => {
  try {
    const result = await api('/api/crypto/encode', { text: els.inputText.value });
    els.outputText.value = result.ciphertext;
    els.ivDisplay.textContent = result.iv;
    els.ivInput.value = result.iv;
    currentTrace = result.trace;
    player.load(currentTrace.steps);
  } catch (err) {
    els.outputText.value = `error: ${err.message}`;
  }
});

els.decryptBtn.addEventListener('click', async () => {
  try {
    const result = await api('/api/crypto/decode', {
      ciphertext: els.inputText.value,
      iv: els.ivInput.value,
    });
    els.outputText.value = result.text;
    currentTrace = result.trace;
    player.load(currentTrace.steps);
  } catch (err) {
    els.outputText.value = `error: ${err.message}`;
  }
});

els.playBtn.addEventListener('click', () => player.play());
els.pauseBtn.addEventListener('click', () => player.pause());
els.stepBtn.addEventListener('click', () => {
  player.pause();
  player.step();
});
els.tickRate.addEventListener('input', (event) => {
  const fps = Number(event.target.value);
  player.setFps(fps);
  els.tickRateLabel.textContent = `${fps} fps`;
});
