import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { costWeightedTokens } from './usage.ts';
import {
  createOllamaUiState,
  mapOllamaChatChunk,
  ollamaSessionEndedEvent,
  ollamaSessionStartedEvents,
  parseOllamaChatLine,
  type OllamaUiMapperState,
} from './ollama-ui-mapper.ts';
import { resolveOllamaHost } from './ollama-model-catalog.ts';
import { DEFAULT_RUN_TIMEOUT_MS } from './claude-cli-runner.ts';

export { DEFAULT_RUN_TIMEOUT_MS } from './claude-cli-runner.ts';

export interface OllamaRunnerOptions {
  /** Server endpoint; defaults to `OLLAMA_HOST` / `http://127.0.0.1:11434`. */
  host?: string;
  /** Wall-clock cap per POST (ms); `spec.timeoutMs` still wins. `0` disables. */
  timeoutMs?: number;
  /** Injectable transport — tests stub this instead of opening a socket. */
  fetchImpl?: typeof fetch;
}

/** One message of the client-side conversation history (`/api/chat` is stateless). */
interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 images, WITHOUT the `data:` prefix — Ollama's documented field. */
  images?: string[];
}

/**
 * `AgentRunner` over a LOCAL Ollama server's `/api/chat` endpoint — the same
 * HTTP API `ollama run` and every Ollama client speak. There is no CLI here on
 * purpose: Ollama ships no agent process, so there is nothing to spawn; the
 * conversation is stateless per request and this runner keeps the history.
 *
 * Auth = none. The server is local and unauthenticated; "connected" (the
 * provider probe) means it is listening, and `OLLAMA_HOST` is honored for
 * non-default endpoints.
 *
 * The honest limitation: this is a CHAT backend, not an agent backend. The
 * `/api/chat` wire has no tool-use channel cezar could drive, so a run emits
 * text only — it cannot read or edit files, and tasks that need tool calls
 * will end with prose, not changes. Route ollama the work the local-model
 * research (.ai/specs/units-research/08-cheap-and-local-models.md §6) calls
 * safe at the bottom tier: bounded text work with an external verifier.
 * Sessions do not resume ("Continue" starts fresh — the server keeps no
 * history to resume into), and `spec.allowedTools`/`mcpServers` are ignored.
 */
export class OllamaRunner implements AgentRunner {
  readonly backend = 'ollama' as const;

  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private lastSession: OllamaSession | null = null;

  constructor(opts: OllamaRunnerOptions = {}) {
    this.host = resolveOllamaHost(opts.host);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const session = new OllamaSession(
      this.host,
      this.timeoutMs,
      this.doFetch,
      spec,
      onEvent,
      opts,
    );
    this.lastSession = session;
    return session;
  }
}

class OllamaSession implements AgentSession {
  readonly pid?: number;

  private readonly spec: AgentRunSpec;
  private readonly model?: string;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
  private readonly onUiEvent: ((event: UiEvent) => void) | undefined;
  private readonly autoEndAfterFirstTurn: boolean;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private state: OllamaUiMapperState;

  private history: OllamaChatMessage[];
  private turnChain: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private stopped = false;
  private firstTurnSettled = false;
  private settled = false;
  private settleResult!: (result: AgentRunResult) => void;
  private failResult!: (error: Error) => void;
  readonly result: Promise<AgentRunResult>;

  constructor(
    host: string,
    timeoutMs: number,
    doFetch: typeof fetch,
    spec: AgentRunSpec,
    onEvent: ((event: AgentEvent) => void) | undefined,
    opts: SessionOptions,
  ) {
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.doFetch = doFetch;
    this.spec = spec;
    this.onEvent = onEvent;
    this.onUiEvent = opts.onUiEvent;
    this.autoEndAfterFirstTurn = opts.autoEndAfterFirstTurn === true;
    this.model = spec.model?.trim() || undefined;
    this.history = buildInitialHistory(spec);
    this.state = createOllamaUiState({ sessionId: spec.sessionId ?? randomUUID() });

    this.result = new Promise<AgentRunResult>((resolve, reject) => {
      this.settleResult = resolve;
      this.failResult = reject;
    });

    this.emitUi(ollamaSessionStartedEvents(this.state, { model: this.model, cwd: spec.cwd }));
    this.emit({ type: 'session', sessionId: this.state.sessionId! });
    this.emitUi([{ type: 'turn.started', turnId: this.state.turnId }]);

    const first = this.openingUserMessage();
    if (first) void this.enqueue(first);
    else this.end();
  }

