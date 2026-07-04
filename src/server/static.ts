import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Resolves `requestPath` against `rootDir`, refusing anything that would
 *  escape it (`..`, absolute paths, symlink-adjacent tricks via
 *  normalize+resolve+prefix-check) — this is the one check every static
 *  file server needs and is trivial to get wrong by skipping it. */
function resolveSafePath(rootDir: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath);
  const withoutQuery = decoded.split('?')[0]!;
  const relative = normalize(withoutQuery).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = resolve(rootDir, `.${sep}${relative}`);
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

/** Serves a static file from `rootDir` for GET/HEAD requests, with a
 *  path-traversal guard and ETag/If-None-Match support. Returns whether
 *  it handled the request at all (false means "not found here, let the
 *  caller decide what to do next" rather than always sending a 404). */
export async function serveStatic(rootDir: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolveSafePath(rootDir, requestPath);
  if (!filePath) {
    res.writeHead(400).end('bad request');
    return true;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return false;
  }
  if (!fileStat.isFile()) return false;

  const content = await readFile(filePath);
  const etag = `"${createHash('sha256').update(content).digest('hex').slice(0, 16)}"`;
  const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return true;
  }

  res.writeHead(200, { 'content-type': contentType, etag, 'content-length': content.length });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(content);
  }
  return true;
}

export function joinPublicDir(baseDir: string, sub = 'public'): string {
  return join(baseDir, sub);
}
