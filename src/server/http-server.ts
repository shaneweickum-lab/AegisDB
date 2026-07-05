import { createServer, type Server, type ServerResponse } from 'node:http';
import { extractBearerToken } from './auth/session.ts';
import { BodyTooLargeError } from './body.ts';
import { json, Router, type HttpResponse } from './router.ts';
import { serveStatic } from './static.ts';
import { NotUnlockedError, type AppContext } from './app-context.ts';
import { registerAuthRoutes } from './routes/auth-routes.ts';
import { registerDocumentRoutes } from './routes/docs-routes.ts';
import { registerCryptoRoutes } from './routes/crypto-routes.ts';
import { registerIngestRoutes } from './routes/ingest-routes.ts';
import { performHandshake, rejectUpgrade } from './ws/handshake.ts';
import { WsConnection } from './ws/connection.ts';

export interface CreateServerOptions {
  app: AppContext;
  staticDir?: string;
}

const TELEMETRY_WS_PATH = '/api/telemetry/state';
const WS_PING_INTERVAL_MS = 30_000;

/** The frontend is deliberately deployed separately from this server
 *  (docs/DEPLOYMENT.md's split-hosting model — a static Vercel-hosted
 *  page pointed at whichever backend is actually running), so every
 *  response needs CORS headers or the browser blocks it outright before
 *  the frontend ever sees a useful error. `*` is safe here specifically
 *  because auth is a bearer token in a custom header, not a cookie —
 *  this is never a "credentialed" CORS request. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-file-name',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function sendResponse(res: ServerResponse, response: HttpResponse): void {
  const headers: Record<string, string> = { ...CORS_HEADERS, ...response.headers };
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
  registerCryptoRoutes(router, app);
  registerIngestRoutes(router, app);
  return router;
}

/** Hand-rolled HTTP server (node:http, no framework) with the WebSocket
 *  telemetry endpoint (attachWebSocketServer, below) wired onto the same
 *  server's 'upgrade' event — one process, one port, two protocols. */
export function createHttpServer(options: CreateServerOptions): Server {
  const router = buildRouter(options.app);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      // CORS preflight: browsers send this before the real cross-origin
      // request and never attach Authorization to it, so it must be
      // answered before any auth/routing check — and with a bare 204,
      // not routed through sendResponse's JSON-body assumptions.
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

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

  attachWebSocketServer(server, options.app);
  return server;
}

/** Wires the WebSocket telemetry endpoint onto `server`'s 'upgrade' event.
 *  Kept as a separate step from createHttpServer so tests can create a
 *  server without WS wiring if they don't need it, though in practice
 *  callers always want both. Browsers' WebSocket constructor can't set
 *  custom headers, so auth here is a `?token=` query param rather than
 *  the Bearer header the plain REST routes use. */
export function attachWebSocketServer(server: Server, app: AppContext): void {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== TELEMETRY_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const token = url.searchParams.get('token');
    const session = token ? app.sessions.resolve(token) : null;
    if (!session) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    if (!performHandshake(req, socket)) return;
    const connection = new WsConnection(socket, { pingIntervalMs: WS_PING_INTERVAL_MS });
    app.hub.subscribe('telemetry', connection);
  });
}
