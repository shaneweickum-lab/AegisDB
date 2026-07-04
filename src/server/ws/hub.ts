import type { WsConnection } from './connection.ts';

/** Topic-based pub/sub over connected WsConnections. Phase 6's visualizer
 *  subscribes to a cipher-trace topic; future consumers of this server
 *  (e.g. a live feed) would subscribe to their own topics the same way. */
export class Hub {
  private readonly topics = new Map<string, Set<WsConnection>>();

  subscribe(topic: string, connection: WsConnection): void {
    let subscribers = this.topics.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.topics.set(topic, subscribers);
    }
    subscribers.add(connection);
    connection.onClose(() => this.unsubscribe(topic, connection));
  }

  unsubscribe(topic: string, connection: WsConnection): void {
    this.topics.get(topic)?.delete(connection);
  }

  publish(topic: string, data: unknown): void {
    const subscribers = this.topics.get(topic);
    if (!subscribers || subscribers.size === 0) return;
    const message = JSON.stringify({ topic, data });
    for (const connection of subscribers) connection.send(message);
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}
