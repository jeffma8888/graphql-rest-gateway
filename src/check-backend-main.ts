#!/usr/bin/env node
import { runCheckBackend } from './check-backend.js';

/**
 * `npm run check-backend` and installed `graphql-rest-gateway-check-backend`
 * entry point. The check itself lives in the side-effect-free `./check-backend`
 * module; this file only maps the result to the process exit code. `exitCode`
 * (not `process.exit`) so piped stdout flushes.
 */
runCheckBackend(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
