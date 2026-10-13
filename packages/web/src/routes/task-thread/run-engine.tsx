import { useAgentProfiles, useConfig, useRunnerModels } from '@/api/queries'
import { DEFAULT_AGENT_ACCOUNT_ID, type ApiRun } from '@open-mercato/cezar-api-client'
import { PickerPill } from '@/components/picker-pill'
import { modelsForRunner } from '@/routes/new-task-form'

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
  // The model the run actually asked its backend for: the composer's pick, or — on an auto run —
  // the model the launch pinned (`resolvedModel`). Absent on both counts reads "auto".
  const model = run.model ?? run.resolvedModel ?? 'auto'
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
  // The canonical `provider/model` the run actually resolved to (#405), shown only when it says
  // something `model` does not (#546). Absent on pre-#405 records and skipped when it merely
  // repeats `model` — an identity nothing wrote down is not one a reader may invent.
  const identity = run.modelIdentity && run.modelIdentity !== model ? run.modelIdentity : undefined
  // `auto → claude/haiku`, and after a failover `auto → codex/… (hop 1)` — with the exhausted
  // providers named, since a hop is exactly the kind of decision a reader wants the why of. The
  // cost tier stays in the thread's lifecycle line; the badge does not re-derive pricing.
  const summary = requestedAuto
    ? `auto → ${runner}/${model}${hops > 0 ? ` (hop ${hops})` : ''}${excluded.length > 0 ? ` — ${excluded.join(', ')} excluded` : ''}`
    : [runner, account, model].filter(Boolean).join(' · ')
  return { runner, account, model, identity, summary, requestedAuto, hops, excluded }
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
  // The catalog only turns the pinned id into its display name ("opus" → "Opus 5.5"), so the chip
  // reads exactly as the editable one will once the session closes.
  const catalog = useRunnerModels(engine.runner)
  const models = modelsForRunner(engine.runner, catalog.data, [run.model])
  const modelLabel = models.find((preset) => preset.id === engine.model)?.label ?? engine.model
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
