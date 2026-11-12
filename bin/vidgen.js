#!/usr/bin/env node
import '../src/env.js';
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n✖ ${err?.userMessage ?? err?.message ?? err}`);
  if (process.env.VIDGEN_DEBUG && err?.stack) console.error(err.stack);
  process.exit(1);
});
