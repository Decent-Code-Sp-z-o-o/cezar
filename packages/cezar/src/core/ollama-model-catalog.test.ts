import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverOllamaModels, resolveOllamaHost } from './ollama-model-catalog.ts';

afterEach(() => {
  delete process.env.OLLAMA_HOST;
});

describe('resolveOllamaHost', () => {
  it('defaults to the local server and normalizes the OLLAMA_HOST forms', () => {
    expect(resolveOllamaHost()).toBe('http://127.0.0.1:11434');
    expect(resolveOllamaHost('10.0.0.8:11434')).toBe('http://10.0.0.8:11434');
    expect(resolveOllamaHost('http://10.0.0.8:11434/')).toBe('http://10.0.0.8:11434');
    expect(resolveOllamaHost('  https://ollama.lan  ')).toBe('https://ollama.lan');
  });

  it('prefers the explicit option over OLLAMA_HOST', () => {
    process.env.OLLAMA_HOST = '10.0.0.8:11434';
    expect(resolveOllamaHost('10.0.0.9:11434')).toBe('http://10.0.0.9:11434');
  });
});

describe('discoverOllamaModels', () => {
  it('maps /api/tags entries to picker options, deduped and sized', async () => {
    const doFetch = vi.fn(async (input: unknown) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/tags');
      return new Response(JSON.stringify({
        models: [
          { name: 'qwen3-coder:30b', size: 18_000_000_000 },
          { name: 'qwen3-coder:30b', size: 18_000_000_000 }, // duplicate id
          { name: 'devstral', size: 13_000_000_000 },
          { size: 1_000 }, // no name — not routable, skipped
        ],
      }), { status: 200 });
    });

    const models = await discoverOllamaModels({ fetchImpl: doFetch });
    expect(models.map((m) => m.id)).toEqual(['qwen3-coder:30b', 'devstral']);
    expect(models[0]).toMatchObject({ label: 'qwen3-coder:30b', description: 'local · 16.8 GB' });
    expect(models[1]!.description).toBe('local · 12.1 GB');
  });

  it('throws on a non-200 answer so the catalog caches unavailability, not fiction', async () => {
    const doFetch = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(discoverOllamaModels({ fetchImpl: doFetch })).rejects.toThrow(/HTTP 500/);
  });

  it('throws on an unrecognized body shape', async () => {
    const doFetch = vi.fn(async () => new Response('{"models":"all"}', { status: 200 }));
    await expect(discoverOllamaModels({ fetchImpl: doFetch })).rejects.toThrow(/unrecognized/);
  });
});
