import { useAgentProfiles, useConfig, useRunnerModels } from '@/api/queries'
import { DEFAULT_AGENT_ACCOUNT_ID, type ApiRun } from '@open-mercato/cezar-api-client'
import { PickerPill } from '@/components/picker-pill'
import { modelsForRunner } from '@/routes/new-task-form'

/** Bare model id from a canonical `provider/model` identity (or the raw string if it is not one). */
export function modelNameFromIdentity(identity: string | undefined): string | undefined {
  if (!identity) return undefined
  const slash = identity.indexOf('/')
  return slash > 0 ? identity.slice(slash + 1) : identity
}

/**
 * The model a run with no pinned `model` is actually being served by — launch pin first, then
 * the canonical identity on the record, then the latest step that recorded one (a Continue can
 * rewrite the step without the run-level field having landed yet).
 */
export function servingModelForAuto(run: ApiRun): string | undefined {
  if (run.resolvedModel) return run.resolvedModel
  const fromRun = modelNameFromIdentity(run.modelIdentity)
  if (fromRun) return fromRun
  const stepIdentity = [...run.steps].reverse().find((step) => step.modelIdentity)?.modelIdentity
  return modelNameFromIdentity(stepIdentity)
}

/**
 * Label for the model chip / badge when the composer left the model on auto: keep the "auto"
 * request visible and name what is serving (`auto - Qwen3.8-27B`). A pinned model stays as-is.
 */
export function autoModelBadgeLabel(askedModel: string | undefined, serving: string | undefined): string {
  if (askedModel) return askedModel
  if (serving && serving !== 'auto') return `auto - ${serving}`
  return 'auto'
}

/**
 * Which agent, account and model a run is ON — the one resolution the header's agent badge and
 * the composer's read-only engine pills both read, so the two can never name different engines.
 */
export function useRunEngine(run: ApiRun) {
  // The record keeps only what the caller ASKED for: `POST /api/runs` persists the raw optional
  // `runner` (`src/runs/store.ts`), while the run actually executes as
  // `input.runner ?? config.defaultRunner` (`src/workflows/run.ts`). Mirror that resolution —
  // hardcoding 'claude' would name the wrong agent on a repo whose `defaultRunner` is
  // codex/opencode. 'claude' stays the last resort only while the active project's config is in
  // flight. (`/api/health` describes the boot project and can name the wrong runner on scoped
  // routes.)
  const config = useConfig()
  const profiles = useAgentProfiles()
  const runner = run.runner ?? config.data?.defaultRunner ?? 'claude'
  // What the composer pinned (absent = auto). The serving id is separate so the badge can keep
  // naming the ask while revealing what launched / what the backend reported.
  const serving = servingModelForAuto(run)
  const model = run.model ?? run.resolvedModel ?? 'auto'
  const modelBadge = autoModelBadgeLabel(run.model, serving)
  // The auto REQUEST (spec 2026-10-12-auto-provider-selection): the record keeps the ask and the
  // decision as two things — `runnerRequest` is the literal `'auto'`, `runner`/`resolvedModel`
  // the launch's answer, `failoverCount`/`excludedProviders` what the exhaustion cost. The badge
  // names both halves because that is the honest history of the run.
  const requestedAuto = run.runnerRequest === 'auto'
  const hops = run.failoverCount ?? 0
  const excluded = run.excludedProviders ?? []
  // The account is read from the STEP that actually spawned, never from the run's composer
  // override or the project's current selection (spec 2026-07-29-agent-profiles): the override is
  // absent whenever the run just followed the project, and the project's selection can have been
  // changed since — both would name an account this run may never have touched. The last step that
  // recorded one is what ran; `sessionId` and `profileId` are a pair for exactly this reason.
  const accountId = [...run.steps].reverse().find((step) => step.profileId)?.profileId
  const account = accountId === undefined
    ? undefined
    : accountId === DEFAULT_AGENT_ACCOUNT_ID
      ? 'default'
      // A deleted account still names the folder this run's sessions live in, so the id is shown
      // rather than swallowed — "gone" is the useful half of that answer.
      : profiles.data?.profiles.find((p) => p.id === accountId)?.label ?? `${accountId} (removed)`
  // Prefer the run-level identity; fall back to the latest step so a live Continue still answers
  // "what is serving?" before the run field is rewritten.
  const identityRaw =
    run.modelIdentity
    ?? [...run.steps].reverse().find((step) => step.modelIdentity)?.modelIdentity
  // The canonical `provider/model` (#405/#546): show only when it adds something the model / auto
  // badge line does not already say. Absent on pre-#405 records.
  const identity =
    identityRaw && identityRaw !== model && identityRaw !== modelBadge ? identityRaw : undefined
  // `auto → claude/haiku`, and after a failover `auto → codex/… (hop 1)` — with the exhausted
  // providers named, since a hop is exactly the kind of decision a reader wants the why of. The
  // cost tier stays in the thread's lifecycle line; the badge does not re-derive pricing.
  // Non-auto runs use the model badge label so a live "auto" chip that already names the serving
  // model does not read as a bare "auto" in the tooltip.
  const summary = requestedAuto
    ? `auto → ${runner}/${model}${hops > 0 ? ` (hop ${hops})` : ''}${excluded.length > 0 ? ` — ${excluded.join(', ')} excluded` : ''}`
    : [runner, account, modelBadge].filter(Boolean).join(' · ')
  return { runner, account, model, modelBadge, identity, summary, requestedAuto, hops, excluded }
}

/**
 * The composer's engine pills while there is nothing to pick: a live session cannot change engine
 * mid-turn, and a closed run with no session has nothing to reopen. Same chips as the editable
 * follow-up pills (`follow-up-engine.tsx`) in their read-only form, so the chat box always says
 * which agent and model it is talking to — and the editable pair simply takes their place once a
 * Continue can choose.
 */
export function RunEnginePills({ run }: { run: ApiRun }) {
  const engine = useRunEngine(run)
  // The catalog only turns the pinned / serving id into its display name ("opus" → "Opus 5.5"), so
  // the chip reads exactly as the editable one will once the session closes — and an auto ask that
  // has a serving id keeps the "auto - …" shape with the catalog's friendly name on the right.
  const catalog = useRunnerModels(engine.runner)
  const models = modelsForRunner(engine.runner, catalog.data, [run.model, run.resolvedModel])
  const serving = servingModelForAuto(run)
  const servingLabel = serving
    ? (models.find((preset) => preset.id === serving)?.label ?? serving)
    : undefined
  const modelLabel = run.model
    ? (models.find((preset) => preset.id === run.model)?.label ?? run.model)
    : autoModelBadgeLabel(undefined, servingLabel)
  const hint = 'The session’s engine — pick another when you continue it'
  return (
    <div data-slot="run-engine" className="flex flex-wrap items-center gap-1.5">
      <PickerPill
        slot="run-engine-runner"
        ariaLabel="Agent"
        label={engine.account && engine.account !== 'default' ? `${engine.runner} · ${engine.account}` : engine.runner}
        value={engine.runner}
        options={[]}
        onPick={() => {}}
        readOnly
        hint={hint}
      />
      <PickerPill
        slot="run-engine-model"
        ariaLabel="Model"
        label={modelLabel}
        value={engine.model}
        options={[]}
        onPick={() => {}}
        readOnly
        hint={engine.identity ? `${hint} (served as ${engine.identity})` : hint}
      />
    </div>
  )
}
