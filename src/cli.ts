#!/usr/bin/env node
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
  writeOut: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
});
