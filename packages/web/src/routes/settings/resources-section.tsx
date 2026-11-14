import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { IntegerStepper } from '@/components/integer-stepper'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard, useSavedFlash } from './form-row'

/**
 * Settings → Behaviour → Limits, Monitoring and New task defaults: how hard the MACHINE works.
 * `maxParallel` caps concurrent tasks across every project (the workspace semaphore holds the
 * rest); `memoryLimitMb` is the per-task ceiling the engine enforces by pausing a task that
 * crosses it and letting the queue advance (#memory-guard).
 *
 * Workspace-level since the multi-project split (spec §"Resource governance"): they protect the
 * host, not a repo, so they live in `~/.cezar/config.json` and persist through
 * `PUT /api/workspace/config` — the merged answer lands straight in the workspace config query,
 * and the server refreshes the shared semaphore so a change takes effect without a restart.
 *
 * Worktree retention stayed behind in the PROJECT settings (worktrees-section.tsx) — it sizes
 * one repo's own worktree pool, which is a property of the repo.
 */

const MAX_PARALLEL_MIN = 1
const MAX_PARALLEL_MAX = 16
const MAX_MONITORING_MAX = 16
const IDLE_TIMEOUT_MAX = 1440
const WAKE_INTERVAL_MIN = 1
const WAKE_INTERVAL_MAX = 60
const FAILOVERS_MAX = 12
const WAIT_MINUTES_MAX = 240
/** Below this a limit would pause almost any real agent immediately — reject it as a footgun. */
const MEMORY_MIN_MB = 256
/** A ceiling only so the stepper has one — 1 TiB is past any host this runs on. */
const MEMORY_MAX_MB = 1_048_576
/** Where the arrows start from an empty (no-limit) field: a sane first limit, not the floor. */
const MEMORY_STEP_FROM_MB = 2048
/** The arrows move the memory limit in 256 MiB steps, as main's number input did. */
const MEMORY_STEP_MB = 256

export function ResourcesCards() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <LoadingState label="Loading resource settings…" data-slot="resources-loading"><SettingsSkeleton /></LoadingState>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        tone="danger"
        title="Resource settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <ResourcesForm config={config.data} />
}

function ResourcesForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const [saved, flash] = useSavedFlash()
  const [savedKey, setSavedKey] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      // Which row flashes "Saved": the one key the patch carried.
      setSavedKey(Object.keys({ ...patch.resources, ...patch.composerDefaults })[0] ?? null)
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const savedFor = (key: string) => saved && savedKey === key

  const configuredWake = config.resources.monitoringWakeIntervalMinutes ?? null
  const wakeMode: 'park' | 'interval' = configuredWake === null ? 'park' : 'interval'
  const saveWake = (minutes: number | null) =>
    save.mutateAsync({ resources: { monitoringWakeIntervalMinutes: minutes } })
  // Shipped ON: a server that predates the key answers without it, and reading that as "off"
  // would silently disable the feature on the one client that cannot tell the difference.
  const autoResume = config.resources.autoResumeOnUsageLimit ?? true
  // Same shipped-ON reasoning (spec 2026-10-12-auto-provider-selection, Q6 defaults).
  const autoProvider = config.resources.autoProvider
  const autoProviderEnabled = autoProvider?.enabled ?? true
  const composerDefaults = config.composerDefaults ?? {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent' as const,
    inheritedWorktree: true,
  }
  const saveComposerDefault = (key: 'autonomous' | 'worktree', value: string) =>
    save.mutate({ composerDefaults: { [key]: value === 'inherit' ? null : value === 'on' } })
  const triState = (value: boolean | null) => (value === null ? 'inherit' : value ? 'on' : 'off')

  return (
    <div data-slot="resources-section" className="flex flex-col gap-5">
      <SettingsCard id="limits" title="Limits">
        <FormRow
          saved={savedFor('maxParallel')}
          label="Max parallel tasks"
          description={
            <>
              How many tasks run at once across every project. The rest wait in the queue. A non-git
              directory always runs one at a time. Need a different limit for one project?{' '}
              <Link
                to="/settings/global/projects"
                data-slot="resources-project-limits-link"
                className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
              >
                Configure per-project limits
              </Link>
              .
            </>
          }
        >
          <IntegerStepper
            aria-label="Max parallel tasks"
            data-slot="resources-max-parallel"
            value={config.resources.maxParallel}
            min={MAX_PARALLEL_MIN}
            max={MAX_PARALLEL_MAX}
            onCommit={(maxParallel) => save.mutateAsync({ resources: { maxParallel: maxParallel ?? MAX_PARALLEL_MIN } })}
          />
        </FormRow>

        {/* The auto provider's knobs (fork, spec 2026-10-12-auto-provider-selection): what an
            `auto` task may spend on provider changes and how far a reset must be before waiting
            beats re-reading the worktree. Applied without a restart. */}
        <FormRow
          label="Auto provider selection"
          description="A task set to Auto picks the cheapest capable provider at launch, and when that provider runs out the run continues on a similar model from a different one instead of waiting the window out. A task naming a specific backend never hops."
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Auto provider selection"
              data-slot="resources-auto-provider"
              value={autoProviderEnabled ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(event) => save.mutate(
                { resources: { autoProvider: { enabled: event.target.value === 'on' } } },
                {
                  onSuccess: () => toast(
                    event.target.value === 'on'
                      ? 'Auto tasks pick the cheapest capable provider and fail over on exhaustion'
                      : 'Auto tasks use the default backend and never fail over',
                  ),
                },
              )}
              className="block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <IntegerStepper
              aria-label="Failover hops per run"
              data-slot="resources-auto-provider-max-failovers"
              value={autoProvider?.maxFailovers ?? 3}
              min={0}
              max={FAILOVERS_MAX}
              onCommit={(maxFailovers) => save.mutateAsync({ resources: { autoProvider: { maxFailovers: maxFailovers ?? 0 } } })}
            />
            <span className="text-label text-muted-foreground">hops</span>
            <IntegerStepper
              aria-label="Fail over only when the reset is further away than"
              data-slot="resources-auto-provider-max-wait"
              value={autoProvider?.maxWaitMinutes ?? 10}
              min={0}
              max={WAIT_MINUTES_MAX}
              onCommit={(maxWaitMinutes) => save.mutateAsync({ resources: { autoProvider: { maxWaitMinutes: maxWaitMinutes ?? 0 } } })}
            />
            <span className="text-label text-muted-foreground">min reset</span>
          </div>
        </FormRow>

        <FormRow
          saved={savedFor('maxMonitoringSessions')}
          label="Extra monitoring sessions"
          description={`How many agent sessions may wait on CI, sub-agents, or monitored commands without using an active task slot. Capacity: ${config.resources.maxParallel} active + ${config.resources.maxMonitoringSessions ?? 2} monitoring. Set 0 to make monitoring share active slots.`}
        >
          <IntegerStepper
            aria-label="Extra monitoring sessions"
            data-slot="resources-max-monitoring"
            value={config.resources.maxMonitoringSessions ?? 2}
            min={0}
            max={MAX_MONITORING_MAX}
            onCommit={(sessions) => save.mutateAsync({ resources: { maxMonitoringSessions: sessions ?? 0 } })}
          />
        </FormRow>

        <FormRow
          saved={savedFor('idleTimeoutMinutes')}
          label="Waiting-session idle timeout"
          description="Minutes a plain waiting session may stay open without activity before its live backend session ends. Continue resumes it; 0 keeps it open indefinitely. Monitoring sessions are already exempt."
        >
          <IntegerStepper
            aria-label="Waiting-session idle timeout"
            data-slot="resources-idle-timeout"
            value={config.resources.idleTimeoutMinutes ?? 0}
            min={0}
            max={IDLE_TIMEOUT_MAX}
            onCommit={(minutes) => save.mutateAsync({ resources: { idleTimeoutMinutes: minutes ?? 0 } })}
          />
        </FormRow>

        <FormRow
          saved={savedFor('memoryLimitMb')}
          label="Per-task memory limit"
          description="When a task’s whole process tree crosses this, the engine pauses it with a warning and starts the next queued task. Leave empty for no limit. Applies to newly started tasks."
        >
          <IntegerStepper
            aria-label="Per-task memory limit in MiB"
            data-slot="resources-memory-limit"
            value={config.resources.memoryLimitMb || null}
            min={MEMORY_MIN_MB}
            max={MEMORY_MAX_MB}
            allowEmpty
            emptyStepFrom={MEMORY_STEP_FROM_MB}
            step={MEMORY_STEP_MB}
            placeholder="No limit"
            // An empty field commits `null`, which the route reads as "clear the limit".
            onCommit={(mib) => save.mutateAsync({ resources: { memoryLimitMb: mib } })}
          />
          <span className="text-label text-muted-foreground">MiB</span>
        </FormRow>
      </SettingsCard>

      <SettingsCard id="monitoring" title="Monitoring">
        <FormRow
          saved={savedFor('monitoringWakeIntervalMinutes')}
          label="Monitoring wake-up"
          description="Park uses no model turns. Re-check sends the same agent a follow-up on this cadence until work completes or the 40-wakeup safety cap is reached. Applied consistently to Claude, Codex and OpenCode."
        >
          <Select
            value={wakeMode}
            disabled={save.isPending}
            onValueChange={(value) => void saveWake(value === 'park' ? null : (configuredWake ?? 5))}
          >
            <SelectTrigger size="sm" aria-label="Monitoring wake-up" data-slot="resources-monitoring-wake-mode" data-value={wakeMode}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="park">Park until resumed</SelectItem>
              <SelectItem value="interval">Re-check on an interval</SelectItem>
            </SelectContent>
          </Select>
          {wakeMode === 'interval' ? (
            <>
              <IntegerStepper
                aria-label="Wake interval in minutes"
                data-slot="resources-monitoring-wake-interval"
                value={configuredWake}
                min={WAKE_INTERVAL_MIN}
                max={WAKE_INTERVAL_MAX}
                className="w-24"
                onCommit={(minutes) => saveWake(minutes ?? 5)}
              />
              <span className="text-label text-muted-foreground">min</span>
            </>
          ) : null}
        </FormRow>

        {/* `#auto-resume`: the task thread's "Auto-resume settings" link lands on this row. */}
        <FormRow
          id="auto-resume"
          saved={savedFor('autoResumeOnUsageLimit')}
          htmlFor="resources-auto-resume"
          label="Auto-resume after a usage limit"
          description="When an agent stops because its provider usage limit is reached, cezar waits for the reset the provider named and continues the task 30 seconds later — up to 12 times in a row without you. Off leaves the task failed with its Continue button. Applies to Claude, Codex and OpenCode."
        >
          <Switch
            id="resources-auto-resume"
            data-slot="resources-auto-resume"
            checked={autoResume}
            disabled={save.isPending}
            onCheckedChange={(on) => save.mutate({ resources: { autoResumeOnUsageLimit: on } })}
          />
        </FormRow>
      </SettingsCard>

      <SettingsCard id="new-task-defaults" slot="resources-composer-defaults" title="New task defaults">
        <FormRow
          saved={savedFor('autonomous')}
          label="Autonomous by default"
          description={`Inherited: ${
            composerDefaults.inheritedAutonomous === 'source-dependent'
              ? 'source-dependent — skills on, workflows off'
              : composerDefaults.inheritedAutonomous ? 'on' : 'off'
          }. Explicit choices and run-shape constraints still win.`}
        >
          <TriStateSelect
            label="Autonomous by default"
            value={triState(composerDefaults.autonomous)}
            disabled={save.isPending}
            onChange={(value) => saveComposerDefault('autonomous', value)}
          />
        </FormRow>
        <FormRow
          saved={savedFor('worktree')}
          label="Use a worktree by default"
          description={`Inherited: ${composerDefaults.inheritedWorktree ? 'on' : 'off'}. Interactive skills may recommend both off; multi-step and parallel runs remain isolated.`}
        >
          <TriStateSelect
            label="Use a worktree by default"
            value={triState(composerDefaults.worktree)}
            disabled={save.isPending}
            onChange={(value) => saveComposerDefault('worktree', value)}
          />
        </FormRow>
        <CardNote>Set stable composer defaults across projects; a project's own Agents settings can still differ.</CardNote>
      </SettingsCard>
    </div>
  )
}

function TriStateSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: 'inherit' | 'on' | 'off'
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} data-value={value} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value="inherit">Inherit environment</SelectItem>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  )
}
