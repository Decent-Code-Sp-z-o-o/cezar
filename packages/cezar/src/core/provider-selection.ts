/**
 * Auto provider selection (spec `.ai/specs/2026-10-12-auto-provider-selection.md`) — the pure
 * policy behind `runner: 'auto'`. Two questions, one module:
 *  - `resolveAutoSelection` — which concrete runner + model should serve this run, expected to
 *    consume the fewest cost-weighted tokens among the providers actually usable on this host;
 *  - `pickFailoverSelection` — when that provider's usage window closes mid-run, which SIMILAR
 *    model on a DIFFERENT canonical provider absorbs the run instead of parking until reset.
 *
 * Pure and injectable by contract: no clock, no I/O, no environment reads. Auth rows, catalogs,
 * measured history and every knob arrive as arguments, so the whole policy unit-tests without a
 * host and — the reason purity is not just test hygiene — a restart re-derives the same decision
 * from the same record (`recover()` rebuilds it the way auto-resume rebuilds its timers).
 *
 * Two things deliberately live with the caller (`RunManager`), not here:
 *  - the Q3 gate (reset distance vs `maxWaitMinutes`) — it needs a clock;
 *  - the per-run failover spend (`failoverCount < maxFailovers`) — it owns the record. What this
 *    module can enforce is the configuration floor: `maxFailovers <= 0` means failover is off.
 *
 * `auto` itself never reaches a launch: every return value names a concrete runner from
 * `RUNNER_IDS`, and persisted records stay concrete (spec Q2). Degradation, not refusal, is the
 * failure posture throughout — "auto is an optimization, not a gate", so neither function throws
 * and anything unresolvable falls back to `defaultRunner` / `null`.
 */
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import type { ProviderStatus } from './provider-auth.ts';
import { BACKEND_MODEL_MAP, parseModelIdentity, resolveModelIdentity } from './model-identity.ts';
import { KNOWN_PRESETS_BY_RUNNER } from './model-presets.ts';
import { isProviderUsable } from './provider-availability.ts';
import type { ModelOption, RunnerModelCatalogResult } from './runner-model-catalog.ts';

/**
 * Coarse cost tiers over model-id SHAPES, cheapest first (spec Q1). No provider publishes prices
 * cezar can read, and adding a pricing API would be a second feature — so cost is approximated by
 * the structural name families vendors already use for size. Structural rather than dated for the
 * same reason `NATIVE_MODEL_ID_PREFIX` is: a table naming specific vendor releases goes stale one
 * release later, while `haiku|mini|flash` keeps ranking models that do not exist yet. Order is
 * load-bearing — first match wins, so the cheap families are checked before the dear ones and
 * `gpt-5.1-codex-mini` lands in tier 1, not tier 2's `codex`. Exported for tests.
 *
 * Each family must start at a segment boundary (`(?<![a-z0-9])`), because the tokens are read as
 * SEGMENTS of an id, not substrings: bare matching would rank every `gemini-*` id tier 1 off the
 * "mini" inside "gemini" (and any future "…octopus…" tier 3 off its "opus"). Vendors delimit size
 * tokens — `codex-mini`, `kimi-k3-low`, `claude-max` — so the boundary is what makes the shape
 * honest, and ids that embed a family name inside a word are precisely the ones it knows nothing
 * about, which then fail open at the unknown tier instead.
 */
export const MODEL_COST_TIERS = [
  { tier: 1, pattern: /(?<![a-z0-9])(?:haiku|mini|flash|low)/ },
  { tier: 2, pattern: /(?<![a-z0-9])(?:sonnet|codex(?!-mini)|medium)/ },
  { tier: 3, pattern: /(?<![a-z0-9])(?:opus|gpt-5(\D|$)|high)/ },
  { tier: 4, pattern: /(?<![a-z0-9])(?:max|ultra)/ },
] as const;

/**
 * The tier of a candidate with no id cezar can price: the runner's own native default. Distinct
 * from {@link UNKNOWN_MODEL_TIER} only as audit truth — for RANKING the two are the same (see
 * {@link rankTier}), because an unpriceable default must not win by construction.
 */
