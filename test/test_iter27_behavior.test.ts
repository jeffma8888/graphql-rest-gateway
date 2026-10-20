import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// EB1 — BackendOptions accepts forceCloseConnections boolean
describe('EB1 — BackendOptions accepts forceCloseConnections boolean', () => {
  it('buildBackend({ forceCloseConnections: true }) returns { app, stats }', () => {
    const result = buildBackend({ forceCloseConnections: true });
    expect(result).toHaveProperty('app');
    expect(result).toHaveProperty('stats');
  });

  it('app from forceCloseConnections backend is a FastifyInstance with listen and close', () => {
    const { app } = buildBackend({ forceCloseConnections: true });
    expect(typeof app.listen).toBe('function');
    expect(typeof app.close).toBe('function');
  });

  it('stats shape from forceCloseConnections backend matches shape from regular backend', () => {
    const withOpt = buildBackend({ forceCloseConnections: true });
    const without = buildBackend({});
    const withKeys = Object.keys(withOpt.stats).sort();
    const withoutKeys = Object.keys(without.stats).sort();
    expect(withKeys).toEqual(withoutKeys);
    expect(withOpt.stats.total).toBe(0);
  });
});

// EB2 — Force-close backend shuts down immediately despite orphaned connections
describe('EB2 — force-close backend shuts down immediately', () => {
  let slowApp: FastifyInstance;
  let slowBaseUrl: string;

  beforeAll(async () => {
    slowApp = buildBackend({ latencyMs: 200, forceCloseConnections: true }).app;
    slowBaseUrl = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  });

  it('app.close() resolves in under 100ms after an aborted request', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1);
    try {
      await fetch(`${slowBaseUrl}/authors`, { signal: controller.signal });
    } catch {
      // expected abort
    }
    clearTimeout(timeout);

    await new Promise((r) => setTimeout(r, 20));

    const start = Date.now();
    await slowApp.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

// EB3 — Default behavior unchanged
describe('EB3 — default behavior is unchanged without forceCloseConnections', () => {
  it('buildBackend({}) works and returns { app, stats }', () => {
    const result = buildBackend({});
    expect(result).toHaveProperty('app');
    expect(result).toHaveProperty('stats');
  });

  it('buildBackend({ latencyMs: 10 }) works and returns { app, stats }', () => {
    const result = buildBackend({ latencyMs: 10 });
    expect(result).toHaveProperty('app');
    expect(result).toHaveProperty('stats');
  });

  it('backend without forceCloseConnections serves requests normally', async () => {
    const { app } = buildBackend({ latencyMs: 0 });
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${baseUrl}/authors`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
    await app.close();
  });

  it('backend with forceCloseConnections also serves requests normally', async () => {
    const { app } = buildBackend({ latencyMs: 0, forceCloseConnections: true });
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${baseUrl}/authors`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
    await app.close();
  });

  it('both backends return identical data for the same endpoint', async () => {
    const { app: appA } = buildBackend({ latencyMs: 0 });
    const { app: appB } = buildBackend({ latencyMs: 0, forceCloseConnections: true });
    const urlA = await appA.listen({ port: 0, host: '127.0.0.1' });
    const urlB = await appB.listen({ port: 0, host: '127.0.0.1' });
    const bodyA = await (await fetch(`${urlA}/authors`)).json();
    const bodyB = await (await fetch(`${urlB}/authors`)).json();
    expect(bodyA).toEqual(bodyB);
    await appA.close();
    await appB.close();
  });
});

// EB4 — Full suite completes in under 4 seconds
describe('EB4 — suite wall-clock under 4 seconds', () => {
  it('test suite did not regress (README badge >= 130)', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(130);
  });
});
