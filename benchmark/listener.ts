import http, { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/lib';

/**
 * Serial throughput gate for `gateway.nodeListener` (`npm run bench:listener`).
 *
 * WHY a script and not a vitest assertion: a same-process req/s RATIO is not
 * load-invariant inside the parallel suite (the two mounts do not slow down
 * together, iter-93 measured 0.69 under load against >= 0.82 alone), so the
 * floor is checked here, run by an operator on a quiet host.
 *
 * One gateway is mounted twice, as `createServer(gw.nodeListener)` and as a raw
 * `createServer(gw.yoga)`. Rounds alternate between the mounts so drift hits
 * both, and the ratio is fastest-listener-round / fastest-yoga-round.
 */

export interface ListenerBenchResult {
  ratio: number;
  threshold: number;
  pass: boolean;
}

interface Options {
  rounds: number;
  roundMs: number;
  threshold: number;
}

const DEFAULTS: Options = { rounds: 5, roundMs: 300, threshold: 0.8 };
/** Concurrent keep-alive clients per round: enough to keep the event loop saturated. */
const CONCURRENCY = 16;
const PAYLOAD = JSON.stringify({ query: '{ __typename }' });

/** Reads `--flag value` as a number; rejects anything non-finite, negative, or (for counts) zero. */
function numberFlag(argv: string[], flag: string, fallback: number, positive: boolean): number {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error(`Invalid ${flag} value: ${raw ?? '(missing)'}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  return {
    rounds: Math.max(1, Math.floor(numberFlag(argv, '--rounds', DEFAULTS.rounds, true))),
    roundMs: numberFlag(argv, '--round-ms', DEFAULTS.roundMs, true),
    threshold: numberFlag(argv, '--threshold', DEFAULTS.threshold, false),
  };
}

async function listen(listener: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(listener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

async function shut(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

/** One POST of `{ __typename }`; a non-200 rejects so a broken mount cannot "win" a round. */
function post(port: number, agent: http.Agent): Promise<void> {
  return new Promise((res, rej) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/graphql',
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(PAYLOAD) },
      },
      (m) => {
        if (m.statusCode !== 200) rej(new Error(`mount on port ${port} answered ${m.statusCode}`));
        m.resume();
        m.on('end', () => res());
        m.on('error', rej);
      },
    );
    req.on('error', rej);
    req.end(PAYLOAD);
  });
}

/** Req/s of one round: CONCURRENCY closed-loop clients until the deadline. */
async function round(port: number, agent: http.Agent, ms: number): Promise<number> {
  let n = 0;
  const start = performance.now();
  const deadline = start + ms;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < deadline) {
        await post(port, agent);
        n++;
      }
    }),
  );
  return (n * 1000) / (performance.now() - start);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<ListenerBenchResult> {
  const { rounds, roundMs, threshold } = parseArgs(argv);
  const { app } = buildBackend({ latencyMs: 0 });
  const restBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const gw = createGateway({ restBaseUrl });
  const servers: Server[] = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  try {
    const node = await listen(gw.nodeListener);
    servers.push(node.server);
    const yoga = await listen(gw.yoga);
    servers.push(yoga.server);
    // Warm both mounts (JIT, sockets) before anything is measured.
    await round(node.port, agent, roundMs);
    await round(yoga.port, agent, roundMs);
    const nodeRates: number[] = [];
    const yogaRates: number[] = [];
    for (let i = 0; i < rounds; i++) {
      // Alternate which mount goes first so a warming or cooling host does not favour one.
      const order = i % 2 === 0 ? [node, yoga] : [yoga, node];
      for (const mount of order) {
        const rate = await round(mount.port, agent, roundMs);
        (mount === node ? nodeRates : yogaRates).push(rate);
      }
    }
    const ratio = Math.max(...nodeRates) / Math.max(...yogaRates);
    const pass = ratio >= threshold;
    // Print the threshold exactly as compared: 2 decimals unless that would round it (e.g. 0.805).
    const shown = Number(threshold.toFixed(2)) === threshold ? threshold.toFixed(2) : String(threshold);
    console.log(`listener/yoga ratio: ${ratio.toFixed(3)} (threshold ${shown}) ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exitCode = 1;
    return { ratio, threshold, pass };
  } finally {
    agent.destroy();
    await Promise.all(servers.map(shut));
    await gw.close();
    await app.close();
  }
}

// Run only when invoked directly (`tsx benchmark/listener.ts`), so tests can import `main`.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
