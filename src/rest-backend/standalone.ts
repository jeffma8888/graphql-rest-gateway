import { buildBackend } from './server.js';

/** Run the bundled REST backend on its own (e.g. `npm run backend`). */
async function main(): Promise<void> {
  const port = Number.parseInt(process.env.REST_PORT ?? '4001', 10);
  const latencyMs = Number.parseInt(process.env.REST_LATENCY_MS ?? '25', 10);
  const { app } = buildBackend({ latencyMs });
  const address = await app.listen({ port, host: '127.0.0.1' });
  // eslint-disable-next-line no-console
  console.log(`REST backend listening on ${address} (latency ${latencyMs}ms/request)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
