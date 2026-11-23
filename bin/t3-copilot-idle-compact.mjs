#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
