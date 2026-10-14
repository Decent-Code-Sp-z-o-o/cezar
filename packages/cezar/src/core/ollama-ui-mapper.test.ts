import { describe, expect, it } from 'vitest';
import {
  createOllamaUiState,
  mapOllamaChatChunk,
  ollamaSessionEndedEvent,
  ollamaSessionStartedEvents,
  ollamaStopReason,
  parseOllamaChatLine,
} from './ollama-ui-mapper.ts';

describe('parseOllamaChatLine', () => {
  it('parses a chunk line and rejects garbage', () => {
    expect(parseOllamaChatLine('{"message":{"role":"assistant","content":"hi"}}')).toEqual({
      message: { role: 'assistant', content: 'hi' },
    });
    expect(parseOllamaChatLine('')).toBeNull();
    expect(parseOllamaChatLine('not json')).toBeNull();
    expect(parseOllamaChatLine('null')).toBeNull();
    // A JSON scalar is not an object, so it is not a chunk the mapper can use.
    expect(parseOllamaChatLine('"str"')).toBeNull();
    expect(parseOllamaChatLine('42')).toBeNull();
  });
});

describe('ollamaStopReason', () => {
  it('maps length-shaped done_reason to max_tokens and defaults to end_turn', () => {
    expect(ollamaStopReason({ done: true, done_reason: 'length' })).toBe('max_tokens');
    expect(ollamaStopReason({ done: true })).toBe('end_turn');
    expect(ollamaStopReason({ done: true, done_reason: 'stop' })).toBe('end_turn');
  });
});

describe('mapOllamaChatChunk', () => {
  it('emits text deltas and opens one assistant item per turn', () => {
    let state = createOllamaUiState({ sessionId: 's1' });
    const first = mapOllamaChatChunk(state, { message: { role: 'assistant', content: 'Hel' } });
    state = first.state;
    const second = mapOllamaChatChunk(state, { message: { role: 'assistant', content: 'lo' } });

    expect(first.v1).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(second.v1).toEqual([{ type: 'text', text: 'lo' }]);
    expect(first.ui.some((e) => e.type === 'item.started')).toBe(true);
    expect(second.ui.filter((e) => e.type === 'item.started')).toHaveLength(0);
    expect(second.state.text).toBe('Hello');
  });

  it('closes the turn on done, reporting usage on both channels', () => {
    let state = createOllamaUiState({ sessionId: 's1' });
    state = mapOllamaChatChunk(state, { message: { role: 'assistant', content: 'answer' } }).state;
    const final = mapOllamaChatChunk(state, {
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 34,
    });

    expect(final.v1).toContainEqual({ type: 'token-usage', tokensUsed: 46 });
    expect(final.v1).toContainEqual({ type: 'turn-end' });
    const completed = final.ui.find((e) => e.type === 'turn.completed');
    expect(completed).toMatchObject({
      type: 'turn.completed',
      stopReason: 'end_turn',
      usage: { input: 12, output: 34, total: 46 },
    });
    expect(final.ui.some((e) => e.type === 'usage.updated')).toBe(true);
    expect(final.state.turnOpen).toBe(false);
  });

  it('treats an unknown frame as silence — no events, no throw', () => {
    const state = createOllamaUiState();
    const mapped = mapOllamaChatChunk(state, {});
    expect(mapped.v1).toEqual([]);
    expect(mapped.ui).toEqual([]);
    expect(mapped.state.text).toBe('');
  });

  it('session bookkeeping events carry the backend, model and close reason', () => {
    const state = createOllamaUiState({ sessionId: 'abc' });
    expect(ollamaSessionStartedEvents(state, { model: 'qwen3-coder:30b', cwd: '/repo' })).toEqual([
      {
        type: 'session.started',
        sessionId: 'abc',
        backend: 'ollama',
        model: 'qwen3-coder:30b',
        cwd: '/repo',
      },
    ]);
    expect(ollamaSessionEndedEvent('error', 'boom')).toEqual({
      type: 'session.ended',
      reason: 'error',
      message: 'boom',
    });
  });
});
