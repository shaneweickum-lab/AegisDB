export type DeploymentMode = 'local-tunnel' | 'vps';
export type TunnelProvider = 'cloudflare' | 'ngrok';

export interface TunnelConfig {
  provider: TunnelProvider;
  subdomain?: string;
}

export interface DeploymentConfig {
  mode: DeploymentMode;
  dataDir: string;
  port: number;
  /** Derived from mode, not independently configurable: loopback-only
   *  for local-tunnel (the tunnel client is what actually faces the
   *  internet), all-interfaces for vps. */
  bindHost: string;
  tunnel?: TunnelConfig;
  publicHost?: string;
  sessionTtlMs: number;
}

export class InvalidConfigError extends Error {}

const VALID_MODES: DeploymentMode[] = ['local-tunnel', 'vps'];
const VALID_TUNNEL_PROVIDERS: TunnelProvider[] = ['cloudflare', 'ngrok'];
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

/** spec 9.2.2: one config object, read once at boot, that the rest of the
 *  system never branches on — only the startup script (this file plus
 *  deploy/tunnel.ts and deploy/vps.ts) cares which mode is active. No
 *  tunnel-client library is embedded here (that would violate the
 *  project's zero-runtime-dependency rule); this is a bind-address and
 *  documentation abstraction, not a managed tunnel integration. */
export function parseConfig(env: Record<string, string | undefined>): DeploymentConfig {
  const mode = (env.AEGIS_MODE ?? 'local-tunnel') as DeploymentMode;
  if (!VALID_MODES.includes(mode)) {
    throw new InvalidConfigError(`AEGIS_MODE must be one of ${VALID_MODES.join(', ')}, got ${JSON.stringify(env.AEGIS_MODE)}`);
  }

  const portRaw = env.PORT ?? '8787';
  const port = Number(portRaw);
  // 0 is valid and meaningful (Node's own "let the OS assign an ephemeral
  // port" convention) — only negative/non-integer/out-of-range values
  // beyond that are actually invalid.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidConfigError(`PORT must be an integer in 0..65535, got ${JSON.stringify(portRaw)}`);
  }

  const dataDir = env.AEGIS_DATA_DIR ?? './data';
  if (dataDir.trim().length === 0) {
    throw new InvalidConfigError('AEGIS_DATA_DIR must not be empty');
  }

  const sessionTtlRaw = env.AEGIS_SESSION_TTL_MS ?? String(DEFAULT_SESSION_TTL_MS);
  const sessionTtlMs = Number(sessionTtlRaw);
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new InvalidConfigError(`AEGIS_SESSION_TTL_MS must be a positive number, got ${JSON.stringify(sessionTtlRaw)}`);
  }

  let tunnel: TunnelConfig | undefined;
  if (mode === 'local-tunnel') {
    const provider = (env.AEGIS_TUNNEL_PROVIDER ?? 'cloudflare') as TunnelProvider;
    if (!VALID_TUNNEL_PROVIDERS.includes(provider)) {
      throw new InvalidConfigError(
        `AEGIS_TUNNEL_PROVIDER must be one of ${VALID_TUNNEL_PROVIDERS.join(', ')}, got ${JSON.stringify(env.AEGIS_TUNNEL_PROVIDER)}`
      );
    }
    const subdomain = env.AEGIS_TUNNEL_SUBDOMAIN;
    tunnel = subdomain ? { provider, subdomain } : { provider };
  }

  return {
    mode,
    dataDir,
    port,
    bindHost: mode === 'vps' ? '0.0.0.0' : '127.0.0.1',
    tunnel,
    publicHost: mode === 'vps' ? env.AEGIS_PUBLIC_HOST : undefined,
    sessionTtlMs,
  };
}
