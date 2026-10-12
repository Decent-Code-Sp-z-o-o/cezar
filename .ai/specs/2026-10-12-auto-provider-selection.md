# Auto provider selection — cheapest capable model, failover across providers

> Depends on: `2026-08-03-auto-resume-after-usage-limit.md` (the usage-limit parser and the auto-resume scheduling this feature retargets)

## TLDR

A task can now ask for a provider instead of naming one: `runner: 'auto'` — the composer's runner picker gains **Auto**, and `cez task create` accepts `--runner auto`. At launch cezar resolves `auto` to the concrete provider + model expected to consume the fewest cost-weighted tokens among the providers that are actually usable on this host, and persists the resolved runner on the record. When the resolved provider runs out mid-run (a usage-limit hit with a known reset), the run fails over to the nearest similar model on a **different** provider instead of parking until the window reopens — the existing wait-for-reset behavior remains the fallback when no alternative exists. Goal: keep every task and subtask running, on the cheapest model that can do the work.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | What does "lowest token usage" mean when no provider publishes prices cezar can read? | A coarse **cost-tier table** (1 cheapest … 5 dearest) over model-id shapes, tie-broken by the **measured** mean cost-weighted tokens of the workspace's own past runs per model (when ≥ 3 samples exist), then `RUNNER_IDS` order. Unknown ids default to tier 3. | No live pricing API exists in cezar and adding one would be a second feature. Tiers are coarse but honest, the measured tie-break corrects the table toward this host's reality, and tier 3 for unknowns fails open — a model cezar cannot price is never refused. |
| Q2 | Does `'auto'` join `RUNNER_IDS`? | **No.** `RUNNER_IDS` stays the concrete runners. `'auto'` is accepted at intake surfaces only (web composer, dispatch intent, server start schema, automations) and is resolved to a concrete runner before launch. Persisted records never carry `'auto'` — `storedRunnerSchema` is untouched. | Adding `'auto'` to the single source of truth would ripple into the runner factory, catalogs and every `z.enum(RUNNER_IDS)` and make "a runner named auto" leak into launches. Resolution at exactly two call sites (initial launch, failover) keeps the concrete world concrete. |
| Q3 | Fail over, or wait for the reset the provider named? | If the reset is **≤ 10 min** away, keep the existing auto-resume wait (the alternative cannot start meaningfully sooner). Otherwise fail over **immediately** when a candidate on a different provider exists; with no alternative, the existing wait is unchanged. | A five-hour window parked on one account while three others sit connected is exactly the waste this feature removes. But failing over for a ten-minute wait spends a fresh context re-reading the worktree to save minutes — the wait is cheaper. |
| Q4 | What counts as an available candidate? | A runner whose provider auth is usable (`isProviderUsable`: enabled + connected) and that can name at least one model — a live/ cached catalog, or its own static presets when discovery has nothing. | `provider-availability.ts` and `RunnerModelCatalog` already answer both halves; the resolver composes them instead of re-deriving availability. |
| Q5 | Does auto override `modelsLocked`? | **Partly.** With the lock on, auto still balances the provider (it may pick any runner) but sends **no model flag** — the native agent settings stay authoritative for the model, per `AGENT_MODELS_LOCKED_ERROR`. | The lock's contract is "cezar does not choose the model", not "cezar does not choose the provider". Silently refusing the whole feature would make `auto` the only runner selection the lock breaks. |
| Q6 | Where is it configured? | Machine config (`resources`, like auto-resume): `resources.autoProvider: { enabled?: boolean (default true), maxFailovers?: number (default 3), maxWaitMinutes?: number (default 10) }`. Per-task opt-in is the runner choice itself. | The exhaustion belongs to the account, not the repo — the same reasoning that put `autoResumeOnUsageLimit` in `resources`. `enabled: false` turns the whole feature off without touching any task definition. |
| Q7 | What makes two models "similar" across providers? | Distance between cost tiers first, then the canonical provider must differ from the failed one, then the standard ranking of Q1. The canonical provider comes from `model-identity.ts`, so `pi` serving `anthropic/claude-sonnet-5` and `claude` serving `sonnet` are the SAME provider and never fail over to each other. | "Similar" that ignored capability would fail over onto a toy model; "similar" that ignored the provider boundary would fail over onto the same exhausted account through a different CLI. Tier distance is the cheapest proxy for capability cezar has. |
| Q8 | What do dispatch children inherit? | The **request**, not the resolution: a parent running `auto` passes `--runner auto` to children, and each child resolves independently at its own launch. | Children launch minutes or hours after the parent; the account state that made `claude/sonnet` right at the parent's launch can be wrong by then. Re-evaluating is the whole point of the feature. |

