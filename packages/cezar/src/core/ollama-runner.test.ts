import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaRunner } from './ollama-runner.ts';
import type { AgentEvent } from './agent-runner.ts';

/**
 * The transport is injected (`fetchImpl`), so these tests open no socket and
 * depend on no local Ollama install — the same posture the other runners'
 * suites take with their injected spawn.
 */

/** An NDJSON body as `/api/chat` streams it: content chunks, then the stats line. */
function ndjsonResponse(lines: readonly string[]): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(encoder.encode(lines.join('\n') + '\n'));
    },
  });
  return new Response(stream, { status: 200 });
}

/** A fetch impl that fails the way Node's fetch wraps a dead server. */
function refusedFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('fetch failed: caused by Error: connect ECONNREFUSED 127.0.0.1:11434');
  });
}

afterEach(() => {
  delete process.env.OLLAMA_HOST;
});

describe('OllamaRunner', () => {
  it('streams a turn into text, token usage and a resolved result', async () => {
    const doFetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/chat');
      return ndjsonResponse([
        '{"message":{"role":"assistant","content":"Hel"}}',
        '{"message":{"role":"assistant","content":"lo"}}',
        '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}',
      ]);
    });
    const runner = new OllamaRunner({ fetchImpl: doFetch });
    const events: AgentEvent[] = [];

    const result = await runner.run(
      { userPrompt: 'say hello', cwd: '/repo', model: 'qwen3-coder:30b' },
      (event) => events.push(event),
    );

    expect(result.text).toBe('Hello');
    expect(result.tokensUsed).toBe(15);
    expect(result.sessionId).toEqual(expect.any(String));
    expect(result.toolCalls).toEqual([]);
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(events).toContainEqual({ type: 'token-usage', tokensUsed: 15 });
    expect(events).toContainEqual({ type: 'turn-end' });
    expect(events.at(-1)).toEqual({ type: 'done' });

    const body = JSON.parse(vi.mocked(doFetch).mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('qwen3-coder:30b');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'say hello' });
  });

  it('sends the system prompt through its native channel, not the user text', async () => {
    const doFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => ndjsonResponse([
      '{"message":{"role":"assistant","content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}',
    ]));
    const runner = new OllamaRunner({ fetchImpl: doFetch });
    await runner.run({ userPrompt: 'go', cwd: '/repo', systemPrompt: 'be brief' });

    const body = JSON.parse(vi.mocked(doFetch).mock.calls[0]![1]!.body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(body.messages[1].content).toBe('go');
  });

  it('delivers images as Ollama base64 image fields, stripped of data: prefixes', async () => {
    const doFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => ndjsonResponse([
      '{"message":{"role":"assistant","content":"seen"},"done":true,"prompt_eval_count":1,"eval_count":1}',
    ]));
    const runner = new OllamaRunner({ fetchImpl: doFetch });
    await runner.run({
      userPrompt: 'what is this?',
      cwd: '/repo',
      images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }],
    });

    const body = JSON.parse(vi.mocked(doFetch).mock.calls[0]![1]!.body as string);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'what is this?', images: ['aGk='] });
  });

  it('names the server and the fix when the daemon is down', async () => {
    const runner = new OllamaRunner({ fetchImpl: refusedFetch() });
    const events: AgentEvent[] = [];

    await expect(runner.run({ userPrompt: 'hi', cwd: '/repo' }, (e) => events.push(e)))
      .rejects.toThrow(/ollama serve/);
    const error = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).toMatch(/not reachable at http:\/\/127\.0\.0\.1:11434/);
  });

  it('surfaces a non-200 answer as an error naming the status', async () => {
    const runner = new OllamaRunner({
      fetchImpl: vi.fn(async () => new Response('{"error":"model not found"}', { status: 404 })),
    });
    await expect(runner.run({ userPrompt: 'hi', cwd: '/repo', model: 'nope' }))
      .rejects.toThrow(/HTTP 404/);
  });

  it('keeps an interactive session open across sendMessage turns', async () => {
    const bodies: string[] = [];
    const doFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return ndjsonResponse([
        `{"message":{"role":"assistant","content":"turn"},"done":true,"prompt_eval_count":1,"eval_count":1}`,
      ]);
    });
    const runner = new OllamaRunner({ fetchImpl: doFetch });
    const session = runner.startSession({ userPrompt: 'first', cwd: '/repo' });

    expect(session.open).toBe(true);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
    await vi.waitFor(() => expect(bodies).toHaveLength(2));

    // The second request carries the first turn in its history — the server is stateless.
    expect(JSON.parse(bodies[1]!).messages).toHaveLength(3);
    expect(JSON.parse(bodies[1]!).messages[1].content).toBe('turn');

    session.end();
    await expect(session.result).resolves.toMatchObject({ text: 'turnturn' });
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'late' }])).toBe(false);
  });

  it('resolves with the partial text on interrupt instead of failing the run', async () => {
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const encoder = new TextEncoder();
    const runner = new OllamaRunner({
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"message":{"role":"assistant","content":"par"}}\n'));
          void gate.then(() => {
            try {
              controller.enqueue(encoder.encode(
                '{"message":{"role":"assistant","content":"tial"},"done":true,"prompt_eval_count":1,"eval_count":2}\n',
              ));
              controller.close();
            } catch {
              /* the consumer already aborted */
            }
          });
        },
      }))),
    });
    const events: AgentEvent[] = [];
    const session = runner.startSession({ userPrompt: 'hi', cwd: '/repo' }, (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'text')).toBe(true));
    // The first chunk has landed — stop the session mid-stream.
    session.interrupt();
    released();

    const result = await session.result;
    expect(result.text).toBe('par'); // whatever arrived before the stop — never a rejection
  });

  it('follows OLLAMA_HOST for the endpoint', async () => {
    process.env.OLLAMA_HOST = '10.0.0.8:11434';
    const doFetch = vi.fn(async (_input: unknown) => ndjsonResponse([
      '{"message":{"role":"assistant","content":"x"},"done":true,"prompt_eval_count":1,"eval_count":1}',
    ]));
    const runner = new OllamaRunner({ fetchImpl: doFetch });
    await runner.run({ userPrompt: 'hi', cwd: '/repo' });
    expect(String(vi.mocked(doFetch).mock.calls[0]![0])).toBe('http://10.0.0.8:11434/api/chat');
  });
});
