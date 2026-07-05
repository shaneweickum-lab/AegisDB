#!/usr/bin/env node
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/bench-impl.ts'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