## Problem Statement

Cezar speaks to seven backends, but a task definition must still name exactly one of them, and one model on it. The cost of that rigidity lands twice:

1. **Token waste by default.** The user must know which of `opus`/`sonnet`/`haiku`/`gpt-5.1-codex-mini`/… is the right size for each task, and must keep re-deciding as providers ship new models. Anything not hand-tuned defaults to a runner's own default — usually its dearest tier — because nothing cheaper is asked for.
2. **Dead time on exhaustion.** When the named provider's window closes, the run fails and — since 2026-08-03 — waits for THAT provider's reset. Overnight, that can be hours of a parked task while other providers on the same host sit connected and idle. For dispatch trees (a parent fan-out of subtasks), one exhausted account stalls the whole branch that inherited its runner.

Both costs are information cezar already has: the provider auth status, the per-runner model catalogs, the usage-limit reset instant, and per-run cost-weighted token history. Nothing composes them.

## Research

What exists, and what this spec reuses rather than rebuilds:

- **`RUNNER_IDS`** (`core/agent-runner.ts`) — the single source of truth for concrete runners: `claude, codex, opencode, cursor, pi, junie, copilot`. Every intake schema is `z.enum(RUNNER_IDS)` today (`server/server.ts` ×3, `workflows/types.ts`, `workflows/graph.ts` ×3, `automations/types.ts`, `config.ts` `defaultRunner`).
- **The composer's model `''` = auto** (`web/src/routes/new-task-form.ts`) — precedent for "auto" as a picker value that means "someone else decides later". Note it is auto *within* a runner; this spec adds auto *across* runners, one level up.
- **`RunnerModelCatalog`** (`core/runner-model-catalog.ts`) — host-level cached model discovery per runner (`live | cache | unavailable`, with failure cooldown). Adapters exist for claude, codex, cursor, junie, opencode.
- **`provider-auth.ts` / `provider-availability.ts`** — per-provider connection status; `isProviderUsable(row)` = enabled + connected.
- **`parseUsageLimit`** (`core/usage-limit.ts`) — terminal error → `{ resetAt, evidence } | null`, already the trigger of auto-resume.
- **Auto-resume** (`workflows/run.ts`, spec 2026-08-03) — `scheduleAutoResumeIfLimited` → `autoResumeAt` on the record + timer → `continueRun`. Failover hooks in exactly here: same trigger, one branch before the wait.
- **`costWeightedTokens`** (`core/usage.ts`) — cache-aware token weighting; per-run usage is already on run records, which makes the measured tie-break of Q1 a read, not a new measurement.
- **`model-identity.ts`** — canonical `{ provider, model }` per backend; the provider boundary that Q7's similarity needs.
- **`agent-model-policy.ts`** — `agentModelsLocked()` and its error string; Q5's exception.
- **`createRunner`** (`core/runner-factory.ts`) — the choke point every launch already funnels through; the resolver sits just above it.

## Proposed Solution

1. **Intake.** The runner intake surfaces widen from `z.enum(RUNNER_IDS)` to `z.enum([...RUNNER_IDS, 'auto'])` — the web composer's runner picker, the server's start-run/composer schemas, dispatch intents (`cez task create --runner auto`), workflow `agent` nodes, and automation definitions. Help text and the dispatch prompt advertise it. Nothing else about the surfaces changes: `'auto'` flows to the server like any runner value.
2. **Resolution at launch.** Exactly one new pure module, `core/provider-selection.ts`, answers "given the host's availability, which concrete runner + model should serve this run?". The `RunManager` calls it once on the initial-launch path when `runner === 'auto'`, before `createRunner`. The record stores the resolved concrete runner in `runner` (unchanged shape), the request in a new optional `runnerRequest: 'auto'`, and appends one lifecycle line naming the choice and why (tier). A resolution that cannot find any usable provider degrades to the configured `defaultRunner` with a lifecycle note — a task still runs; auto is an optimization, not a gate.
3. **Failover.** In the usage-limit path, before the existing auto-resume wait: if auto is in effect for the run (`runnerRequest === 'auto'`), the reset is further than `maxWaitMinutes`, a candidate exists on a **different canonical provider**, and `maxFailovers` is not spent — the run continues (through the ordinary `continueRun` path) on that candidate instead of waiting, with a lifecycle line per hop and `failoverCount` on the record. Otherwise the existing behavior runs untouched.
4. **Config.** `resources.autoProvider` (`enabled`, `maxFailovers`, `maxWaitMinutes`) with the Q6 defaults; off switches every resolution to the pre-feature behavior, per-task choice included.

