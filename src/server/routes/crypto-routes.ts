import { randomBytes } from 'node:crypto';
import { readJsonBody } from '../body.ts';
import { json, Router } from '../router.ts';
import { utf8Decode, utf8Encode } from '../../core/bytes.ts';
import { decodeBpc, encodeBpc } from '../../crypto/bpc/bpc-engine.ts';
import { deriveDocumentKey } from '../../crypto/document-key.ts';
import type { AppContext } from '../app-context.ts';
import type { CipherTrace } from '../../crypto/engine.ts';

const WORKBENCH_RECORD_ID = 'workbench';
const IV_LENGTH = 16;

function publishTrace(app: AppContext, trace: CipherTrace | undefined): void {
  if (!trace) return;
  for (const step of trace.steps) app.hub.publish('telemetry', step);
}

/** Drives the visualizer/workbench (spec Sections 5 and 8): an ad-hoc,
 *  never-persisted encode/decode against the current session's master
 *  key, using a fixed workbench record id (there's no real document
 *  behind this — it's purely a "try it and watch it happen" demo).
 *  Every trace step is also published to the WS telemetry topic so any
 *  connected client can watch it live, in addition to the full trace
 *  returned synchronously here for the initiating client's own
 *  tick-rate-controlled playback. */
export function registerCryptoRoutes(router: Router, app: AppContext): void {
  router.add(
    'POST',
    '/api/crypto/encode',
    async (ctx) => {
      const body = await readJsonBody<{ text?: string }>(ctx.raw);
      if (!body.text) return json(400, { error: 'text is required' });

      const documentKey = deriveDocumentKey({ masterKey: ctx.session!.masterKey, recordId: WORKBENCH_RECORD_ID });
      const iv = new Uint8Array(randomBytes(IV_LENGTH));
      const { ciphertext, trace } = encodeBpc(utf8Encode(body.text), documentKey, iv, true);
      publishTrace(app, trace);

      return json(200, {
        ciphertext: Buffer.from(ciphertext).toString('base64'),
        iv: Buffer.from(iv).toString('hex'),
        trace,
      });
    },
    { auth: true }
  );

  router.add(
    'POST',
    '/api/crypto/decode',
    async (ctx) => {
      const body = await readJsonBody<{ ciphertext?: string; iv?: string }>(ctx.raw);
      if (!body.ciphertext || !body.iv) return json(400, { error: 'ciphertext and iv are required' });

      const documentKey = deriveDocumentKey({ masterKey: ctx.session!.masterKey, recordId: WORKBENCH_RECORD_ID });
      const iv = new Uint8Array(Buffer.from(body.iv, 'hex'));
      const ciphertext = new Uint8Array(Buffer.from(body.ciphertext, 'base64'));

      try {
        const { plaintext, trace } = decodeBpc(ciphertext, documentKey, iv, true);
        publishTrace(app, trace);
        return json(200, { text: utf8Decode(plaintext), trace });
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : 'decode failed' });
      }
    },
    { auth: true }
  );
}
