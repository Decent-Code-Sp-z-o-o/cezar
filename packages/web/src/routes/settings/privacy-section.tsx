import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRightIcon } from 'lucide-react'

import { putTelemetryConsent } from '@/api/client'
import { useTelemetryConsent, workspaceQueryKeys } from '@/api/queries'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { resetSid } from '@/lib/sid'
import { CardNote, FormRow, SettingsCard, useSavedFlash } from './form-row'

/** cezar's own write-up of what is sent and what never leaves the machine (docs/telemetry.md). */
const TELEMETRY_DOC_URL = 'https://github.com/open-mercato/cezar/blob/main/docs/telemetry.md'

/**
 * Settings → Data & privacy → Privacy: the standing telemetry answer (docs/telemetry.md).
 * GLOBAL — consent belongs to the machine's `~/.cezar/config.json`, not to a repo. Off until
 * switched on; switching off deletes the install id. This is the only place the cockpit offers
 * the choice: opting in happens here or through `cezar telemetry enable`, nowhere unprompted.
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
  const [saved, flash] = useSavedFlash()
  const data = consent.data
  const blockedBy = data?.blockedBy ?? null

  const onToggle = (next: boolean) => {
    setSaving(true)
    void setConsent(next ? 'granted' : 'denied')
      .then(flash)
      .finally(() => setSaving(false))
  }

  return (
    <SettingsCard slot="privacy-section" title="Privacy">
      <FormRow
        htmlFor="telemetry-enabled"
        saved={saved}
        label="Share usage data"
        description={
          <>
            Task counts and crash reports, sent to cezar’s maintainers at Open Mercato
            {data ? <> (<span className="font-mono text-label">{data.endpoint}</span>)</> : null}. Never
            prompts, code, diffs, paths or repository names. Off unless you turn it on; turning it
            off deletes this machine’s install id.{' '}
            <a
              href={TELEMETRY_DOC_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Exactly what is collected
              <ArrowUpRightIcon className="size-3" aria-hidden="true" />
            </a>
          </>
        }
      >
        <Switch
          id="telemetry-enabled"
          data-slot="telemetry-toggle"
          checked={data?.consent === 'granted'}
          disabled={!data || saving}
          onCheckedChange={onToggle}
        />
      </FormRow>

      {blockedBy === 'env' ? (
        <CardNote slot="telemetry-blocked">
          <code className="font-mono text-label">CEZ_TELEMETRY=0</code> or{' '}
          <code className="font-mono text-label">DO_NOT_TRACK=1</code> is set for this server, so
          nothing is sent whatever this switch says.
        </CardNote>
      ) : blockedBy === 'automation' ? (
        <CardNote slot="telemetry-blocked">
          This server runs under CI, a test runner or <code className="font-mono text-label">CEZ_DRY_RUN=1</code>,
          so nothing is sent from it.
        </CardNote>
      ) : null}
    </SettingsCard>
  )
}
