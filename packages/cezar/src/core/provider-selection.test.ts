import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import type { ProviderId } from './provider-auth.ts';
import {
  MEASURED_HISTORY_MIN_SAMPLES,
  MODEL_COST_TIERS,
  NATIVE_DEFAULT_TIER,
  type AutoProviderOptions,
  type ModelUsageSample,
  type ProviderAvailability,
  type ProviderCandidate,
  type RunnerAvailability,
  modelCostTier,
  pickFailoverSelection,
  resolveAutoSelection,
} from './provider-selection.ts';

/** A runner id as a provider row — the two sets are the same ids by construction. */
function asProvider(runner: string): ProviderId {
  return runner as ProviderId;
}

/** Connected auth with no catalog: presets (or the native default) are what the runner offers. */
function usableRows(runners: readonly string[]): RunnerAvailability[] {
  return runners.map((runner) => ({
    provider: { provider: asProvider(runner), status: 'connected' as const },
  }));
}

/** Connected auth with an explicit discovery answer, so a test names its own candidate set. */
function catalogFor(runner: string, ids: readonly string[]): RunnerAvailability {
  return {
    provider: { provider: asProvider(runner), status: 'connected' as const },
    catalog: {
      runner: asProvider(runner),
      source: 'live',
      stale: false,
      models: ids.map((id) => ({ id, label: id, description: '' })),
    },
  };
}

function candidate(partial: Partial<ProviderCandidate> & Pick<ProviderCandidate, 'runner' | 'model'>): ProviderCandidate {
  return { provider: 'test', tier: 3, ...partial };
}

describe('model cost tiers', () => {
  it('ranks the cheap families tier 1', () => {
    expect(modelCostTier('claude-haiku-4-5')).toBe(1);
    expect(modelCostTier('gpt-5.1-codex-mini')).toBe(1);
    expect(modelCostTier('gemini-2.5-flash')).toBe(1);
    expect(modelCostTier('kimi-k3-low')).toBe(1);
  });

  it('ranks the mid families tier 2, and codex only when it is not the mini', () => {
    expect(modelCostTier('sonnet')).toBe(2);
    expect(modelCostTier('claude-sonnet-5')).toBe(2);
    expect(modelCostTier('gpt-5.1-codex')).toBe(2);
    expect(modelCostTier('gpt-5-codex')).toBe(2);
  });

  it('ranks the dear families tier 3', () => {
    expect(modelCostTier('opus')).toBe(3);
    expect(modelCostTier('claude-opus-4-8')).toBe(3);
    expect(modelCostTier('gpt-5')).toBe(3);
    expect(modelCostTier('gpt-5.4')).toBe(3);
  });

  it('ranks the dearest families tier 4', () => {
    expect(modelCostTier('claude-max')).toBe(4);
    expect(modelCostTier('gemini-3-ultra')).toBe(4);
  });

  it('fails open at the unknown mid tier (Q1)', () => {
    expect(modelCostTier('composer-2.5')).toBe(3);
    expect(modelCostTier('my-org/custom-tune')).toBe(3);
    expect(modelCostTier('gpt-6')).toBe(3);
    expect(modelCostTier('')).toBe(3);
  });

  it('matches shapes case-insensitively and cheap family first', () => {
    expect(modelCostTier('SONNET')).toBe(2);
    // Order is load-bearing: an ultra-mini is a codex-tier shape, but the cheap family claims it.
    expect(modelCostTier('ultra-mini')).toBe(1);
  });

  it('reads a family as a segment of the id, not a substring', () => {
    // "gemini" contains "mini", "octopus" contains "opus" — neither names a size, and a table that
    // said otherwise would rank Gemini cheapest of all.
    expect(modelCostTier('gemini-3-pro')).toBe(3);
    expect(modelCostTier('octopus-1')).toBe(3);
    expect(modelCostTier('sonnet-max-ultra')).toBe(2);
  });

  it('lists the tiers cheapest first', () => {
    expect(MODEL_COST_TIERS.map((entry) => entry.tier)).toEqual([1, 2, 3, 4]);
  });
});

