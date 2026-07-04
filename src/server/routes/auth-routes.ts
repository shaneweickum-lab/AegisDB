import { readJsonBody } from '../body.ts';
import { json, Router } from '../router.ts';
import type { AppContext } from '../app-context.ts';

interface UnlockRequest {
  passphrase?: string;
  salt?: string; // hex-encoded, for re-deriving an existing profile's key
}

export function registerAuthRoutes(router: Router, app: AppContext): void {
  router.add('POST', '/api/auth/unlock', async (ctx) => {
    const body = await readJsonBody<UnlockRequest>(ctx.raw);
    if (!body.passphrase) return json(400, { error: 'passphrase is required' });

    const salt = body.salt ? new Uint8Array(Buffer.from(body.salt, 'hex')) : undefined;
    const { token, expiresAt, derived } = app.sessions.unlock(body.passphrase, salt);
    await app.unlockStore(derived.key);

    return json(200, { token, expiresAt, salt: Buffer.from(derived.salt).toString('hex') });
  });

  router.add(
    'POST',
    '/api/auth/lock',
    async (ctx) => {
      if (ctx.sessionToken) app.sessions.revoke(ctx.sessionToken);
      await app.lockStore();
      return json(200, { ok: true });
    },
    { auth: true }
  );
}
