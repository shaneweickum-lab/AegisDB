// Minimal bootstrap so the server is runnable while building — Phase 10
// replaces this with the full deploy/config.ts abstraction (tunnel/VPS
// modes, proper env validation).
import { fileURLToPath } from 'node:url';
import { createHttpServer } from './server/http-server.ts';
import { AppContext } from './server/app-context.ts';

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.AEGIS_DATA_DIR ?? './data';
const staticDir = fileURLToPath(new URL('../public', import.meta.url));

const app = new AppContext(dataDir);
const server = createHttpServer({ app, staticDir });

server.listen(port, () => {
  console.log(`AegisDB listening on http://localhost:${port} (data: ${dataDir}, static: ${staticDir})`);
});
