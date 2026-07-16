import { createServer } from 'node:http';
import { buildBackend } from './rest-backend/server';
import { createGateway } from './gateway/server';

/**
 * Dev entrypoint: boot the bundled REST backend and the GraphQL gateway in one
 * process so `npm start` gives you a working GraphiQL with zero external deps.
 */
async function main(): Promise<void> {
  const gatewayPort = Number.parseInt(process.env.PORT ?? '4000', 10);
  const restLatency = Number.parseInt(process.env.REST_LATENCY_MS ?? '25', 10);

  const { app } = buildBackend({ latencyMs: restLatency });
  const restBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  const yoga = createGateway({ restBaseUrl });
  const server = createServer(yoga);

  server.listen(gatewayPort, () => {
    // eslint-disable-next-line no-console
    console.log(`REST backend (bundled): ${restBaseUrl} (latency ${restLatency}ms/request)`);
    // eslint-disable-next-line no-console
    console.log(`GraphQL gateway + GraphiQL: http://localhost:${gatewayPort}/graphql`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