describe('auto selection ranking', () => {
  const options: AutoProviderOptions = { defaultRunner: 'claude', maxFailovers: 3 };

  it('picks the cheapest tier across runners, not the first runner', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('claude', ['sonnet']), catalogFor('codex', ['gpt-5.1-codex-mini'])],
    };
    expect(resolveAutoSelection(availability, options)).toMatchObject({
      runner: 'codex',
      model: 'gpt-5.1-codex-mini',
      reason: 'cheapest-available',
    });
  });

  it('breaks a tier tie by measured mean cost-weighted tokens, ascending', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('claude', ['sonnet']), catalogFor('codex', ['gpt-5-codex'])],
      history: [
        { provider: 'anthropic', model: 'sonnet', costWeightedTokens: 90_000 },
        { provider: 'anthropic', model: 'sonnet', costWeightedTokens: 90_000 },
        { provider: 'anthropic', model: 'sonnet', costWeightedTokens: 90_000 },
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 10_000 },
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 10_000 },
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 10_000 },
      ],
    };
    const selection = resolveAutoSelection(availability, options);
    expect(selection.runner).toBe('codex');
    expect(selection.candidate?.meanTokens).toBe(10_000);
  });

  it('ignores a mean built from fewer than three samples', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('claude', ['sonnet']), catalogFor('codex', ['gpt-5-codex'])],
      history: [
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 1 },
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 1 },
      ],
    };
    // Thin history is withheld entirely, so the tier tie falls through to RUNNER_IDS order.
    const selection = resolveAutoSelection(availability, options);
    expect(selection.runner).toBe('claude');
    expect(selection.candidate?.meanTokens).toBeUndefined();
    expect(MEASURED_HISTORY_MIN_SAMPLES).toBe(3);
  });

  it('prefers the measured candidate over the unmeasured one within a tier', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('claude', ['sonnet']), catalogFor('codex', ['gpt-5-codex'])],
      history: [
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 500_000 },
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 500_000 },
        { provider: 'openai', model: 'gpt-5-codex', costWeightedTokens: 500_000 },
      ],
    };
    expect(resolveAutoSelection(availability, options).runner).toBe('codex');
  });

  it('breaks a full tie by RUNNER_IDS order', () => {
    expect(resolveAutoSelection({ runners: usableRows(['codex', 'claude']) }, options).runner).toBe('claude');
  });

  it('never lets an unpriceable native default outrank a rated model', () => {
    const availability: ProviderAvailability = {
      runners: [
        catalogFor('claude', ['sonnet']),
        // junie has neither discovery nor presets, so its native default is its only candidate —
        // and "unrated" must rank mid-tier, not win by construction over a rated competitor.
        ...usableRows(['junie']),
      ],
    };
    const selection = resolveAutoSelection(availability, options);
    expect(selection.runner).toBe('claude');
    expect(selection.candidate?.tier).toBe(2);
  });

  it('ranks an unrated native default at the unknown tier, so a tie falls to RUNNER_IDS order', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('claude', ['opus']), ...usableRows(['junie'])],
    };
    // claude/opus (tier 3) and junie's native default (ranked as unknown, tier 3) tie, and claude
    // comes first in RUNNER_IDS — the unpriceable candidate is in the running, just never ahead.
    expect(resolveAutoSelection(availability, options)).toMatchObject({ runner: 'claude', model: 'opus' });
  });

  it('falls back to presets when discovery is empty, and to the native default with neither', () => {
    const presets: ProviderAvailability = {
      runners: [{
        provider: { provider: asProvider('claude'), status: 'connected' },
        catalog: { runner: asProvider('claude'), source: 'cache', stale: false, models: [] },
      }],
    };
    // KNOWN_PRESETS_BY_RUNNER.claude = [opus, sonnet, haiku] — haiku is the cheapest preset.
    expect(resolveAutoSelection(presets, options)).toMatchObject({ runner: 'claude', model: 'haiku' });

    // junie's own list is empty: its native default stays in the running, unrated.
    const selection = resolveAutoSelection({ runners: usableRows(['junie']) }, options);
    expect(selection.runner).toBe('junie');
    expect(selection.model).toBeUndefined();
    expect(selection.reason).toBe('cheapest-available');
    expect(selection.candidate?.tier).toBe(NATIVE_DEFAULT_TIER);
  });

  it('skips runners whose auth is not usable', () => {
    const availability: ProviderAvailability = {
      runners: [
        { provider: { provider: asProvider('claude'), status: 'disconnected' } },
        { provider: { provider: asProvider('codex'), status: 'connected', enabled: false } },
        { provider: { provider: asProvider('cursor'), status: 'not-installed' } },
        ...usableRows(['junie']),
      ],
    };
    const selection = resolveAutoSelection(availability, options);
    expect(selection.runner).toBe('junie');
    expect(selection.model).toBeUndefined();
  });

  it('excludes already-exhausted canonical providers, across runners that serve them', () => {
    const availability: ProviderAvailability = {
      runners: [
        catalogFor('claude', ['sonnet']),
        catalogFor('opencode', ['anthropic/claude-sonnet-5', 'openai/gpt-5.1-codex-mini']),
      ],
    };
    // The first opencode id is the same exhausted account as claude's, through a different CLI.
    const selection = resolveAutoSelection(availability, {
      ...options,
      excludeProviders: ['anthropic', 'Anthropic'],
    });
    expect(selection).toMatchObject({ runner: 'opencode', model: 'openai/gpt-5.1-codex-mini' });
  });
});

