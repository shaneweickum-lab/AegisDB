import type { Duplex } from 'node:stream';
import { concatBytes, utf8Decode, utf8Encode } from '../../core/bytes.ts';
import { encodeFrame, FrameDecoder, OPCODE, type WsFrame } from './frame.ts';

export type MessageHandler = (data: Uint8Array, isText: boolean) => void;
export type CloseHandler = () => void;

const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;

export interface WsConnectionOptions {
  pingIntervalMs?: number;
}

/** One accepted WebSocket connection over a raw net.Socket — frame
 *  decoding, message fragmentation/reassembly, ping/pong keepalive, and
 *  the close handshake, all hand-rolled per RFC 6455 (no `ws` package). */
export class WsConnection {
  private readonly socket: Duplex;
  private readonly decoder = new FrameDecoder();
  private fragments: Uint8Array[] = [];
  private fragmentOpcode: number | null = null;
  private closed = false;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly closeHandlers: CloseHandler[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  constructor(socket: Duplex, options: WsConnectionOptions = {}) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.handleData(new Uint8Array(chunk)));
    socket.on('error', () => this.terminate());
    socket.on('close', () => this.runCloseHandlers());

    if (options.pingIntervalMs) {
      this.pingTimer = setInterval(() => this.heartbeat(), options.pingIntervalMs);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.push(handler);
  }

  send(data: Uint8Array | string): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      this.sendFrame(OPCODE.TEXT, utf8Encode(data));
    } else {
      this.sendFrame(OPCODE.BINARY, data);
    }
  }

  close(code: number = CLOSE_NORMAL, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const reasonBytes = utf8Encode(reason);
    const payload = concatBytes(Uint8Array.of((code >>> 8) & 0xff, code & 0xff), reasonBytes);
    this.sendFrame(OPCODE.CLOSE, payload);
    this.cleanupTimers();
    this.socket.end();
  }

  private terminate(): void {
    this.closed = true;
    this.cleanupTimers();
    this.socket.destroy();
  }

  private cleanupTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private runCloseHandlers(): void {
    this.cleanupTimers();
    for (const handler of this.closeHandlers) handler();
  }

  private heartbeat(): void {
    if (this.awaitingPong) {
      // No pong since the last ping — treat the peer as unreachable.
      this.terminate();
      return;
    }
    this.awaitingPong = true;
    this.sendFrame(OPCODE.PING, new Uint8Array(0));
  }

  private sendFrame(opcode: number, payload: Uint8Array, fin = true): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload, fin));
  }

  private handleData(chunk: Uint8Array): void {
    let frames: WsFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.closeWithProtocolError('malformed frame');
      return;
    }
    for (const frame of frames) {
      this.handleFrame(frame);
      if (this.closed) break;
    }
  }

  private closeWithProtocolError(reason: string): void {
    this.close(CLOSE_PROTOCOL_ERROR, reason);
  }

  private handleFrame(frame: WsFrame): void {
    if (this.closed) return;

    // RFC 6455 5.1: "a server MUST close the connection upon receiving a
    // frame that is not masked" — applies to every client frame, not just
    // data frames.
    if (!frame.masked) {
      this.closeWithProtocolError('client frames must be masked');
      return;
    }

    switch (frame.opcode) {
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        this.maybeCompleteMessage(frame.fin);
        return;

      case OPCODE.CONTINUATION:
        if (this.fragmentOpcode === null) {
          this.closeWithProtocolError('continuation frame with no preceding fragment');
          return;
        }
        this.fragments.push(frame.payload);
        this.maybeCompleteMessage(frame.fin);
        return;

      case OPCODE.PING:
        this.sendFrame(OPCODE.PONG, frame.payload);
        return;

      case OPCODE.PONG:
        this.awaitingPong = false;
        return;

      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? (frame.payload[0]! << 8) | frame.payload[1]! : CLOSE_NORMAL;
        this.close(code);
        return;
      }

      default:
        this.closeWithProtocolError(`unsupported opcode ${frame.opcode}`);
    }
  }

  private maybeCompleteMessage(fin: boolean): void {
    if (!fin) return;
    const opcode = this.fragmentOpcode!;
    const payload = concatBytes(...this.fragments);
    this.fragments = [];
    this.fragmentOpcode = null;
    for (const handler of this.messageHandlers) handler(payload, opcode === OPCODE.TEXT);
  }
}

export function decodeText(data: Uint8Array): string {
  return utf8Decode(data);
}
