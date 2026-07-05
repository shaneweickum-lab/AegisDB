import type { DeploymentConfig } from './config.ts';

/** Local-tunnel mode (spec 9.2 Option A): the server binds loopback only
 *  and an external tunnel client (not embedded here — see config.ts)
 *  fronts it with a public HTTPS/WSS URL. This just prints the command
 *  an operator would run alongside this process. */
export function printTunnelInstructions(config: DeploymentConfig): void {
  if (config.mode !== 'local-tunnel' || !config.tunnel) return;

  console.log(`Local-tunnel mode: bound to ${config.bindHost}:${config.port} (loopback only).`);
  console.log(`Front it with ${config.tunnel.provider} to get a public HTTPS/WSS URL, e.g.:`);
  if (config.tunnel.provider === 'cloudflare') {
    console.log(`  cloudflared tunnel --url http://localhost:${config.port}`);
  } else {
    console.log(`  ngrok http ${config.port}`);
  }
  if (config.tunnel.subdomain) {
    console.log(
      `  (requested subdomain "${config.tunnel.subdomain}" is configured in your tunnel provider's dashboard/config, not by this process)`
    );
  }
}