export const NATIVE_DEFAULT_TIER = 0;

/** The tier an unmatched or unpriceable model id ranks at — Q1's fail-open mid tier. */
export const UNKNOWN_MODEL_TIER = 3;

/** Distinct runs of one model before its mean is trusted as the measured tie-break (Q1). */
export const MEASURED_HISTORY_MIN_SAMPLES = 3;

/**
 * The native-default sentinel — the web composer's `''` = "the runner picks" (spec Research),
 * reused here so the two auto conventions agree. Never sent on the wire: {@link toSelection}
 * surfaces it as `model: undefined`, the same "no --model flag" the lock path produces.
 */
const NATIVE_DEFAULT_MODEL = '';

/**
 * One past run's cost-weighted usage (`core/usage.ts`), keyed by the canonical identity that
 * served it. Keying by identity rather than backend-native id pools `claude`'s `sonnet` samples
 * with `pi`'s `anthropic/claude-sonnet-5` — one model, measured once — and is what makes the
 * measured tie-break correct across runners rather than per-CLI.
 */
export interface ModelUsageSample {
  /** Canonical provider (`model-identity.ts`), e.g. `anthropic`. */
  provider: string;
  /** Provider-native model id, e.g. `sonnet`, `claude-sonnet-5`. */
  model: string;
  /** The run's `costWeightedTokens`. */
  costWeightedTokens: number;
}

/**
 * One runner's host truth, exactly as `RunManager` already holds it: the auth row
 * `isProviderUsable` judges plus whatever `RunnerModelCatalog` discovery has (Q4 — the resolver
 * composes the existing answers instead of re-deriving availability). `catalog` stays optional so
 * a runner without an adapter still enumerates from its presets or native default.
 */
export interface RunnerAvailability {
  provider: ProviderStatus;
  catalog?: RunnerModelCatalogResult;
}

/** The injected host state: who is usable, what they can name, and what this workspace measured. */
export interface ProviderAvailability {
  runners: readonly RunnerAvailability[];
  /** Past runs for the measured tie-break. Absent or thin history simply disables that break. */
  history?: readonly ModelUsageSample[];
}

/** One launchable (runner, model) pair with the cost facts ranking needs. */
export interface ProviderCandidate {
  runner: RunnerId;
  /** Backend-native id (`sonnet`, `gpt-5.1-codex-mini`, `anthropic/claude-…`), or the
   *  native-default sentinel `''`. */
  model: string;
  /** Canonical provider (`model-identity.ts`) — the boundary failover must cross (Q7). `pi`
   *  serving `anthropic/claude-sonnet-5` and `claude` serving `sonnet` share it, and so are the
   *  same exhausted account to a failover. */
  provider: string;
  /** 1 cheapest … 5 dearest; {@link NATIVE_DEFAULT_TIER} for the runner's own default. */
  tier: number;
  /** Measured mean cost-weighted tokens, when history has ≥ {@link MEASURED_HISTORY_MIN_SAMPLES}
   *  runs of this canonical identity. */
  meanTokens?: number;
}

/** Why a selection looks the way it does — the lifecycle line's "why" half (spec UI/UX). */
export type AutoSelectionReason =
  /** Initial resolution picked the cheapest usable candidate. */
  | 'cheapest-available'
  /** Locked mode (Q5): provider balanced, model left to the native agent settings. */
  | 'models-locked'
  /** Failover hop: nearest-tier candidate on a different canonical provider. */
  | 'failover-similar'
  /** Nothing usable — degraded to `defaultRunner`; the run is attempted anyway. */
  | 'no-provider';

/** A resolved, launchable answer. `runner` is always concrete; `model` is `undefined` exactly
 *  when the runner should pick its own (locked mode, or a native-default candidate) — never
 *  `'auto'`, never `''`. */
export interface AutoSelection {
  runner: RunnerId;
  model?: string;
  /** The winning candidate — the tier and canonical provider the lifecycle line names. Absent on
   *  the `no-provider` degradation, which names no candidate. */
  candidate?: ProviderCandidate;
  reason: AutoSelectionReason;
}

