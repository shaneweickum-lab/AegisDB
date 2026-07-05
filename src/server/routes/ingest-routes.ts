import { readRawBody } from '../body.ts';
import { json, Router } from '../router.ts';
import { ingestFile } from '../../ingest/pipeline.ts';
import type { AppContext } from '../app-context.ts';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB — comfortably over the .docx-relevant range

/** POST /api/ingest/file — no multipart/form-data parsing (that's a
 *  meaningfully large sub-project of its own; hand-rolling it wouldn't
 *  buy much for this project's scope). The filename travels in a header
 *  instead, and the raw file bytes are the entire request body. */
export function registerIngestRoutes(router: Router, app: AppContext): void {
  router.add(
    'POST',
    '/api/ingest/file',
    async (ctx) => {
      const fileName = ctx.headers['x-file-name'];
      if (!fileName || typeof fileName !== 'string') {
        return json(400, { error: 'x-file-name header is required' });
      }

      const fileBytes = await readRawBody(ctx.raw, MAX_UPLOAD_BYTES);
      let result;
      try {
        result = ingestFile(fileName, fileBytes);
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : 'extraction failed' });
      }

      const collection = ctx.query.get('collection');
      if (collection) {
        const record = await app.getStore().insert(collection, { text: result.extractedText, source: fileName });
        return json(201, { ...result, persisted: record });
      }

      return json(200, result);
    },
    { auth: true }
  );
}
