import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// RFC 6455 section 1.3's fixed GUID, concatenated with the client's key
// and SHA-1'd to prove the server actually understood the WebSocket
// protocol (not just echoing an HTTP proxy).
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function computeAcceptValue(key: string): string {
  return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
}

export function isWebSocketUpgradeRequest(req: IncomingMessage): boolean {
  const upgrade = (req.headers.upgrade ?? '').toLowerCase();
  const connection = (req.headers.connection ?? '').toLowerCase();
  return upgrade === 'websocket' && connection.includes('upgrade');
}

/** Writes a plain-HTTP rejection response on a not-yet-upgraded socket and
 *  destroys it immediately — half-closing with `.end()` alone leaves the
 *  client waiting on a full TCP close it may not see promptly. */
export function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Performs the RFC 6455 opening handshake directly on the raw socket
 *  (no `ws` package): validates the upgrade request, computes
 *  Sec-WebSocket-Accept, and writes the raw 101 response. Returns false
 *  (having already responded with an error) if the request isn't a
 *  valid WebSocket upgrade. */
export function performHandshake(req: IncomingMessage, socket: Duplex): boolean {
  if (!isWebSocketUpgradeRequest(req)) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return false;
  }

  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    rejectUpgrade(socket, 400, 'Bad Request');
    return false;
  }

  const accept = computeAcceptValue(key);
  const responseLines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ];
  socket.write(responseLines.join('\r\n'));
  return true;
}
