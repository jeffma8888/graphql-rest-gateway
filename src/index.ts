import { createServer } from 'node:http';
import { buildBackend } from './rest-backend/server';
import { createGateway } from './gateway/server';

async function main(): Promise<void> {
  const gatewayPort = Number.parseInt(process.env.PORT ?? '4000', 10);
  const restLatency = Number.parseInt(process.env.REST_LATENCY_MS ?? '25', 10);

  const { app } = buildBackend({ latencyMs: restLatency });
  const restBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  const gateway = createGateway({ restBaseUrl });
  const server = createServer(gateway.yoga);

  server.listen(gatewayPort, () => {
    // eslint-disable-next-line no-console
    console.log(`REST backend (bundled): ${restBaseUrl} (latency ${restLatency}ms/request)`);
    // eslint-disable-next-line no-console
    console.log(`GraphQL gateway + GraphiQL: http://localhost:${gatewayPort}/graphql`);
  });

  async function shutdown(): Promise<void> {
    await gateway.close();
    server.close();
    await app.close();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
