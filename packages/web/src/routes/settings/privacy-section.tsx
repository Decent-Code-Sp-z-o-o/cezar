import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRightIcon } from 'lucide-react'

import { putTelemetryConsent } from '@/api/client'
import { useTelemetryConsent, workspaceQueryKeys } from '@/api/queries'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { resetSid } from '@/lib/sid'

/** cezar's own write-up of what is sent and what never leaves the machine (docs/telemetry.md). */
const TELEMETRY_DOC_URL = 'https://github.com/open-mercato/cezar/blob/main/docs/telemetry.md'

/**
 * Record an answer and put the server's reply in the cache every reader shares. Settings →
 * Privacy is the only place the cockpit offers the choice: opting in happens here or through
 * `cezar telemetry enable`, nowhere unprompted.
 */
function useSetTelemetryConsent() {
  const queryClient = useQueryClient()
  return React.useCallback(
    async (consent: 'granted' | 'denied') => {
      try {
        const next = await putTelemetryConsent({ consent })
        queryClient.setQueryData(workspaceQueryKeys.telemetryConsent, next)
        if (consent === 'denied') resetSid()
        return true
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        return false
      }
    },
    [queryClient],
  )
}

export function PrivacySection() {
  const consent = useTelemetryConsent()
  const setConsent = useSetTelemetryConsent()
  const [saving, setSaving] = React.useState(false)
  const data = consent.data
  const blockedBy = data?.blockedBy ?? null

  const onToggle = (next: boolean) => {
    setSaving(true)
    void setConsent(next ? 'granted' : 'denied').finally(() => setSaving(false))
  }

  return (
    <div
      data-slot="privacy-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <label htmlFor="telemetry-enabled">Share usage data</label>
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Task counts and crash reports, sent to cezar’s maintainers at Open Mercato
              {data ? <> (<span className="font-mono text-[12px]">{data.endpoint}</span>)</> : null}. Never
              prompts, code, diffs, paths or repository names. Off unless you turn it on; turning it
              off deletes this machine’s install id.
            </p>
          </div>
          <Switch
            id="telemetry-enabled"
            data-slot="telemetry-toggle"
            checked={data?.consent === 'granted'}
            disabled={!data || saving}
            onCheckedChange={onToggle}
          />
        </div>

        {blockedBy === 'env' ? (
          <p data-slot="telemetry-blocked" className="text-[13px] text-muted-foreground">
            <code className="font-mono text-[12px]">CEZ_TELEMETRY=0</code> or{' '}
            <code className="font-mono text-[12px]">DO_NOT_TRACK=1</code> is set for this server, so
            nothing is sent whatever this switch says.
          </p>
        ) : blockedBy === 'automation' ? (
          <p data-slot="telemetry-blocked" className="text-[13px] text-muted-foreground">
            This server runs under CI, a test runner or <code className="font-mono text-[12px]">CEZ_DRY_RUN=1</code>,
            so nothing is sent from it.
          </p>
        ) : null}

        <a
          href={TELEMETRY_DOC_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Exactly what is collected
          <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
        </a>
      </section>
    </div>
  )
}
