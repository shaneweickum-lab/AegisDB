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
  backendUrl: document.getElementById('backend-url'),
  workbench: document.getElementById('workbench'),
  inputText: document.getElementById('input-text'),
  outputText: document.getElementById('output-text'),
  fileInput: document.getElementById('file-input'),
  fileStatus: document.getElementById('file-status'),
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

els.backendUrl.textContent = window.AEGIS_BACKEND_URL;

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

// A raw fetch() rejection (TypeError, in every major browser) means the
// request never got a response at all — a network or CORS failure, not
// an application error. The default browser message ("Failed to fetch")
// gives no hint about *why*, which is exactly what turned a one-line CORS
// gap into a confusing dead end — so name the likely cause and point at
// the config that controls it instead of surfacing the raw browser text.
function describeError(err) {
  if (err instanceof TypeError) {
    return `could not reach backend at ${window.AEGIS_BACKEND_URL} — is it running and reachable? (see docs/DEPLOYMENT.md; append ?backend=<url> to point this page at a different one)`;
  }
  return err.message;
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

// Ingestion (spec 8.4) takes raw file bytes plus a filename header, not a
// JSON body — deliberately not multipart/form-data (see
// src/server/routes/ingest-routes.ts) — so this can't reuse api() above.
async function uploadFile(file) {
  const bytes = await file.arrayBuffer();
  const res = await fetch(`${window.AEGIS_BACKEND_URL}/api/ingest/file`, {
    method: 'POST',
    headers: {
      'x-file-name': file.name,
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: bytes,
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
    els.sessionStatus.textContent = `error: ${describeError(err)}`;
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
    els.outputText.value = `error: ${describeError(err)}`;
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
    els.outputText.value = `error: ${describeError(err)}`;
  }
});

els.fileInput.addEventListener('change', async () => {
  const file = els.fileInput.files[0];
  if (!file) return;

  els.fileStatus.textContent = `extracting "${file.name}"…`;
  els.fileStatus.classList.remove('error');
  try {
    const result = await uploadFile(file);
    els.inputText.value = result.extractedText;
    const warningNote = result.warnings.length > 0 ? ` (${result.warnings.join('; ')})` : '';
    els.fileStatus.textContent = `loaded via ${result.extractionMethod}: ${result.extractedText.length} chars${warningNote}`;
  } catch (err) {
    els.fileStatus.textContent = `error: ${describeError(err)}`;
    els.fileStatus.classList.add('error');
  } finally {
    els.fileInput.value = ''; // allow re-selecting the same file later
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
