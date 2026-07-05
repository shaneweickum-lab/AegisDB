import { readJsonBody } from '../body.ts';
import { json, Router } from '../router.ts';
import type { AppContext } from '../app-context.ts';

/** Generic REST surface over DocumentStore's collections — this is the
 *  real external contract (docs/API.md) a separate consumer project is
 *  meant to build against, per spec 1.1's Layer 3 boundary. */
export function registerDocumentRoutes(router: Router, app: AppContext): void {
  router.add(
    'POST',
    '/api/collections/:collection/documents',
    async (ctx) => {
      const body = await readJsonBody<{ data?: unknown }>(ctx.raw);
      if (body.data === undefined) return json(400, { error: 'data is required' });
      const record = await app.getStore().insert(ctx.params.collection!, body.data);
      return json(201, record);
    },
    { auth: true }
  );

  router.add(
    'GET',
    '/api/collections/:collection/documents',
    async (ctx) => {
      const records = await app.getStore().query(ctx.params.collection!);
      return json(200, records);
    },
    { auth: true }
  );

  router.add(
    'GET',
    '/api/collections/:collection/documents/:id',
    async (ctx) => {
      const record = await app.getStore().get(ctx.params.collection!, ctx.params.id!);
      if (!record) return json(404, { error: 'not found' });
      return json(200, record);
    },
    { auth: true }
  );

  router.add(
    'PUT',
    '/api/collections/:collection/documents/:id',
    async (ctx) => {
      const body = await readJsonBody<{ data?: unknown }>(ctx.raw);
      if (body.data === undefined) return json(400, { error: 'data is required' });
      try {
        const record = await app.getStore().update(ctx.params.collection!, ctx.params.id!, body.data);
        return json(200, record);
      } catch {
        return json(404, { error: 'not found' });
      }
    },
    { auth: true }
  );

  router.add(
    'DELETE',
    '/api/collections/:collection/documents/:id',
    async (ctx) => {
      const ok = await app.getStore().delete(ctx.params.collection!, ctx.params.id!);
      return json(200, { ok });
    },
    { auth: true }
  );

  router.add(
    'POST',
    '/api/admin/compact',
    async () => {
      const report = await app.getStore().compact();
      return json(200, report);
    },
    { auth: true }
  );
}
