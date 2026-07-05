#!/usr/bin/env node
// Runs the server directly from TypeScript source via Node's native type-stripping —
// no build step in the dev loop. Requires erasable-syntax-only TS (enforced in tsconfig.json).
import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--watch', 'src/index.ts'],
  { stdio: 'inherit', env: process.env }
);

child.on('exit', (code) => process.exit(code ?? 0));