describe('locked mode', () => {
  const options: AutoProviderOptions = { defaultRunner: 'claude', locked: true, maxFailovers: 3 };

  it('balances the provider but never pins a model (Q5)', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('claude', ['haiku'])],
    };
    const selection = resolveAutoSelection(availability, options);
    expect(selection.runner).toBe('claude');
    expect(selection.model).toBeUndefined();
    expect(selection.reason).toBe('models-locked');
    expect(selection.candidate?.model).toBe('');
  });

  it('still skips an exhausted provider while balancing', () => {
    const availability: ProviderAvailability = { runners: usableRows(['claude', 'codex']) };
    const selection = resolveAutoSelection(availability, { ...options, excludeProviders: ['anthropic'] });
    expect(selection.runner).toBe('codex');
    expect(selection.model).toBeUndefined();
  });
});

describe('degradation', () => {
  const options: AutoProviderOptions = { defaultRunner: 'cursor', maxFailovers: 3 };

  it('degrades to the configured default runner with no model', () => {
    expect(resolveAutoSelection({ runners: [] }, options)).toEqual({ runner: 'cursor', reason: 'no-provider' });
    expect(resolveAutoSelection(undefined, options)).toEqual({ runner: 'cursor', reason: 'no-provider' });
  });

  it('degrades when runners are listed but none is usable', () => {
    const availability: ProviderAvailability = {
      runners: [{ provider: { provider: asProvider('claude'), status: 'unknown' } }],
    };
    expect(resolveAutoSelection(availability, options)).toMatchObject({ runner: 'cursor', reason: 'no-provider' });
  });

  it('never throws on malformed host state, and still serves what survives it', () => {
    const hostile = {
      runners: [
        undefined,
        { provider: undefined },
        {
          provider: { provider: asProvider('claude'), status: 'connected' },
          catalog: { models: [undefined, { id: 42 }, { id: 'haiku' }] },
        },
      ],
      history: [undefined, { provider: '', model: 'sonnet', costWeightedTokens: Number.NaN }],
    } as unknown as ProviderAvailability;
    const selection = resolveAutoSelection(hostile, options);
    // The garbage entries are dropped, the one healthy row still ranks.
    expect(selection).toMatchObject({ runner: 'claude', model: 'haiku' });
  });

  it('falls back to the first runner when defaultRunner is not a runner id at all', () => {
    const broken = { defaultRunner: 'gpt-4', maxFailovers: 3 } as unknown as AutoProviderOptions;
    expect(resolveAutoSelection({ runners: [] }, broken).runner).toBe(RUNNER_IDS[0]);
  });
});

