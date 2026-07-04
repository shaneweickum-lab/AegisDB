import { createServer, type Server, type ServerResponse } from 'node:http';
import { extractBearerToken } from './auth/session.ts';
import { BodyTooLargeError } from './body.ts';
import { json, Router, type HttpResponse } from './router.ts';
import { serveStatic } from './static.ts';
import { NotUnlockedError, type AppContext } from './app-context.ts';
import { registerAuthRoutes } from './routes/auth-routes.ts';
import { registerDocumentRoutes } from './routes/docs-routes.ts';
import { registerCryptoRoutes } from './routes/crypto-routes.ts';
import { performHandshake, rejectUpgrade } from './ws/handshake.ts';
import { WsConnection } from './ws/connection.ts';

export interface CreateServerOptions {
  app: AppContext;
  staticDir?: string;
}

const TELEMETRY_WS_PATH = '/api/telemetry/state';
const WS_PING_INTERVAL_MS = 30_000;

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
  registerCryptoRoutes(router, app);
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
