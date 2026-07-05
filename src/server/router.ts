import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Session } from './auth/session.ts';

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
}

export interface RequestContext {
  method: string;
  pathname: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  raw: IncomingMessage;
  session: Session | null;
  sessionToken: string | null;
}

export type Handler = (ctx: RequestContext) => Promise<HttpResponse> | HttpResponse;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  requireAuth: boolean;
}

interface RouteMatch {
  handler: Handler;
  params: Record<string, string>;
  requireAuth: boolean;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

/** Minimal method+path-pattern router (no framework): patterns like
 *  `/api/collections/:collection/documents/:id` match by segment count
 *  and literal-vs-`:param` per segment. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: { auth?: boolean } = {}): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
      requireAuth: options.auth ?? false,
    });
  }

  match(method: string, pathname: string): RouteMatch | null {
    const requestSegments = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== requestSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSegment = route.segments[i]!;
        const requestSegment = requestSegments[i]!;
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
        } else if (routeSegment !== requestSegment) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params, requireAuth: route.requireAuth };
    }
    return null;
  }
}

export function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