/** The knobs, per spec Q6 minus `enabled` — an `autoProvider.enabled: false` host never calls
 *  this module (the caller resolves to `defaultRunner` itself), so the switch lives at the seam. */
export interface AutoProviderOptions {
  /** The degradation target, from config's `defaultRunner`. */
  defaultRunner: RunnerId;
  /** `agentModelsLocked()` — provider balancing only, no model flag on the wire (Q5). */
  locked?: boolean;
  /** Failover budget. `<= 0` turns failover off; the per-run spend check is the caller's. */
  maxFailovers: number;
  /** Canonical providers already exhausted on this run — grown monotonically across hops so a
   *  run can never hop back onto the account that just died (the ping-pong guard). */
  excludeProviders?: readonly string[];
}

/**
 * Tier of a model id by shape, 1 cheapest … 5 dearest, {@link UNKNOWN_MODEL_TIER} for anything the
 * table does not recognize — never a refusal (Q1: a model cezar cannot price is still rankable).
 */
export function modelCostTier(model: string): number {
  const id = (model ?? '').toLowerCase();
  for (const entry of MODEL_COST_TIERS) {
    if (entry.pattern.test(id)) return entry.tier;
  }
  return UNKNOWN_MODEL_TIER;
}

/**
 * The tier a candidate RANKS at. Tier 0 deliberately does not sort ahead of the rated tiers: a
 * native default has no id cezar can price, and letting it win by construction would make the
 * whole table irrelevant on any host where one catalog is empty — the exact waste this feature
 * removes. "Unrated" competes at {@link UNKNOWN_MODEL_TIER}, the same fail-open mid tier Q1 gives
 * an unknown id: always in the running, never privileged. (Tier-0 candidates usually win on the
 * NEXT key anyway — `RUNNER_IDS` order — which is what keeps `codex`/`junie` reachable.)
 */
function rankTier(candidate: ProviderCandidate): number {
  return candidate.tier === NATIVE_DEFAULT_TIER ? UNKNOWN_MODEL_TIER : candidate.tier;
}

/**
 * Canonical provider for a backend-native model id on a runner — `model-identity.ts` is the single
 * parser, so the provider boundary of Q7 is the real one rather than a re-derived guess. A bare id
 * on a backend that spans providers (`opencode`, `pi`) is rejected loudly by
 * `resolveModelIdentity`; that refusal protects a LAUNCH, not a ranking, so it degrades here to
 * the explicit prefix, else the runner's own namespace — fail-open, matching Q1.
 */
function canonicalProvider(runner: RunnerId, model: string): string {
  const raw = model.trim();
  if (!raw) return BACKEND_MODEL_MAP[runner]?.defaultProvider ?? runner;
  try {
    const identity = resolveModelIdentity(runner, raw);
    return identity?.provider ?? parseModelIdentity(raw)?.provider ?? runner;
  } catch {
    return parseModelIdentity(raw)?.provider ?? runner;
  }
}

/**
 * Measured mean cost-weighted tokens per canonical `provider/model`, from the workspace's own past
 * runs. Below {@link MEASURED_HISTORY_MIN_SAMPLES} the mean is withheld entirely rather than
 * reported small — two noisy samples outranking a table tier is how a mis-ranked model becomes a
 * mis-ranked RUN. Absent history disables the tie-break, which is the correct cold-start posture:
 * the table carries the decision until the host has evidence.
 */
function meanTokensByModel(history?: readonly ModelUsageSample[]): Map<string, number> {
  const totals = new Map<string, { total: number; count: number }>();
  for (const sample of history ?? []) {
    const tokens = sample?.costWeightedTokens;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) continue;
    const provider = sample.provider?.trim().toLowerCase();
    const model = sample.model?.trim().toLowerCase();
    if (!provider || !model) continue;
    const key = `${provider}/${model}`;
    const current = totals.get(key) ?? { total: 0, count: 0 };
    current.total += tokens;
    current.count += 1;
    totals.set(key, current);
  }
  const means = new Map<string, number>();
  for (const [key, { total, count }] of totals) {
    if (count >= MEASURED_HISTORY_MIN_SAMPLES) means.set(key, total / count);
  }
  return means;
}

