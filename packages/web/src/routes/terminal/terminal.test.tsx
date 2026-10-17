import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRoute } from './terminal'

/**
 * The view's own logic, with xterm.js faked: the capability gate (off — the
 * default — must render the enable hint and never open a socket), the session
 * lifecycle over the WS frames (server data → emulator, keystrokes → input
 * frames, exit → the New session affordance), and that unmount closes the
 * socket — which is what kills the PTY server-side.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above every top-level
 * `const` — the fakes must exist before the imports they stand in for.
 */
const { sessionMock, healthMock, scopeMock, FakeTerminal, FakeWebSocket } = vi.hoisted(() => {
  const sessionMock = vi.fn()
  const healthMock = vi.fn()
  const scopeMock = vi.fn()

  class FakeTerminal {
    static instances: FakeTerminal[] = []
    written: string[] = []
    /* Real xterm reports these from `fit()`; the fake just pins the defaults. */
    cols = 80
    rows = 24
    #dataHandler: ((data: string) => void) | undefined
    opened = false
    disposed = false
    constructor(public options: Record<string, unknown>) {
      FakeTerminal.instances.push(this)
    }
    loadAddon() {}
    open() {
      this.opened = true
    }
    focus() {}
    dispose() {
      this.disposed = true
    }
    onData(handler: (data: string) => void) {
      this.#dataHandler = handler
    }
    write(data: string) {
      this.written.push(data)
    }
    type(data: string) {
      this.#dataHandler?.(data)
    }
  }

  class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    static get last(): FakeWebSocket {
      return FakeWebSocket.instances.at(-1)!
    }
    /* Mirrors the real interface's constant — the view compares against it. */
    static OPEN = 1
    readyState = 0
    sent: string[] = []
    closed = false
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this)
    }
    open() {
      this.readyState = 1
      this.onopen?.()
    }
    receive(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) })
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {
      this.closed = true
      this.readyState = 3
      this.onclose?.()
    }
  }

  return { sessionMock, healthMock, scopeMock, FakeTerminal, FakeWebSocket }
})

vi.mock('@/api/client', () => ({ createTerminalSession: sessionMock }))
vi.mock('@/api/queries', () => ({ useHealth: healthMock }))
vi.mock('@/api/project-scope-context', () => ({ useProjectScope: scopeMock }))
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

const healthWith = (terminal: boolean) => ({
  isLoading: false,
  data: {
    version: 'test',
    projects: [],
    bootProject: 'default',
    repoRoot: '/repo',
    repo: null,
    defaultRunner: 'claude' as const,
    checks: [],
    forge: null,
    capabilities: {
      localHandoff: true,
      followups: false,
      singleProject: false,
      automations: false,
      dispatch: false,
      webTerminal: terminal,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    },
  },
})

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeTerminal.instances = []
  FakeWebSocket.instances = []
  scopeMock.mockReturnValue({ projectId: 'default', apiBase: '' })
  sessionMock.mockResolvedValue({ token: 'tok-1', wsPath: '/api/v1/p/default/terminal/ws' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('TerminalRoute', () => {
  it('renders the enable hint and opens nothing while the capability is off (the default)', async () => {
    healthMock.mockReturnValue(healthWith(false))
    render(<TerminalRoute />)
    expect(await screen.findByText('Terminal is disabled')).toBeTruthy()
    expect(screen.getByText(/CEZ_TERMINAL=1/)).toBeTruthy()
    expect(sessionMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('renders no terminal body while health is unknown — the nav honesty rule', () => {
    healthMock.mockReturnValue({ isLoading: true, data: undefined })
    const { container } = render(<TerminalRoute />)
    expect(container.querySelector('[data-route="terminal"]')).toBeTruthy()
    expect(screen.queryByText('Terminal is disabled')).toBeNull()
    expect(container.querySelector('[data-testid="terminal-container"]')).toBeNull()
    expect(sessionMock).not.toHaveBeenCalled()
  })

  it('mints a session, wires the socket, and pipes frames both directions', async () => {
    healthMock.mockReturnValue(healthWith(true))
    render(<TerminalRoute />)
    await waitFor(() => expect(FakeWebSocket.last).toBeDefined())
    expect(sessionMock).toHaveBeenCalledWith({ cols: expect.any(Number), rows: expect.any(Number) })
    expect(FakeWebSocket.last.url).toBe(`ws://${location.host}/api/v1/p/default/terminal/ws?token=tok-1`)

    FakeWebSocket.last.open()
    await waitFor(() => expect(screen.queryByText(/Starting a shell/)).toBeNull())

    FakeWebSocket.last.receive({ type: 'data', data: '$ ' })
    expect(FakeTerminal.instances.at(-1)!.written).toContain('$ ')

    FakeTerminal.instances.at(-1)!.type('ls -la')
    expect(FakeWebSocket.last.sent).toEqual([JSON.stringify({ type: 'input', data: 'ls -la' })])
  })

  it('shows the exit note and offers a fresh session when the PTY exits', async () => {
    healthMock.mockReturnValue(healthWith(true))
    render(<TerminalRoute />)
    await waitFor(() => expect(FakeWebSocket.last).toBeDefined())
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive({ type: 'exit', exitCode: 2 })
    expect(await screen.findByText(/Process exited \(code 2\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /New session/i }))
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(sessionMock).toHaveBeenCalledTimes(2)
  })

  it('closes the socket on unmount — the server-side signal to kill the PTY', async () => {
    healthMock.mockReturnValue(healthWith(true))
    const { unmount } = render(<TerminalRoute />)
    await waitFor(() => expect(FakeWebSocket.last).toBeDefined())
    unmount()
    expect(FakeWebSocket.last.closed).toBe(true)
  })
})
