import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createTerminalHub, type PtyFactory } from './terminal.ts';
import { createApp } from './server.ts';

/**
 * The session route's HTTP contract (spec 2026-10-10-terminal-tab): opt-in via
 * `CEZ_TERMINAL=1`, force-off under `CEZ_DRY_RUN=1`, a typed body, and a
 * `{token, wsPath}` answer that names the project-scoped upgrade path. The
 * frame-level behavior lives in `terminal.test.ts`; this file pins the route
 * half and its validators.
 */

describe('web terminal session API', () => {
  const savedTerminal = process.env.CEZ_TERMINAL;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  const makeFactory: PtyFactory = () => {
    throw new Error('no session should be spawned by the route tests');
  };

  beforeEach(() => {
    delete process.env.CEZ_TERMINAL;
    delete process.env.CEZ_DRY_RUN;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-terminal-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: 'test',
      terminalHub: createTerminalHub({ ptyFactory: makeFactory }),
    });
  });

  afterEach(() => {
    store.flush();
    if (savedTerminal === undefined) delete process.env.CEZ_TERMINAL;
    else process.env.CEZ_TERMINAL = savedTerminal;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown = {}) =>
    apiRequest(app, '/api/v1/terminal/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers 409 while the flag is off — the default', async () => {
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({ error: /CEZ_TERMINAL=1/ });
  });

  it('answers 409 under CEZ_DRY_RUN=1 even when opted in', async () => {
    process.env.CEZ_TERMINAL = '1';
    process.env.CEZ_DRY_RUN = '1';
    const response = await post();
    expect(response.status).toBe(409);
  });

  it('mints a token and the project-scoped upgrade path when enabled', async () => {
    process.env.CEZ_TERMINAL = '1';
    const response = await post({ cols: 120, rows: 40 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; wsPath: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.wsPath).toMatch(/^\/api\/v1\/p\/[^/]+\/terminal\/ws$/);
  });

  it('rejects out-of-range dims with 400', async () => {
    process.env.CEZ_TERMINAL = '1';
    expect((await post({ cols: 99999 })).status).toBe(400);
    expect((await post({ rows: 1 })).status).toBe(400);
    expect((await post({ cols: 'wide' })).status).toBe(400);
  });

  it('accepts an empty body — dims default in the hub', async () => {
    process.env.CEZ_TERMINAL = '1';
    expect((await post()).status).toBe(200);
  });
});