  get open(): boolean {
    return !this.stopped;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open) return false;
    const message = toChatMessage(content);
    if (!message) return true; // nothing textual to send — still "accepted"
    void this.enqueue(message);
    return true;
  }

  end(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort?.abort();
    this.settle();
  }

  interrupt(): void {
    // Nothing to signal over HTTP: aborting the POST is the whole teardown,
    // and cezar-caused stop must not surface as an agent failure, so the
    // result settles with whatever text arrived (the claude runner's posture).
    this.end();
  }

  hardStop(): void {
    this.end();
  }

  /** Serialize turns: one POST at a time, later messages queued behind it. */
  private enqueue(message: OllamaChatMessage): Promise<void> {
    this.turnChain = this.turnChain
      .then(() => this.runTurn(message))
      .catch(() => undefined); // failures settle the session; the chain must stay usable
    return this.turnChain;
  }

  private async runTurn(message: OllamaChatMessage): Promise<void> {
    if (this.stopped) return;
    this.history = [...this.history, message];
    const textBefore = this.state.text;
    const controller = new AbortController();
    this.abort = controller;
    const timeoutMs = this.spec.timeoutMs ?? this.timeoutMs;
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      : undefined;
    timer?.unref?.();

    try {
      const response = await this.doFetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: this.history, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Ollama responded HTTP ${response.status}: ${detail || '(no body)'}`);
      }
      if (!response.body) throw new Error('Ollama responded without a body');
      await this.readStream(response.body);
      // The server is stateless: this turn's answer must ride in the NEXT
      // request's history, or the model loses its own prior turn.
      const turnText = this.state.text.slice(textBefore.length);
      if (turnText) this.history = [...this.history, { role: 'assistant', content: turnText }];
    } catch (error) {
      this.failTurn(error, controller.signal.reason);
    } finally {
      this.abort = null;
      if (timer) clearTimeout(timer);
    }

    if (!this.stopped && this.autoEndAfterFirstTurn && !this.firstTurnSettled) {
      this.firstTurnSettled = true;
      this.end();
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        this.emitChunk(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    this.emitChunk(buffer);
  }

  private emitChunk(line: string): void {
    const chunk = parseOllamaChatLine(line);
    if (!chunk) return;
    const mapped = mapOllamaChatChunk(this.state, chunk);
    this.state = mapped.state;
    for (const event of mapped.v1) this.emit(event);
    for (const event of mapped.ui) this.emitUi([event]);
  }

  private failTurn(error: unknown, abortReason: unknown): void {
    if (this.stopped) return; // our own teardown — not an agent failure
    const timedOut = abortReason instanceof Error && abortReason.message === 'timeout';
    const cause = error instanceof Error ? error.message : String(error);
    const message = timedOut
      ? `Ollama turn timed out after ${Math.round((this.spec.timeoutMs ?? this.timeoutMs) / 1000)}s`
      : isConnectionRefused(cause)
        ? `Ollama is not reachable at ${this.host} — start it with \`ollama serve\`, then re-check the provider in Settings.`
        : `Ollama request failed: ${cause}`;
    this.emit({ type: 'error', message });
    this.emitUi([
      { type: 'session.error', message, fatal: true },
      ollamaSessionEndedEvent('error', message),
    ]);
    this.stopped = true;
    this.firstTurnSettled = true;
    this.failResult(new Error(message));
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.emitUi([ollamaSessionEndedEvent('cancelled')]);
    this.emit({ type: 'done' });
    this.settleResult({
      text: this.state.text.trim(),
      toolCalls: [],
      tokensUsed: costWeightedTokens(this.state.usage),
      sessionId: this.state.sessionId,
    });
  }

  /** The spec's opening prompt as one user message; `undefined` when empty. */
  private openingUserMessage(): OllamaChatMessage | undefined {
    return toChatMessage([
      ...(this.spec.images ?? []),
      { type: 'text', text: this.spec.userPrompt },
    ]) ?? (this.spec.userPrompt ? { role: 'user', content: this.spec.userPrompt } : undefined);
  }

  private emit(event: AgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* a consumer's bug must never take the stream down */
    }
  }

  private emitUi(events: UiEvent[]): void {
    for (const event of events) {
      try {
        this.onUiEvent?.(event);
      } catch {
        /* same belt-and-braces as the v1 channel */
      }
    }
  }
}

/** `spec` → the opening history: system prompt (native channel), then user. */
function buildInitialHistory(spec: AgentRunSpec): OllamaChatMessage[] {
  const system = spec.systemPrompt?.trim();
  return system ? [{ role: 'system', content: system }] : [];
}

/** Content blocks → one chat message; `null` when there is nothing to send. */
function toChatMessage(blocks: ContentBlock[]): OllamaChatMessage | null {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
  const images = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
    .map((block) => block.source.data)
    .filter((data) => data && !data.startsWith('data:'));
  if (!text && images.length === 0) return null;
  return { role: 'user', content: text, ...(images.length > 0 ? { images } : {}) };
}

/** Node fetch wraps ECONNREFUSED with a `cause`; both spellings are matched. */
function isConnectionRefused(message: string): boolean {
  return /fetch failed|ECONNREFUSED|connection refused|networkerror/i.test(message);
}
