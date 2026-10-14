import type { ModelOption } from './runner-model-catalog.ts';

export interface OllamaModelDiscoveryOptions {
  /** Endpoint of the local server. Defaults to `OLLAMA_HOST` / `http://127.0.0.1:11434`. */
  host?: string;
  timeoutMs?: number;
  /** Injectable transport — tests stub this instead of opening a socket. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MODELS = 500;

/**
 * The endpoint a client talks to. `OLLAMA_HOST` is Ollama's own variable and accepts both the
 * bare `host:port` form and a full URL; normalize the former so the fetch always gets a scheme.
 */
export function resolveOllamaHost(explicit?: string): string {
  const raw = (explicit ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').trim();
  if (!raw) return 'http://127.0.0.1:11434';
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw.replace(/\/+$/, '')}`;
}

interface OllamaTagsResponse {
  models?: ReadonlyArray<{ name?: unknown; model?: unknown; size?: unknown }>;
}

/**
 * Discover the host's Ollama model library — the ids `ollama list` prints, read from the same
 * server (`GET /api/tags`) the runner itself chats through, so the picker and the runs it feeds
 * can never disagree about what is installed.
 *
 * Best-effort by contract: a server that is down or answers oddly throws, and
 * `RunnerModelCatalog` turns that into a cached or `unavailable` answer — never a fabricated
 * model list.
 */
export async function discoverOllamaModels(
  options: OllamaModelDiscoveryOptions = {},
): Promise<ModelOption[]> {
  const host = resolveOllamaHost(options.host);
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${host}/api/tags`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Ollama model discovery failed: HTTP ${response.status} from ${host}`);
  }
  const body = (await response.json()) as OllamaTagsResponse;
  if (!body || !Array.isArray(body.models)) {
    throw new Error('Ollama model discovery returned an unrecognized response');
  }

  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of body.models) {
    // `name` is the pullable id (`qwen3-coder:30b`); `model` repeats it with the manifest
    // digest in newer builds. Anything without a usable name is not a model we can route.
    const id = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!id || seen.has(id)) continue;
    if (models.length >= MAX_MODELS) {
      throw new Error('Ollama model discovery exceeded the size limit');
    }
    seen.add(id);
    const size = typeof entry?.size === 'number' && Number.isFinite(entry.size)
      ? ` · ${(entry.size / 1024 ** 3).toFixed(1)} GB`
      : '';
    models.push({ id, label: id, description: `local${size}` });
  }
  return models;
}