## Architecture

### The resolver — `src/core/provider-selection.ts` (new)

Pure and injectable (clock, availability, catalogs, history all passed in) so the whole policy is unit-testable without a host:

```ts
export interface ProviderCandidate {
  runner: RunnerId;
  model: string;            // backend-native id ('sonnet', 'gpt-5.1-codex-mini', 'anthropic/claude-…')
  provider: string;         // canonical provider (model-identity), e.g. 'anthropic'
  tier: number;             // 1 cheapest … 5 dearest (0 = unrated native default)
  meanTokens?: number;      // measured mean cost-weighted tokens, when history has ≥ 3 samples
}

export interface AutoProviderOptions {
  defaultRunner: RunnerId;
  locked?: boolean;         // agentModelsLocked — provider balancing only, no model flag
  maxFailovers: number;
  excludeProviders?: readonly string[];   // providers already exhausted on this run
}

resolveAutoSelection(availability, options): AutoSelection
pickFailoverSelection(failed: ProviderCandidate, availability, options): AutoSelection | null
```

- **`MODEL_COST_TIERS`** — ordered matchers over model-id shapes (`haiku|mini|flash|low → 1`, `sonnet|codex(?!-mini)|medium → 2`, `opus|gpt-5(\D|$)|high → 3`, `max|ultra → 4`, unmatched → 3). Structural shapes, not dated ids — the same discipline as `NATIVE_MODEL_ID_PREFIX`. Exported for tests.
- **Ranking** — lowest tier wins; ties break by measured `meanTokens` ascending (when both have it), then `RUNNER_IDS` order, then id. Deterministic, no randomness.
- **Candidate enumeration** — for each runner with usable auth: catalog models when discovery has them, else the runner's own static presets (`KNOWN_PRESETS_BY_RUNNER` / the composer's fallback lists), else the single unrated native default (tier 0 — "the runner's own default is always a candidate", which is what keeps `codex` and `junie` — whose catalogs may be empty — in the running without cezar inventing ids).
- **`locked`** — candidates collapse to one per runner: the runner's native default, model never sent on the wire.
- **Degradation** — no usable candidate → `{ runner: defaultRunner, model: undefined, reason: 'no-provider' }`; the caller turns that into the lifecycle note. Never throws.

### Intake surfaces

- `web/src/routes/new-task-form.ts` — `Runner` union + `'auto'`; picker card **Auto — cezar picks the provider and model (cheapest)**; when auto is selected the model picker collapses to a single disabled "chosen at launch" row; `modelConflictsWithRunner` returns false for `'auto'` (it names no model).
- `server/server.ts` — the three start/composer runner schemas widen with `'auto'`; the start handler resolves before record creation, so the persisted record carries a concrete runner plus `runnerRequest`.
- `dispatch/task-cli.ts` + `dispatch/prompts.ts` — `--runner auto` accepted and advertised; the stored task order carries `'auto'`; the dispatch prompt's guidance gains one line: auto lets cezar pick the cheapest capable provider at launch and fail over on exhaustion.
- `automations/types.ts` + `automations/prompts.ts` + `automations/automation-cli.ts` — `runner: "auto"` valid in definitions; passed through to the run it starts.
- `workflows/types.ts` + `workflows/graph.ts` — `agent` node `runner` accepts `'auto'`; resolution happens at node launch on the same server path as above.

### Launch + failover — `RunManager` (`workflows/run.ts`)

