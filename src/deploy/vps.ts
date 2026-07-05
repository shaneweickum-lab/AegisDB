import type { DeploymentConfig } from './config.ts';

/** VPS mode (spec 9.2 Option B): the server binds all interfaces directly
 *  and is expected to sit behind a TLS-terminating reverse proxy (or use
 *  node:https directly with operator-supplied certs — kept out of this
 *  process either way, so cert management isn't this project's problem). */
export function printVpsInstructions(config: DeploymentConfig): void {
  if (config.mode !== 'vps') return;

  console.log(`VPS mode: bound to ${config.bindHost}:${config.port} (all interfaces).`);
  console.log('Put a TLS-terminating reverse proxy (nginx, Caddy, etc.) in front of this, or use node:https directly with your own certs.');
  if (config.publicHost) {
    console.log(`Expected public host: ${config.publicHost} — point DNS/your reverse proxy at this server accordingly.`);
  }
}
