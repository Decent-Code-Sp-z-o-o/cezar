import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { TelemetryConsentPayload } from '@open-mercato/cezar-api-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import { PrivacySection } from './privacy-section'

/**
 * Settings → Privacy is where telemetry consent lives now that the cockpit never asks (the old
 * bottom bar is gone). What must keep working: the switch reads the machine's answer, one flip
 * PUTs exactly that answer, withdrawing deletes this browser's device id, and a failed write
 * changes nothing.
 */

const CONSENT = '/api/v1/telemetry/consent'

const UNKNOWN: TelemetryConsentPayload = {
  consent: 'unknown',
  policyVersion: 1,
  blockedBy: null,
  endpoint: 'https://stats.openmercato.cloud',
}

let fetchMock: ReturnType<typeof vi.fn>

function mount(payload: TelemetryConsentPayload | undefined, reply?: Response) {
  fetchMock = vi.fn(async () => reply ?? new Response(JSON.stringify({ ...UNKNOWN, consent: 'granted' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  const client = createQueryClient()
  if (payload) client.setQueryData(workspaceQueryKeys.telemetryConsent, payload)
  render(
    <QueryClientProvider client={client}>
      <PrivacySection />
      <Toaster />
    </QueryClientProvider>,
  )
  return client
}

const toggle = () => screen.getByRole('switch') as HTMLButtonElement
const toast = () => document.querySelector('[data-slot="toast"]')
/** The consent write, wherever it landed in the request order — this section makes exactly one. */
const putCall = () =>
  fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT') as
    | [string, RequestInit]
    | undefined

beforeEach(() => {
  // `resetSid` clears this key; seed it so the withdrawal has something to delete.
  localStorage.setItem('cezar:sid', '018f0000-0000-7000-8000-000000000000')
})

afterEach(() => {
  cleanup()
  act(() => resetToasts())
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('PrivacySection', () => {
  it('offers the switch for an unanswered machine, and links the privacy notice', async () => {
    mount(UNKNOWN)

    await waitFor(() => expect(toggle()).toBeTruthy())
    expect(toggle().dataset.state).toBe('unchecked')
    expect(toggle().disabled).toBe(false)
    const link = screen.getByRole('link', { name: 'Exactly what is collected' }) as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/open-mercato/cezar/blob/main/docs/telemetry.md')
    // Unknown means never asked and never answered: nothing was written on the user's behalf.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('flipping on PUTs consent: granted', async () => {
    const client = mount(UNKNOWN)

    fireEvent.click(toggle())
    await waitFor(() =>
      expect(client.getQueryData<TelemetryConsentPayload>(workspaceQueryKeys.telemetryConsent)?.consent).toBe('granted'),
    )
    const [url, init] = putCall()!
    expect(url).toBe(CONSENT)
    expect(JSON.parse(String(init.body))).toEqual({ consent: 'granted' })
    expect(toggle().dataset.state).toBe('checked')
    // Opting in keeps the device id.
    expect(localStorage.getItem('cezar:sid')).not.toBeNull()
  })

  it('flipping off PUTs consent: denied, and forgets this browser’s device id', async () => {
    const client = mount(
      { ...UNKNOWN, consent: 'granted' },
      new Response(JSON.stringify({ ...UNKNOWN, consent: 'denied' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    fireEvent.click(toggle())
    await waitFor(() =>
      expect(client.getQueryData<TelemetryConsentPayload>(workspaceQueryKeys.telemetryConsent)?.consent).toBe('denied'),
    )
    expect(JSON.parse(String(putCall()![1].body))).toEqual({ consent: 'denied' })
    expect(localStorage.getItem('cezar:sid')).toBeNull()
    expect(toggle().dataset.state).toBe('unchecked')
  })

  it('keeps the standing answer and the device id when the write fails', async () => {
    const client = mount(
      { ...UNKNOWN, consent: 'granted' },
      new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    )

    fireEvent.click(toggle())
    await waitFor(() => expect(toast()).not.toBeNull())
    expect(toast()!.textContent).toContain('down')
    // The cache still says what the machine last answered, and the switch says so.
    expect(client.getQueryData<TelemetryConsentPayload>(workspaceQueryKeys.telemetryConsent)?.consent).toBe('granted')
    expect(toggle().dataset.state).toBe('checked')
    expect(localStorage.getItem('cezar:sid')).not.toBeNull()
    expect(putCall()![0]).toBe(CONSENT)
  })

  it('labels the env block when the server would not send anyway', () => {
    mount({ ...UNKNOWN, blockedBy: 'env' })

    expect(screen.getByText('CEZ_TELEMETRY=0')).toBeTruthy()
    expect(screen.queryByText('CEZ_DRY_RUN=1')).toBeNull()
  })
})
