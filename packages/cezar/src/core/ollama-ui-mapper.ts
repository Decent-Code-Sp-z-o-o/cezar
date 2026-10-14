/**
 * Ollama's `/api/chat` NDJSON stream mapped onto the normalized event
 * vocabulary (v1 `AgentEvent` + v2 `UiEvent`).
 *
 * The protocol is tiny — per-line message chunks, one final stats line — so
 * unlike claude/codex/opencode this mapper is a handful of pure functions over
 * an explicit state object rather than a stateful parser: the runner reads the
 * socket, calls {@link mapOllamaChatChunk} per line, and emits what comes back.
 * What it must stay honest about is what the backend has NO wire concept of:
 * tool calls, reasoning and plans do not exist on this stream, so the mapper
 * never fabricates items for them.
 */
import type { AgentEvent } from './agent-runner.ts';
import type { StopReason, TokenUsage, UiEvent } from './ui-events.ts';
import { costWeightedTokens, type RawUsage } from './usage.ts';

/** One parsed NDJSON line of the `/api/chat` stream. */
export interface OllamaChatChunk {
  message?: { role?: unknown; content?: unknown };
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

/** Parse one NDJSON line; `null` for anything that is not a chat chunk. */
export function parseOllamaChatLine(line: string): OllamaChatChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as OllamaChatChunk;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** The stop reason Ollama's own `done_reason` names, or the ACP default. */
export function ollamaStopReason(chunk: OllamaChatChunk): StopReason {
  const reason = typeof chunk.done_reason === 'string' ? chunk.done_reason : '';
  if (/length|limit/i.test(reason)) return 'max_tokens';
  return 'end_turn';
}

/**
 * Accumulated session state. `text` is the WHOLE session's assistant text (v1
 * `AgentRunResult.text` is session-wide); `itemId`/`turnId` are minted here so
 * the runner never invents ids of its own.
 */
export interface OllamaUiMapperState {
  sessionId?: string;
  itemId: string;
  turnId: string;
  turnOpen: boolean;
  text: string;
  usage: RawUsage;
}

let nextItemId = 0;
let nextTurnId = 0;

export function createOllamaUiState(options: { sessionId?: string } = {}): OllamaUiMapperState {
  nextItemId += 1;
  nextTurnId += 1;
  return {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    itemId: `ollama-msg-${nextItemId}`,
    turnId: `ollama-turn-${nextTurnId}`,
    turnOpen: false,
    text: '',
    usage: {},
  };
}

function usageOf(state: OllamaUiMapperState): TokenUsage {
  const input = state.usage.input_tokens ?? 0;
  const output = state.usage.output_tokens ?? 0;
  return { input, output, total: input + output };
}

/**
 * Map one `/api/chat` chunk. Returns the v1 events, the v2 events and the
 * advanced state; never throws on odd fields — unknown shapes degrade to "no
 * events" the way every other mapper treats an unrecognized frame.
 */
export function mapOllamaChatChunk(
  state: OllamaUiMapperState,
  chunk: OllamaChatChunk,
): { v1: AgentEvent[]; ui: UiEvent[]; state: OllamaUiMapperState } {
  const v1: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  const next: OllamaUiMapperState = { ...state };

  const content = typeof chunk.message?.content === 'string' ? chunk.message.content : '';
  if (content) {
    if (!next.turnOpen) {
      next.turnOpen = true;
      ui.push({ type: 'item.started', item: { kind: 'message', id: next.itemId, role: 'assistant', text: '' } });
    }
    next.text += content;
    v1.push({ type: 'text', text: content });
    ui.push({ type: 'item.delta', itemId: next.itemId, field: 'text', delta: content });
  }

  if (chunk.done !== true) return { v1, ui, state: next };

  // The final line of a turn: stats first (they ride the same line), then the
  // boundaries. prompt_eval_count is the prompt (input) side, eval_count the
  // generated (output) side; both are absent on some older builds.
  const promptEval = typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : undefined;
  const evalCount = typeof chunk.eval_count === 'number' ? chunk.eval_count : undefined;
  if (promptEval !== undefined) next.usage = { ...next.usage, input_tokens: promptEval };
  if (evalCount !== undefined) next.usage = { ...next.usage, output_tokens: evalCount };

  const usage = usageOf(next);
  if (next.turnOpen) {
    ui.push({
      type: 'item.completed',
      item: { kind: 'message', id: next.itemId, role: 'assistant', text: next.text },
    });
  }
  if (promptEval !== undefined || evalCount !== undefined) {
    v1.push({ type: 'token-usage', tokensUsed: costWeightedTokens(next.usage) });
    ui.push({ type: 'usage.updated', usage });
  }
  v1.push({ type: 'turn-end' });
  ui.push({ type: 'turn.completed', turnId: next.turnId, stopReason: ollamaStopReason(chunk), usage });
  next.turnOpen = false;

  return { v1, ui, state: next };
}

/** The v2 session-open event — emitted once, when the session is constructed. */
export function ollamaSessionStartedEvents(
  state: OllamaUiMapperState,
  options: { model?: string; cwd: string },
): UiEvent[] {
  return [{
    type: 'session.started',
    sessionId: state.sessionId ?? '',
    backend: 'ollama',
    ...(options.model ? { model: options.model } : {}),
    cwd: options.cwd,
  }];
}

/** The v2 session-close event — replaces v1 `done` / the fatal `error`. */
export function ollamaSessionEndedEvent(reason: StopReason, message?: string): UiEvent {
  return { type: 'session.ended', reason, ...(message ? { message } : {}) };
}
