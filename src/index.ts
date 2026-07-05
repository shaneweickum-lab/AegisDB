import { fileURLToPath } from 'node:url';
import { createHttpServer } from './server/http-server.ts';
import { AppContext } from './server/app-context.ts';
import { SessionManager } from './server/auth/session.ts';
import { InvalidConfigError, parseConfig } from './deploy/config.ts';
import { printTunnelInstructions } from './deploy/tunnel.ts';
import { printVpsInstructions } from './deploy/vps.ts';

let config;
try {
  config = parseConfig(process.env);
} catch (err) {
  if (err instanceof InvalidConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const staticDir = fileURLToPath(new URL('../public', import.meta.url));
const sessions = new SessionManager(config.sessionTtlMs);
const app = new AppContext(config.dataDir, sessions);
const server = createHttpServer({ app, staticDir });

server.listen(config.port, config.bindHost, () => {
  console.log(
    `AegisDB listening on http://${config.bindHost}:${config.port} (mode: ${config.mode}, data: ${config.dataDir})`
  );
  if (config.mode === 'local-tunnel') printTunnelInstructions(config);
  else printVpsInstructions(config);
});