- `resolveAutoRunner(runner, opts)` — the single server-side bridge to `resolveAutoSelection`; called from the start path (and graph node launches). Resolution result lands on the record: `runner` (concrete), `runnerRequest: 'auto'`, `resolvedModel` (when cezar pinned one), lifecycle line `auto → claude/sonnet (tier 2)`.
- **Failover** inside the usage-limit branch (`scheduleAutoResumeIfLimited`'s caller): the Q3 gate — auto in effect, `enabled`, reset − now > `maxWaitMinutes`, candidate on a different canonical provider, `failoverCount < maxFailovers` — then `continueRun(runId, …)` with an explicit runner/model override (the existing per-continue override point, already used by "run again on …"), `failoverCount + 1`, lifecycle line `usage limit until 21:04 — failing over to codex/gpt-5.1-codex-mini (tier 1)`. The failed provider joins `excludedProviders` for the rest of the run.
- **Record** (`runs/store.ts`) — additive optional fields: `runnerRequest?: 'auto'`, `failoverCount?: number`, `excludedProviders?: string[]`, `resolvedModel?: string`. Legacy records parse unchanged (`.passthrough()` store, optional fields).
- **Config** (`config.ts`) — `resources.autoProvider` per Q6, threaded through the existing semaphore/config-refresh path so flipping it takes effect without a restart (the same way `autoResumeOnUsageLimit` does).

### What deliberately does NOT change

- `RUNNER_IDS`, `createRunner`, every runner implementation, `storedRunnerSchema`.
- Manual runner/model selection — byte-for-byte the same path; `auto` is a pre-launch resolver, not a wrapper.
- Auto-resume for tasks that named a concrete runner — they keep waiting for their own provider (that is what the user chose).
- Cost accounting — usage already records per run per backend; failover hops are ordinary runs' continuations and bill where they ran.

## UI/UX

- **Runner picker** gains one card at the top: **Auto** — "Cheapest capable provider, chosen at launch; fails over if the provider runs out". Selecting it swaps the model picker for a single non-interactive row: *Model is chosen at launch, per availability*.
- **Run view**: when `runnerRequest === 'auto'`, the header pill reads `auto → claude/sonnet`; after a failover, `auto → codex/gpt-5.1-codex-mini (hop 1)`. Hover names the tier and the excluded providers.
- **Thread**: one lifecycle line per decision — the initial resolution (tier + why: `cheapest available`) and one per failover hop with the reset instant it is skipping. These are the audit trail; no separate settings surface beyond the existing `resources` config.
- **Dispatch**: the `cez task` UI shows the task's requested runner verbatim (`auto`), and the run it produced with its resolution — request and decision stay distinguishable.

## Edge Cases & Failure Scenarios

- **No provider usable** (no CLI logged in) — degrade to `defaultRunner`, lifecycle note `auto: nothing available — using default`; the run attempts anyway (today's behavior for an unauthenticated runner: fail loudly at launch, which is honest).
- **`modelsLocked` on** — provider balancing only, no model flag sent (Q5).
- **Catalogs unavailable everywhere** — static presets / native defaults keep every connected runner in the running (tier 0 candidates never require discovery).
- **Failover target also exhausted** — next candidate; the exhausted provider joins `excludedProviders`. Cap spent → existing auto-resume wait, plus a note.
- **Reset closer than `maxWaitMinutes`** — wait, not fail over (Q3).
- **Concrete-runner task hits a usage limit** — unchanged (never fails over; the user named the provider).
- **Child dispatch** — inherits the request `'auto'` and re-resolves at its own launch (Q8).
- **Restart mid-wait / mid-failover** — `runnerRequest` + `excludedProviders` are on the record, so `recover()` re-derives the same decision the same way auto-resume rebuilds its timers.
- **Unknown model id in a catalog** — tier 3, still rankable; never refused (Q1).
- **`autoProvider.enabled: false`** — `runner: 'auto'` resolves to `defaultRunner` with a note; no failover anywhere. Existing task definitions stay valid.

## Risks & Impact Review

- **Cost:** a failover hop is a real turn — a fresh context re-reading the worktree. Bounded by `maxFailovers` (3) and the Q3 near-reset window; every hop is a lifecycle line, so a runaway is visible in the thread immediately.
- **Wrong tiers** (the table mis-ranks a new model): fail-open tier 3 + measured-history tie-break; worst case is a dearer pick, never a broken run — and the table is structural, so it ages the way `NATIVE_MODEL_ID_PREFIX` does.
- **Failover ping-pong** between two providers both near their limits: `excludedProviders` grows monotonically per run, and the cap bounds hops regardless.
- **Rollback:** `'auto'` at any intake resolves to `defaultRunner` once the resolver is bypassed; the new record fields are optional and unread keys to old code; the config key round-trips through `.passthrough()`.

## Testability

- `core/provider-selection.test.ts` — pure-unit: tier mapping shapes, ranking + tie-breaks (measured history, `RUNNER_IDS` order), locked mode, exclusion of exhausted providers, failover similarity (different canonical provider required; `pi`-serving-anthropic must NOT fail over to `claude`), degradation, determinism.
- Intake tests — composer (`auto` card, model picker collapse, no cross-runner conflict), server start schema (`'auto'` accepted, resolution called, record carries concrete runner + `runnerRequest`), task CLI (`--runner auto` accepted and stored), automations schema.
- Failover path — the `mock:limit` harness from spec 2026-08-03 drives a usage-limit failure with a reset hours out and asserts the run continues on a different provider with `failoverCount: 1`, and waits (unchanged) when the reset is inside `maxWaitMinutes`, when auto is off, and when the cap is spent.
