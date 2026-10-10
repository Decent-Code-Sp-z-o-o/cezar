/**
 * The `/terminal` Suspense fallback — the static page header while the lazy chunk
 * (xterm.js is its own bundle) loads. A separate lightweight module on purpose:
 * importing it must not pull xterm into the main bundle (mirrors skills-loading.tsx).
 */
export function TerminalLoading() {
  return (
    <div data-route="terminal" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Terminal</h1>
        <p className="text-[13px] text-muted-foreground">A shell on the machine cezar runs on.</p>
      </header>
      <p data-slot="terminal-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
        Loading terminal…
      </p>
    </div>
  )
}
