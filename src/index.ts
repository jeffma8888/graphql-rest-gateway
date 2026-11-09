#!/usr/bin/env node
import { rejectArguments, startFromEnv } from './cli.js';

/**
 * `npm start` and installed `graphql-rest-gateway` entry point. All configuration
 * and startup logic lives in the side-effect-free `./cli` module so it is testable
 * in-process; this file only owns process concerns: argv, signals and exit codes.
 */
function main(): void {
  const argError = rejectArguments(process.argv.slice(2));
  if (argError !== undefined) {
    // eslint-disable-next-line no-console
    console.error(argError);
    // `exitCode`, not `process.exit`, so stderr flushes when piped; nothing else is pending.
    process.exitCode = 2;
    return;
  }
  startFromEnv(process.env).then(
    (running) => {
      const shutdown = (): void => {
        running.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    },
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}

main();
