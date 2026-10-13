import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { HealthResponse, TelemetryConsentPayload } from '@open-mercato/cezar-api-client'
import { AppShellContainer } from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * The cockpit never asks for telemetry consent. The opt-in bar that used to sit at the bottom of
 * the shell is gone on purpose (docs/telemetry.md): a machine that has never answered keeps
 * consent 'unknown', the server sends nothing, and the only place a person can still opt in is
 * Settings → Privacy. These tests pin the removal — the ask must not quietly grow back.
 */

const UNKNOWN: TelemetryConsentPayload = {
  consent: 'unknown',
  policyVersion: 1,
  blockedBy: null,
  endpoint: 'https://stats.openmercato.cloud',
}

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true,
  terminal: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false, dispatch: false },
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  document.title = 'cezar'
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the shell's breakpoint effect and the theme toggle need one.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  )
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  // Answer the endpoints the shell reads so it comes up like it would on a real machine. The
  // consent endpoint has no meaningful answer here: the shell must never ask for it (pinned below).
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const body =
      path === '/api/v1/health'
        ? HEALTH
        : path === '/api/v1/todos'
          ? []
          : path === '/api/v1/projects'
            ? { projects: [], bootProject: 'default', projectsDir: '/repos' }
            : path === '/api/v1/providers/status'
              ? { providers: [] }
              : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function renderShell(consent?: TelemetryConsentPayload) {
  const client = createQueryClient()
  // Seeded BEFORE the shell mounts, so any ask that did exist would see the unanswered machine.
  if (consent) client.setQueryData(workspaceQueryKeys.telemetryConsent, consent)
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
  return client
}

const banner = () => document.querySelector('[data-slot="telemetry-consent-banner"]')
const detailsDialog = () => document.querySelector('[data-slot="telemetry-details-dialog"]')
const askedTelemetry = () => fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('telemetry'))

describe('the shell never asks for telemetry consent', () => {
  it('renders no consent bar for an unanswered machine that nothing blocks', async () => {
    renderShell(UNKNOWN)

    await screen.findByText('route content')
    expect(banner()).toBeNull()
    expect(detailsDialog()).toBeNull()
    expect(screen.queryByText('Help improve cezar?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Share usage data' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Don’t share' })).toBeNull()
  })

  it('renders no consent bar while the consent answer has not arrived either', async () => {
    // The query cache is empty: consent is unknown because nobody has answered, not because the
    // server said so. Still no ask — an unanswered machine is simply never asked again.
    renderShell()

    await screen.findByText('route content')
    expect(banner()).toBeNull()
    expect(detailsDialog()).toBeNull()
  })

  it('neither reads nor writes the consent endpoint from the shell', async () => {
    renderShell(UNKNOWN)

    await screen.findByText('route content')
    // Removing the bar removed its only reader in the shell: consent stays wherever the server
    // keeps it, and nothing here can PUT an answer on the user's behalf.
    expect(askedTelemetry()).toEqual([])
  })
})
