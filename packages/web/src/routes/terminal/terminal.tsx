import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RotateCcwIcon, SquareTerminalIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { createTerminalSession } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The web Terminal tab (spec `.ai/specs/2026-10-10-terminal-tab.md`): a PTY in
 * the project root on the machine the cezar server runs on, bridged over a
 * single-use token to one WebSocket this view owns. The session exists only
 * while the view is mounted — navigating away kills the shell, by design.
 *
 * Gating follows the nav's honesty rule: while `/api/health` has not answered
 * the body renders nothing; `capabilities.webTerminal === false` (the default —
 * the feature is opt-in via `CEZ_TERMINAL=1`) renders the enable hint instead
 * of a dead terminal. Distinct from `capabilities.terminal`, the task
 * workspace's terminal, which shares the env var but rides on by default.
 */

type Phase = 'connecting' | 'open' | 'exited' | 'disconnected' | 'error'

/** Terminal frames — the server-side protocol (`packages/cezar/src/server/terminal.ts`),
 *  deliberately NOT part of the HTTP contract, like the `/api/v1/ws` bus frames. */
type ServerFrame =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; error: string }

export function TerminalRoute() {
  const health = useHealth()
  const enabled = health.data?.capabilities?.webTerminal === true

  return (
    <div data-route="terminal" className="flex h-full min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Terminal". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Terminal</h1>
        <p className="text-[13px] text-muted-foreground">A shell on the machine cezar runs on.</p>
      </header>
      {health.isLoading || health.data === undefined ? null : enabled ? (
        <TerminalSessionView />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <CenteredState
            icon={<SquareTerminalIcon className="size-9" />}
            title="Terminal is disabled"
            subtitle="Set CEZ_TERMINAL=1 in the environment of the cezar server and restart it to enable a shell on that machine."
          />
        </div>
      )}
    </div>
  )
}

/** The dark surface stays dark in both appearance modes — a terminal is one of
 *  the few places where that is the honest default (ANSI colors assume it). */
const TERMINAL_THEME = {
  background: '#0b0b0e',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  selectionBackground: '#3b3b46',
}

function TerminalSessionView() {
  const { projectId } = useProjectScope()
  const [phase, setPhase] = useState<Phase>('connecting')
  const [note, setNote] = useState<string | null>(null)
  const [sessionKey, setSessionKey] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let socket: WebSocket | null = null

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: TERMINAL_THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    term.focus()

    // Re-fit on container resizes and keep the PTY's size in lockstep — a
    // full-screen program (vim, top) renders into whatever the window says.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch {
        // a transient mid-layout measure — the next resize corrects it
      }
    })
    observer.observe(container)

    createTerminalSession({ cols: term.cols, rows: term.rows })
      .then((session) => {
        if (disposed) return
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const opened = new WebSocket(
          `${protocol}//${location.host}${session.wsPath}?token=${encodeURIComponent(session.token)}`,
        )
        socket = opened
        opened.onopen = () => {
          if (!disposed) setPhase('open')
        }
        opened.onmessage = (event) => {
          let frame: ServerFrame
          try {
            frame = JSON.parse(String(event.data)) as ServerFrame
          } catch {
            return
          }
          if (frame.type === 'data') term.write(frame.data)
          else if (frame.type === 'exit') {
            setNote(`Process exited (code ${frame.exitCode}).`)
            setPhase('exited')
          } else if (frame.type === 'error') {
            setNote(frame.error)
          }
        }
        opened.onclose = () => {
          if (disposed) return
          setPhase((current) => {
            if (current === 'open') {
              setNote('Connection lost.')
              return 'disconnected'
            }
            return current
          })
        }
        term.onData((data) => {
          if (opened.readyState === WebSocket.OPEN) {
            opened.send(JSON.stringify({ type: 'input', data }))
          }
        })
      })
      .catch((err: unknown) => {
        if (disposed) return
        setNote(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })

    return () => {
      disposed = true
      observer.disconnect()
      // Closing the socket is what kills the PTY server-side (spec: a session
      // lives exactly as long as its socket).
      socket?.close()
      term.dispose()
    }
  }, [projectId, sessionKey])

  const restart = () => {
    setNote(null)
    setPhase('connecting')
    setSessionKey((key) => key + 1)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-[#0b0b0e]">
        <div
          ref={containerRef}
          data-testid="terminal-container"
          className="min-h-0 flex-1 p-2"
          onClick={(event) => {
            // Clicks land on xterm's own rows; focusing the container is not
            // enough — send the focus into the emulator so typing just works.
            const target = event.currentTarget.querySelector('.xterm-helper-textarea')
            if (target instanceof HTMLElement) target.focus()
          }}
        />
        {phase !== 'open' && (
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 border-b border-border/60 bg-background/95 px-3 py-1.5 text-[13px] backdrop-blur">
            <span className={cn('text-muted-foreground', phase === 'error' && 'text-danger')}>
              {note ?? (phase === 'connecting' ? 'Starting a shell…' : null)}
            </span>
            {(phase === 'exited' || phase === 'disconnected' || phase === 'error') && (
              <Button size="sm" variant="outline" onClick={restart}>
                <RotateCcwIcon className="size-3.5" />
                New session
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
