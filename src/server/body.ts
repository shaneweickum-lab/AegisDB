import type { IncomingMessage } from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte limit`);
  }
}

/** Reads the full request body with a hard size cap enforced while
 *  streaming (not after the fact) — every parser that trusts a length
 *  from the wire needs this, or it's a memory-exhaustion vector. */
export function readRawBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Reject once, but keep draining (without buffering) rather than
        // destroying the socket — tearing down the connection mid-upload
        // is what causes the client to see a raw connection error instead
        // of a clean 413 response.
        if (!exceeded) {
          exceeded = true;
          reject(new BodyTooLargeError(maxBytes));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!exceeded) resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

export async function readJsonBody<T>(req: IncomingMessage, maxBytes?: number): Promise<T> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.from(raw).toString('utf8')) as T;
  } catch {
    throw new SyntaxError('request body is not valid JSON');
  }
}