describe('failover', () => {
  const options: AutoProviderOptions = { defaultRunner: 'claude', maxFailovers: 3 };
  const failed = candidate({ runner: 'claude', model: 'sonnet', provider: 'anthropic', tier: 2 });

  it('requires a DIFFERENT canonical provider (Q7) — pi serving anthropic is NOT a target for claude', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('pi', ['anthropic/claude-sonnet-5']), catalogFor('codex', ['gpt-5.1-codex-mini'])],
    };
    expect(pickFailoverSelection(failed, availability, options)).toMatchObject({
      runner: 'codex',
      model: 'gpt-5.1-codex-mini',
      reason: 'failover-similar',
    });

    // The same host without codex: every remaining candidate is still the exhausted anthropic
    // account behind a different CLI, so there is nowhere to go and the existing wait-for-reset
    // behavior stays.
    expect(pickFailoverSelection(
      failed,
      { runners: [catalogFor('pi', ['anthropic/claude-sonnet-5']), catalogFor('opencode', ['anthropic/claude-haiku-4-5'])] },
      options,
    )).toBeNull();
  });

  it('picks the nearest tier first, then the cheapest (Q7 similarity)', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('codex', ['gpt-5.1-codex-mini', 'gpt-5', 'gpt-5-codex'])],
    };
    // Failed at tier 2: the tier-2 codex id is nearer than the tier-1 mini and the tier-3 gpt-5.
    expect(pickFailoverSelection(failed, availability, options))
      .toMatchObject({ runner: 'codex', model: 'gpt-5-codex' });
  });

  it('excludes the failed provider even when the caller has not recorded it yet', () => {
    const availability: ProviderAvailability = { runners: usableRows(['claude', 'codex']) };
    expect(pickFailoverSelection(failed, availability, options)).toMatchObject({ runner: 'codex' });
  });

  it('honours the exhausted providers a run has already spent', () => {
    const availability: ProviderAvailability = {
      runners: [catalogFor('codex', ['gpt-5.1-codex-mini']), catalogFor('cursor', ['composer-2.5'])],
    };
    // openai is spent, so the tier-1 codex id drops out and cursor's tier-3 id is the nearest left.
    expect(pickFailoverSelection(failed, availability, { ...options, excludeProviders: ['openai'] }))
      .toMatchObject({ runner: 'cursor', model: 'composer-2.5' });
  });

  it('never returns the failed candidate itself', () => {
    const availability: ProviderAvailability = { runners: [catalogFor('claude', ['sonnet', 'haiku'])] };
    expect(pickFailoverSelection(failed, availability, options)).toBeNull();
  });

  it('returns null when failover is configured off', () => {
    const availability: ProviderAvailability = { runners: usableRows(['codex']) };
    expect(pickFailoverSelection(failed, availability, { ...options, maxFailovers: 0 })).toBeNull();
    expect(pickFailoverSelection(failed, availability, { ...options, maxFailovers: -1 })).toBeNull();
  });

  it('returns null when there is nothing to fail over to', () => {
    expect(pickFailoverSelection(failed, { runners: [] }, options)).toBeNull();
    expect(pickFailoverSelection(undefined, { runners: usableRows(['codex']) }, options)).toBeNull();
  });

  it('fails over without pinning a model under the lock (Q5)', () => {
    const availability: ProviderAvailability = { runners: usableRows(['claude', 'codex']) };
    const selection = pickFailoverSelection(
      candidate({ runner: 'codex', model: '', provider: 'openai', tier: NATIVE_DEFAULT_TIER }),
      availability,
      { ...options, locked: true },
    );
    expect(selection?.runner).toBe('claude');
    expect(selection?.model).toBeUndefined();
    expect(selection?.reason).toBe('failover-similar');
  });

  it('never throws on malformed host state, and still finds the survivor', () => {
    const hostile = {
      runners: [undefined, { provider: { provider: asProvider('codex'), status: 'connected' } }],
    } as unknown as ProviderAvailability;
    expect(pickFailoverSelection(failed, hostile, options)).toMatchObject({ runner: 'codex' });
    expect(pickFailoverSelection(failed, undefined, options)).toBeNull();
  });
});

describe('determinism', () => {
  const options: AutoProviderOptions = { defaultRunner: 'claude', maxFailovers: 3 };
  // Two tier-1 candidates whose means differ — the measured tie-break, not the table, must decide.
  const availability: ProviderAvailability = {
    runners: [
      catalogFor('opencode', ['openai/gpt-5.1-codex-mini']),
      catalogFor('claude', ['haiku']),
      { provider: { provider: asProvider('codex'), status: 'connected' } },
    ],
    history: [
      { provider: 'openai', model: 'gpt-5.1-codex-mini', costWeightedTokens: 90_000 },
      { provider: 'openai', model: 'gpt-5.1-codex-mini', costWeightedTokens: 90_000 },
      { provider: 'openai', model: 'gpt-5.1-codex-mini', costWeightedTokens: 90_000 },
      { provider: 'anthropic', model: 'haiku', costWeightedTokens: 42_000 },
      { provider: 'anthropic', model: 'haiku', costWeightedTokens: 44_000 },
      { provider: 'anthropic', model: 'haiku', costWeightedTokens: 43_000 },
    ] satisfies ModelUsageSample[],
  };

  it('returns the identical selection however the host orders its answers', () => {
    const first = resolveAutoSelection(availability, options);
    const reversed: ProviderAvailability = { ...availability, runners: [...availability.runners].reverse() };
    expect(resolveAutoSelection(reversed, options)).toEqual(first);
    expect(first).toMatchObject({ runner: 'claude', model: 'haiku', reason: 'cheapest-available' });
    expect(first.candidate?.meanTokens).toBe(43_000);
  });

  it('re-derives the same failover decision after a restart', () => {
    const failed: ProviderCandidate = {
      runner: 'claude',
      model: 'sonnet',
      provider: 'anthropic',
      tier: 2,
      meanTokens: 43_000,
    };
    expect(pickFailoverSelection(failed, availability, options))
      .toEqual(pickFailoverSelection(failed, availability, options));
  });
});
