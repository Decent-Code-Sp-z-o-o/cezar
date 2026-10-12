import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderAvailability, RunnerAvailability } from '../core/provider-selection.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Auto provider selection, end to end through the real engine (spec
 * `.ai/specs/2026-10-12-auto-provider-selection.md`) — the launch resolution AND the
 * usage-limit failover, both driven by the bundled mock (`mock:limit` for the exhaustion, the
 * same trigger the auto-resume suite proves the wire shape of).
 *
 * Availability is the one injected seam: the resolver's POLICY is unit-tested against synthetic
 * hosts in `core/provider-selection.test.ts`; what this file proves is the WIRING — that a run
 * asking for `auto` gets a concrete runner + model on its record with the request echo and the
 * lifecycle line, and that a far-out usage limit hops providers instead of parking while
 * near-out resets, concrete runners and spent budgets keep the wait.
 *
 * The failover target is deliberately `opencode` with a BARE model id: opencode rejects bare ids
 * loudly at `runContinuation`'s #405 gate (before any spawn), so the positive path is assertable
 * without a real foreign CLI — the decision is durable on the record; where the hop lands is
 * the resolver's own tested business.
 */
describe('auto provider selection', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A synthetic host: only the named runners exist, each connected with this catalog. */
  const availabilityOf = (rows: Array<[RunnerId, string[]]>): (() => Promise<ProviderAvailability>) => {
    const runners: RunnerAvailability[] = rows.map(([provider, models]) => ({
      provider: { provider, status: 'connected' },
      catalog: {
        runner: provider,
        models: models.map((id) => ({ id, label: id, description: '' })),
        source: 'live',
        stale: false,
      },
    }));
    return () => Promise.resolve({ runners });
  };

  /** The failover fixture: claude serves sonnet (tier 2), opencode a bare unknown-tier id. */
  const failoverAvailability = availabilityOf([
    ['claude', ['sonnet']],
    ['opencode', ['glm-4.6']],
  ]);

  /** Poll until the predicate holds or the deadline passes — the engine writes are async. */
  async function waitFor(predicate: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('engine state did not arrive in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Drive one real run to a terminal status. */
  async function settle(runId: string): Promise<void> {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    await waitFor(() => terminal.has(store.getRun(runId)?.status ?? ''));
  }

  const lifecycleMessages = (runId: string): string[] =>
    store.readEvents(runId).filter((event) => event.type === 'lifecycle').map((event) => String(event.message ?? ''));

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_LIMIT_RESET_SECONDS = process.env.CEZ_MOCK_LIMIT_RESET_SECONDS;
    process.env.CEZ_DRY_RUN = '1';
    // Far enough out that the failover gate is unambiguous; the near-reset test pins its own.
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-auto-provider-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(async () => {
    let teardownError: unknown;
    if (manager) {
      try {
        for (const { id } of store.listRuns()) manager.cancel(id);
        const deadline = Date.now() + 10_000;
        while (store.listRuns().some(({ id }) => manager?.isActive(id))) {
          if (Date.now() >= deadline) throw new Error('timed out waiting for auto-provider runs to stop');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        manager.dispose();
        store.flush();
      } catch (error) {
        teardownError = error;
      }
    }
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (teardownError) throw teardownError;
  });

  it('resolves an auto task at launch onto the cheapest usable provider and echoes the request', async () => {
    manager = new RunManager(store, repoRoot, {
      providerAvailability: availabilityOf([['claude', ['haiku', 'sonnet']]]),
    });
    const record = manager.startRun(workflow, { task: 'sort the inbox', runner: 'auto', worktree: false });

    await waitFor(() => store.getRun(record.id)?.runner !== undefined);
    const resolved = store.getRun(record.id);
    // haiku is the tier-1 pick; the record carries the CONCRETE runner plus the request echo and
    // the pinned model — never 'auto' in `runner` (Q2).
    expect(resolved?.runner).toBe('claude');
    expect(resolved?.runnerRequest).toBe('auto');
    expect(resolved?.resolvedModel).toBe('haiku');
    expect(lifecycleMessages(record.id).some((message) => message === 'auto -> claude/haiku (tier 1)')).toBe(true);
  }, 30_000);

  it('degrades to the configured default with an honest note when nothing is usable', async () => {
    manager = new RunManager(store, repoRoot, { providerAvailability: () => Promise.resolve({ runners: [] }) });
    const record = manager.startRun(workflow, { task: 'sort the inbox', runner: 'auto', worktree: false });

    await waitFor(() => store.getRun(record.id)?.runner !== undefined);
    const resolved = store.getRun(record.id);
    expect(resolved?.runner).toBe('claude'); // the config default — the run is attempted anyway
    expect(resolved?.runnerRequest).toBe('auto');
    expect(resolved?.resolvedModel).toBeUndefined();
    expect(lifecycleMessages(record.id).some((message) => message.includes('auto: nothing available — using default'))).toBe(true);
  }, 30_000);

  it('fails over a far-out usage limit to a similar model on another provider', async () => {
    manager = new RunManager(store, repoRoot, { providerAvailability: failoverAvailability });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', runner: 'auto', worktree: false });
    await settle(record.id);

    const hopped = store.getRun(record.id);
    // The decision, durable on the record: request echo kept, concrete runner switched, one hop
    // spent, the dead canonical provider excluded for the rest of the run.
    expect(hopped?.runnerRequest).toBe('auto');
    expect(hopped?.runner).toBe('opencode');
    expect(hopped?.resolvedModel).toBe('glm-4.6');
    expect(hopped?.failoverCount).toBe(1);
    expect(hopped?.excludedProviders).toContain('anthropic');
    expect(lifecycleMessages(record.id).some((message) => message.includes('- failing over to opencode/glm-4.6'))).toBe(true);
    // The continuation itself ran the ordinary path — here it ends at the #405 gate (a bare id on
    // a provider-spanning backend), which is the deterministic spawn-free proof the hop executed.
    expect(hopped?.status).toBe('failed');
    expect(hopped?.error).toContain('continue failed');
    // No wait was armed — the failover replaced it.
    expect(hopped?.autoResumeAt).toBeUndefined();
  }, 30_000);

  it('waits instead when the reset is inside maxWaitMinutes', async () => {
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '60';
    manager = new RunManager(store, repoRoot, { providerAvailability: failoverAvailability });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', runner: 'auto', worktree: false });
    await settle(record.id);

    const waiting = store.getRun(record.id);
    expect(waiting?.autoResumeAt).toBeDefined();
    expect(waiting?.failoverCount).toBeUndefined();
    expect(waiting?.excludedProviders).toBeUndefined();
    expect(waiting?.runner).toBe('claude'); // still on the failed provider — that is the wait
  }, 30_000);

  it('never fails over a run that named its runner', async () => {
    manager = new RunManager(store, repoRoot, { providerAvailability: failoverAvailability });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', runner: 'claude', worktree: false });
    await settle(record.id);

    const waiting = store.getRun(record.id);
    expect(waiting?.runnerRequest).toBeUndefined();
    expect(waiting?.autoResumeAt).toBeDefined();
    expect(waiting?.failoverCount).toBeUndefined();
  }, 30_000);

  it('keeps waiting once the failover budget is spent', async () => {
    manager = new RunManager(store, repoRoot, {
      providerAvailability: failoverAvailability,
      semaphore: new WorkspaceSemaphore({ initial: { autoProvider: { enabled: true, maxFailovers: 3, maxWaitMinutes: 10 } } }),
    });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', runner: 'auto', worktree: false });
    // Pre-spend the budget the way three earlier hops would have.
    store.updateRun(record.id, { failoverCount: 3 });
    await settle(record.id);

    const waiting = store.getRun(record.id);
    expect(waiting?.failoverCount).toBe(3);
    expect(waiting?.autoResumeAt).toBeDefined();
    expect(waiting?.excludedProviders).toBeUndefined();
  }, 30_000);

  it('resolves auto to the default and never fails over while the feature is switched off', async () => {
    manager = new RunManager(store, repoRoot, {
      providerAvailability: failoverAvailability,
      semaphore: new WorkspaceSemaphore({ initial: { autoProvider: { enabled: false, maxFailovers: 3, maxWaitMinutes: 10 } } }),
    });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', runner: 'auto', worktree: false });

    await waitFor(() => store.getRun(record.id)?.runner !== undefined);
    expect(store.getRun(record.id)?.runner).toBe('claude');
    expect(lifecycleMessages(record.id).some((message) => message.includes('switched off'))).toBe(true);
    await settle(record.id);

    const waiting = store.getRun(record.id);
    expect(waiting?.failoverCount).toBeUndefined();
    expect(waiting?.autoResumeAt).toBeDefined();
  }, 30_000);
});
