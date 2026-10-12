import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { providersRequiredByWorkflow } from './provider-action-gate.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * The `runner: 'auto'` intake surface (spec `.ai/specs/2026-10-12-auto-provider-selection.md`
 * Q2): every start/composer schema accepts the literal and forwards it VERBATIM — resolution is
 * the engine's job at launch (proven in `workflows/auto-provider.test.ts`), never the route's.
 * The gate question is the other half: `auto` names no provider to require, so it must not 409
 * an otherwise-startable run the way a concrete-but-disconnected runner would.
 */
describe('POST /api/v1/runs runner auto', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-auto-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    // The capturing-stub pattern (start-run.test.ts): the route hands the parsed input straight
    // to the manager, and the record fold mirrors `startRun`'s own — `auto` never reaches the
    // record's `runner`.
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({
          title: 't',
          workflow: '(planned)',
          task: input.task,
          runner: input.runner !== 'auto' ? input.runner : undefined,
          runnerRequest: input.runner === 'auto' ? 'auto' : undefined,
          steps: [],
        });
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('accepts runner auto and forwards the request verbatim for the launch to resolve', async () => {
    const res = await post({ ...base, runner: 'auto' });
    expect(res.status).toBe(201);
    expect(captured?.runner).toBe('auto');
    // The created record carries the request echo, never `auto` as its runner (Q2).
    const created = ((await res.json()) as { runner?: string; runnerRequest?: string });
    expect(created.runner).toBeUndefined();
    expect(created.runnerRequest).toBe('auto');
  });

  it('still refuses a runner that is not one of the known ids', async () => {
    const res = await post({ ...base, runner: 'autopilot' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('gates nothing for an auto request: the required-provider set skips it', () => {
    const workflow: WorkflowDef = {
      name: 'mixed',
      source: 'built-in',
      steps: [
        { id: 'any', prompt: '{{task}}' },
        { id: 'pinned', prompt: '{{task}}', runner: 'codex' },
      ],
    };
    // With a concrete fallback the unnamed step joins the required set; with `auto` it does not
    // (the launch resolves and degrades honestly) — while an explicitly named runner still gates.
    expect(providersRequiredByWorkflow(workflow, 'claude')).toEqual(['claude', 'codex']);
    expect(providersRequiredByWorkflow(workflow, 'auto')).toEqual(['codex']);
  });
});
