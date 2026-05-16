#!/usr/bin/env node
import { runCli } from '../src/index.js';

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`[thestuu-cli] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
