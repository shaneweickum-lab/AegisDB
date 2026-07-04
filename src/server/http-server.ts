import { createServer, type Server, type ServerResponse } from 'node:http';
import { extractBearerToken } from './auth/session.ts';
import { BodyTooLargeError } from './body.ts';
import { json, Router, type HttpResponse } from './router.ts';
import { serveStatic } from './static.ts';
import { NotUnlockedError, type AppContext } from './app-context.ts';
import { registerAuthRoutes } from './routes/auth-routes.ts';
import { registerDocumentRoutes } from './routes/docs-routes.ts';

export interface CreateServerOptions {
  app: AppContext;
  staticDir?: string;
}

function sendResponse(res: ServerResponse, response: HttpResponse): void {
  const headers = { ...response.headers };
  if (typeof response.body === 'string' && !headers['content-type']) {
    headers['content-type'] = 'text/plain; charset=utf-8';
  }
  res.writeHead(response.status, headers);
  res.end(response.body ?? undefined);
}

function errorToResponse(err: unknown): HttpResponse {
  if (err instanceof NotUnlockedError) return json(401, { error: err.message });
  if (err instanceof BodyTooLargeError) return json(413, { error: err.message });
  if (err instanceof SyntaxError) return json(400, { error: err.message });
  const message = err instanceof Error ? err.message : 'internal error';
  return json(500, { error: message });
}

export function buildRouter(app: AppContext): Router {
  const router = new Router();
  registerAuthRoutes(router, app);
  registerDocumentRoutes(router, app);
  return router;
}

/** Hand-rolled HTTP server (node:http, no framework). Phase 5 attaches a
 *  WebSocket handshake listener to this same server's 'upgrade' event —
 *  this function only wires the plain-HTTP request path. */
export function createHttpServer(options: CreateServerOptions): Server {
  const router = buildRouter(options.app);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const match = router.match(method, url.pathname);

      if (match) {
        const token = extractBearerToken(req.headers.authorization);
        const session = token ? options.app.sessions.resolve(token) : null;
        if (match.requireAuth && !session) {
          sendResponse(res, json(401, { error: 'unauthorized' }));
          return;
        }

        const response = await match.handler({
          method,
          pathname: url.pathname,
          params: match.params,
          query: url.searchParams,
          headers: req.headers,
          raw: req,
          session,
          sessionToken: token,
        });
        sendResponse(res, response);
        return;
      }

      if (options.staticDir && (await serveStatic(options.staticDir, url.pathname, req, res))) {
        return;
      }

      sendResponse(res, json(404, { error: 'not found' }));
    } catch (err) {
      sendResponse(res, errorToResponse(err));
    }
  });
}