/** Discovery ids, deduped and in catalog order. A non-empty models array is the truth regardless
 *  of `source`: the catalog only fills `models` when it has an answer, and `unavailable` never
 *  carries ids — so the array alone decides, and a contradictory hand-built result fails open. */
function catalogModelIds(catalog: RunnerModelCatalogResult | undefined): string[] {
  const seen = new Set<string>();
  for (const option of catalog?.models ?? []) {
    const id = (option as ModelOption | undefined)?.id;
    if (typeof id === 'string' && id.trim() && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

interface EnumerationPolicy {
  locked: boolean;
  excluded: Set<string>;
  means: ReadonlyMap<string, number>;
}

function makeCandidate(
  runner: RunnerId,
  model: string,
  policy: EnumerationPolicy,
): ProviderCandidate {
  const provider = canonicalProvider(runner, model);
  const nativeDefault = model === NATIVE_DEFAULT_MODEL;
  const mean = nativeDefault ? undefined : policy.means.get(`${provider}/${model.toLowerCase()}`);
  return {
    runner,
    model,
    provider,
    tier: nativeDefault ? NATIVE_DEFAULT_TIER : modelCostTier(model),
    ...(mean === undefined ? {} : { meanTokens: mean }),
  };
}

/**
 * Every launchable candidate on the host, walked in `RUNNER_IDS` order so input order can never
 * move the winner (determinism is a spec requirement, not a nicety). Per usable runner, the model
 * list degrades through three grades — discovery, then the static presets, then the single
 * unrated native default — so a runner whose discovery is cold or absent stays in the running
 * without cezar inventing ids (spec "Candidate enumeration"). Locked mode (Q5) collapses each
 * runner to its native default up front: cezar still balances WHO serves the run, but no model is
 * ever pinned, because the lock's contract is "cezar does not choose the model". Providers in the
 * exclusion set — the exhausted accounts — are dropped last, after enumeration, so exclusion is a
 * property of the whole candidate, not of one enumeration grade.
 */
function enumerateCandidates(
  availability: ProviderAvailability | undefined,
  policy: EnumerationPolicy,
): ProviderCandidate[] {
  const candidates: ProviderCandidate[] = [];
  for (const runner of RUNNER_IDS) {
    const row = availability?.runners.find((entry) => entry?.provider?.provider === runner);
    if (!row || !isProviderUsable(row.provider)) continue;
    if (policy.locked) {
      candidates.push(makeCandidate(runner, NATIVE_DEFAULT_MODEL, policy));
      continue;
    }
    const catalog = catalogModelIds(row.catalog);
    const models = catalog.length > 0
      ? catalog
      : (KNOWN_PRESETS_BY_RUNNER[runner] ?? []);
    if (models.length > 0) {
      for (const model of models) candidates.push(makeCandidate(runner, model, policy));
      continue;
    }
    candidates.push(makeCandidate(runner, NATIVE_DEFAULT_MODEL, policy));
  }
  return candidates.filter((candidate) => !policy.excluded.has(candidate.provider));
}

/**
 * The Q1 ranking, as a total order: lowest (effective) tier, then measured meanTokens ascending
 * when both candidates have it, then `RUNNER_IDS` order, then id. Every comparison is total, so
 * the sort is stable under any host sort implementation and the same input always yields the same
 * winner. Within a tier, a candidate WITH measurement outranks one without — evidence over a
 * guess; the spec fixes only the both-present case, and the unmeasured side has already failed the
 * three-sample bar that would have made it evidence.
 */
function compareByCost(a: ProviderCandidate, b: ProviderCandidate): number {
  const tierDelta = rankTier(a) - rankTier(b);
  if (tierDelta !== 0) return tierDelta;
  if (a.meanTokens !== undefined && b.meanTokens !== undefined) {
    const tokenDelta = a.meanTokens - b.meanTokens;
    if (tokenDelta !== 0) return tokenDelta;
  } else if (a.meanTokens !== undefined) {
    return -1;
  } else if (b.meanTokens !== undefined) {
    return 1;
  }
  const runnerDelta = RUNNER_IDS.indexOf(a.runner) - RUNNER_IDS.indexOf(b.runner);
  if (runnerDelta !== 0) return runnerDelta;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  return 0;
}

/** Q7's similarity: distance between cost tiers is the primary key, so a hop lands on the nearest
 *  capability cezar can express — tier distance is the cheapest proxy for capability it has. */
function compareBySimilarity(failed: ProviderCandidate) {
  const failedTier = rankTier(failed);
  return (a: ProviderCandidate, b: ProviderCandidate): number =>
    Math.abs(rankTier(a) - failedTier) - Math.abs(rankTier(b) - failedTier) || compareByCost(a, b);
}

/** `''` never reaches a caller: the native-default sentinel becomes "no model", the one shape
 *  both the launch path (no flag) and the lock path (Q5) already speak. */
function toSelection(candidate: ProviderCandidate, reason: AutoSelectionReason): AutoSelection {
  return {
    runner: candidate.runner,
    ...(candidate.model === NATIVE_DEFAULT_MODEL ? {} : { model: candidate.model }),
    candidate,
    reason,
  };
}

function degradation(runner: RunnerId): AutoSelection {
  return { runner, reason: 'no-provider' };
}

/** Runtime-paranoid read of `options.defaultRunner` — a config file edited by hand can put
 *  anything in the field the type system thinks it knows, and this module may not throw. */
function defaultRunnerOf(options: AutoProviderOptions | undefined): RunnerId {
  const requested = options?.defaultRunner;
  if (requested && (RUNNER_IDS as readonly string[]).includes(requested)) return requested;
  return RUNNER_IDS[0] ?? 'claude';
}

function normalizeProviders(providers: readonly string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const provider of providers ?? []) {
    const id = provider?.trim().toLowerCase();
    if (id) normalized.add(id);
  }
  return normalized;
}

/**
 * Resolve `runner: 'auto'` against the host's actual availability. Returns the concrete runner +
 * model expected to cost the fewest cost-weighted tokens, or the `no-provider` degradation when
 * nothing usable remains — the caller turns that into the lifecycle note and launches anyway,
 * because a task that cannot start is never the right answer to "which provider is cheapest?".
 * Never throws (spec "Degradation").
 */
export function resolveAutoSelection(
  availability: ProviderAvailability | undefined,
  options: AutoProviderOptions,
): AutoSelection {
  try {
    const policy: EnumerationPolicy = {
      locked: options?.locked === true,
      excluded: normalizeProviders(options?.excludeProviders),
      means: meanTokensByModel(availability?.history),
    };
    const winner = enumerateCandidates(availability, policy).sort(compareByCost)[0];
    if (!winner) return degradation(defaultRunnerOf(options));
    return toSelection(winner, policy.locked ? 'models-locked' : 'cheapest-available');
  } catch {
    return degradation(defaultRunnerOf(options));
  }
}

/**
 * The failover half (spec Q7): given the candidate that hit its usage limit, pick the nearest-tier
 * candidate on a DIFFERENT canonical provider, or `null` when none qualifies — the caller's signal
 * to keep the existing wait-for-reset behavior. The failed provider is excluded here even if the
 * caller has not yet recorded it, so "different provider" holds by construction rather than by
 * contract; `null` — including on any internal error — means "fail over nowhere", which is the
 * only safe direction for a hop that would otherwise bill a fresh context against the same
 * exhausted account.
 */
export function pickFailoverSelection(
  failed: ProviderCandidate | undefined,
  availability: ProviderAvailability | undefined,
  options: AutoProviderOptions,
): AutoSelection | null {
  try {
    if (!options || !Number.isFinite(options.maxFailovers) || options.maxFailovers <= 0) return null;
    const failedProvider = failed?.provider?.trim().toLowerCase();
    if (!failed || !failedProvider) return null;
    const policy: EnumerationPolicy = {
      locked: options.locked === true,
      excluded: normalizeProviders(options.excludeProviders),
      means: meanTokensByModel(availability?.history),
    };
    policy.excluded.add(failedProvider);
    const winner = enumerateCandidates(availability, policy).sort(compareBySimilarity(failed))[0];
    return winner ? toSelection(winner, 'failover-similar') : null;
  } catch {
    return null;
  }
}
