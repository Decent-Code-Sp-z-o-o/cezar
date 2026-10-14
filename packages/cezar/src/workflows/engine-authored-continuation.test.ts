import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Engine-authored continuation prompts must reach the agent VERBATIM while never rendering as a
 * message the user sent.
 *
 * The engine writes its own resume prompts — restart recovery, the usage-limit resume, the
 * usage-limit failover — and every one of them funnels through `runContinuation`, which persists
 * the opening prompt as a `user-message` event. The cockpit rendered each as a user bubble: real
 * transcripts accumulated dozens of identical "The cezar process restarted…" bubbles. The lines
 * now carry `engineAuthored: true`; the fold (packages/web `thread-state.ts`) opens the turn but
 * attaches no bubble.
 *
 * What is pinned here is the ENGINE half: the marker lands on exactly the engine's prompts, with
 * the text untouched, and a user's own Continue stays unmarked. The web fold has its own tests.
 * Driven dry through `scripts/mock-claude.mjs`, which echoes the prompt it received — so the
 * `text` event is a witness of what actually reached the backend.
 */
describe('engine-authored continuation prompts are stamped, user ones are not', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let runId: string | undefined;
  let savedDryRun: string | undefined;

  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  const RESTART_PROMPT =
    'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';

  beforeEach(async () => {
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-engine-authored-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // Explicit budget: the fixtures are real git repos on this disk, and the default 10s hook
    // timeout is a machine-load lottery (the same reason the other suites carry 30s+ here).
  }, 60_000);

  afterEach(() => {
    if (runId && manager) manager.cancel(runId);
    manager?.dispose(); // see DISPOSE in run.test.ts — after the cancel it enables
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  }, 60_000);

  const eventsOf = (id: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const openingMessage = (id: string, stepId: string): Record<string, unknown> | undefined =>
    eventsOf(id).find((event) => event.type === 'user-message' && event.stepId === stepId);

  const waitFor = async (predicate: () => boolean, ms = 60_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  /** A finished run, ready for the cockpit's Reply composer — the path a user's Continue takes. */
  const finishedRun = async (): Promise<string> => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? ''));
    return record.id;
  };

  it('a user Continue appends an UNMARKED user-message — the thread renders it as always', async () => {
    const id = await finishedRun();
    expect(manager!.continueRun(id, { text: 'Continue.' })).toEqual({ ok: true });
    await waitFor(() => openingMessage(id, 'continue-1') !== undefined);

    const opening = openingMessage(id, 'continue-1')!;
    expect(opening.text).toBe('Continue.');
    expect('engineAuthored' in opening).toBe(false);
  }, 120_000);

  it('an engine-authored continuation is stamped and the agent still receives the prompt verbatim', async () => {
    const id = await finishedRun();
    expect(manager!.continueRun(id, { text: RESTART_PROMPT, engineAuthored: true })).toEqual({ ok: true });
    await waitFor(() => openingMessage(id, 'continue-1') !== undefined);

    const opening = openingMessage(id, 'continue-1')!;
    // The marker the web fold reads…
    expect(opening.engineAuthored).toBe(true);
    // …and the text untouched: only the rendering changes, never what the agent is told.
    expect(opening.text).toBe(RESTART_PROMPT);
    // The mock echoes what it was handed — delivery evidence, not just persistence evidence.
    await waitFor(() =>
      eventsOf(id).some(
        (event) =>
          event.stepId === 'continue-1' &&
          event.type === 'text' &&
          String(event.text ?? '').startsWith('Okay — looking into: The cezar process restarted'),
      ),
    );
  }, 120_000);

  it('restart recovery stamps the resume prompt it writes for an interrupted run', async () => {
    manager = new RunManager(store, repoRoot);
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    runId = id;
    store.updateRun(id, { status: 'running', startedAt: new Date().toISOString(), currentStepId: 'work' });
    store.updateStep(id, 'work', { status: 'running', sessionId: 'sess-1', backend: 'claude' });

    await manager.recover();
    await waitFor(() => openingMessage(id, 'continue-1') !== undefined);

    const opening = openingMessage(id, 'continue-1')!;
    expect(opening.engineAuthored).toBe(true);
    // The resume goes through the queue, which re-attaches the task text (`#472`); the engine
    // prompt still leads verbatim.
    expect(String(opening.text).startsWith(RESTART_PROMPT)).toBe(true);
  }, 120_000);

  it('a restart-requeued continuation carries the marker through the queue to its opening line', async () => {
    manager = new RunManager(store, repoRoot);
    // The shape `reviveQueuedRun` reconstructs: a queued record whose executable continuation was
    // process-local and died with the previous process, with the prior session still on record.
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      runner: 'claude',
      steps: [
        { id: 'work', name: 'Work', kind: 'agent' },
        { id: 'continue-1', name: 'Continue', kind: 'agent' },
      ],
    });
    runId = id;
    store.updateRun(id, { workflowDef: SINGLE_STEP, status: 'queued' });
    store.updateStep(id, 'work', { status: 'done', sessionId: 'sess-1', backend: 'claude' });
    store.updateStep(id, 'continue-1', { status: 'pending' });

    await manager.recover();
    await waitFor(() => openingMessage(id, 'continue-1') !== undefined);

    const opening = openingMessage(id, 'continue-1')!;
    expect(opening.engineAuthored).toBe(true);
    // `hydrateQueuedContinuation` re-attaches the task text the queued continuation lost with the
    // process; the engine prompt still leads verbatim.
    expect(String(opening.text).startsWith(RESTART_PROMPT)).toBe(true);
    expect(String(opening.text)).toContain('Current task and queued updates:');
  }, 120_000);
});
