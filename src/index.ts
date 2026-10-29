import { startFromEnv } from './cli';

/**
 * `npm start` entry point. All configuration and startup logic lives in the
 * side-effect-free `./cli` module so it is testable in-process; this file only
 * owns process concerns: signals and exit codes.
 */
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
