import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
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
 * A chat backend's completed turn settles the run instead of parking `waiting`.
 *
 * The ollama runner streams ONE text turn per POST (`/api/chat` has no tool loop) and no process
 * ever exits, so the interactive-step park — "The agent is paused, waiting for your reply" — had
 * nothing to wait for: the 15-minute idle close then failed the run mid-answer (live run
 * d294d5ee, gemma via ollama). The engine now settles a chat backend's turn like a `CEZ:DONE`.
 *
 * Driven through a loopback HTTP server that speaks just enough of Ollama's NDJSON chat stream
 * for the runner — no CLI, no dry-run mock: the factory must build the real OllamaRunner.
 */
describe('an ollama turn settles the run', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let runId: string | undefined;
  let server: Server | undefined;
  let savedHost: string | undefined;

  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    savedHost = process.env.OLLAMA_HOST;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ollama-settle-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const chunk = (content: string) =>
        res.write(`${JSON.stringify({ message: { role: 'assistant', content } })}\n`);
      chunk('Here is the plan. ');
      chunk('It has concrete steps.');
      res.write(`${JSON.stringify({ done: true, message: { role: 'assistant', content: '' } })}\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    process.env.OLLAMA_HOST = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60_000);

  afterEach(() => {
    if (runId && manager) manager.cancel(runId);
    manager?.dispose(); // see DISPOSE in run.test.ts — after the cancel it enables
    server?.close();
    if (savedHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = savedHost;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  }, 60_000);

  const waitFor = async (predicate: () => boolean, ms = 60_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('a completed turn finishes the run instead of parking for a reply', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(SINGLE_STEP, {
      task: 'write the plan',
      worktree: false,
      runner: 'ollama',
    });
    runId = record.id;
    // The turn ends within seconds either way; the pre-fix engine parked `waiting` here and
    // only the 15-minute idle close moved it again.
    await waitFor(
      () => ['done', 'review', 'failed', 'waiting', 'cancelled'].includes(store.getRun(record.id)?.status ?? ''),
      60_000,
    );
    expect(store.getRun(record.id)?.status).not.toBe('waiting');
    expect(['done', 'review']).toContain(store.getRun(record.id)?.status);
    // The answer is the deliverable: the model's text reached the run's transcript.
    const events = JSON.parse(
      `[${readFileSync(join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8').trim().split('\n').join(',')}]`,
    ) as Array<Record<string, unknown>>;
    expect(events.some((event) => event.type === 'text' && String(event.text).includes('concrete steps'))).toBe(true);
  }, 120_000);
});
