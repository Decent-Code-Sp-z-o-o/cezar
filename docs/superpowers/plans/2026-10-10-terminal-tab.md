# Terminal Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cockpit Terminal tab (`/p/:projectId/terminal`) giving shell access to the machine the cezar server runs on — xterm.js over a token-gated WebSocket backed by a PTY in the project root, opt-in via `CEZ_TERMINAL=1`.

**Architecture:** One `TerminalHub` (`packages/cezar/src/server/terminal.ts`) owns pending single-use tokens and live PTY sessions; it is created in `startServer`, used by one new project-scoped route (`POST /terminal/session`), and receives non-bus WebSocket upgrades through a new delegate parameter on the subscription hub's `attach`. The cockpit adds a capability-gated nav item and a lazy route rendering xterm.js.

**Tech Stack:** `node-pty` (optionalDependency) with a `script(1)` fallback; `ws` (already a dep) for the server side; `@xterm/xterm` + `@xterm/addon-fit` in the cockpit; zod schemas in `packages/contract`.

## Global Constraints

- Opt-in: only the exact value `CEZ_TERMINAL=1` enables; `CEZ_DRY_RUN=1` forces off; default is OFF (spec `.ai/specs/2026-10-10-terminal-tab.md` Q1/Q8).
- Never persist terminal input or output — no new files under `.ai/cezar/`, no new data-gitignore entry.
- Every API shape is a zod schema in `packages/contract` with its type inferred; the route is registered by chaining into the project-scoped `v1` builder (never a loose `app.post`).
- The bus (`ws.ts`) keeps its existing behavior byte-for-byte when no delegate is passed; the delegate only receives paths that are not `WS_PATH`.
- Max 4 live sessions per process; token = 32 random bytes, single-use, 30 s TTL.
- Docs are part of the contract: `.env.example` + `docs/reference.md` env table + BACKWARD_COMPATIBILITY.md §2 (route list and a hand entry for the upgrade-only WS path, like `/api/v1/ws`).

---

### Task 1: Contract schemas + capability flag

**Files:**
- Create: `packages/contract/src/terminal.ts`
- Modify: `packages/contract/src/index.ts` (add `export * from './terminal.ts';`)
- Modify: `packages/contract/src/health.ts:76` (add `terminal: z.boolean()` to `capabilitiesSchema`)

**Interfaces:**
- Produces: `terminalSessionBodySchema {cols?: int 2–500, rows?: int 2–300}`, `terminalSessionResponseSchema {token: string, wsPath: string}`, `Capabilities.terminal: boolean`.

- [x] Write `packages/contract/src/terminal.ts`:

```ts
import { z } from 'zod';

/**
 * Web terminal (spec `.ai/specs/2026-10-10-terminal-tab.md`). One HTTP shape: the
 * session POST that mints a single-use upgrade token. The WS frames that carry
 * terminal bytes afterwards are NOT contract — they are the transport's own
 * protocol, defined next to the hub that speaks it (src/server/terminal.ts),
 * the same place the `/api/v1/ws` bus keeps its frames.
 */
export const terminalSessionBodySchema = z.object({
  /** View columns at spawn time; the PTY is sized to match the emulator. */
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(300).optional(),
});
export type TerminalSessionBody = z.infer<typeof terminalSessionBodySchema>;

export const terminalSessionResponseSchema = z.object({
  /** Single-use, 30 s token. Consumed by exactly one WS upgrade. */
  token: z.string().min(1),
  /** Path to open: `/api/v1/p/<projectId>/terminal/ws`. Open it with
   *  `?token=` on the origin that served the cockpit. */
  wsPath: z.string().min(1),
});
export type TerminalSessionResponse = z.infer<typeof terminalSessionResponseSchema>;
```

- [x] Add to `capabilitiesSchema` in `health.ts` (after `dispatch`, keep alphabetical-free order consistent with the file):

```ts
  /**
   * `true` means the web Terminal tab exists (spec `.ai/specs/2026-10-10-terminal-tab.md`) —
   * opt-in via `CEZ_TERMINAL=1`, off by default, and force-off under `CEZ_DRY_RUN=1`. Off, the
   * nav item is absent and the `/terminal/session` route answers `409`.
   */
  terminal: z.boolean(),
```

- [x] `npm run typecheck` — EXPECT failures in `resolveCapabilities` (missing field) until Task 2 fills it; if using per-package typecheck, note them and continue.

### Task 2: Server — capability + TerminalHub + bus delegate

**Files:**
- Modify: `packages/cezar/src/server/capabilities.ts` (`resolveCapabilities` return + doc line)
- Create: `packages/cezar/src/server/terminal.ts`
- Modify: `packages/cezar/src/server/ws.ts` (delegate parameter on `SocketHub.attach`)
- Modify: `packages/cezar/src/server/server.ts` (ServerDeps, family, mounts, startServer wiring)

**Interfaces:**
- Consumes: contract schemas from Task 1; `verifyWsUpgrade` (already exported from server.ts).
- Produces: `terminalEnabled(env)`, `createTerminalHub(options)` → `TerminalHub` with `issue({projectId, root, cols, rows}): {status:200, body} | {status:409, error}` (discriminated), `handleUpgrade(req, socket, head): boolean`, `close(): void`; `SocketHub.attach(server, verifyUpgrade, delegate?)`.

- [x] `capabilities.ts`: add `terminal: env.CEZ_TERMINAL === '1' && env.CEZ_DRY_RUN !== '1',` to the returned object with a doc comment citing the spec.

- [x] `ws.ts`: extend the attach signature —

```ts
export type UpgradeDelegate = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => boolean;
```

and in `attach`, replace the foreign-path destroy with:

```ts
if (pathname !== WS_PATH) {
  // Exactly one `upgrade` listener may route paths (Node runs every listener
  // on the same event). The delegate — the terminal hub, when wired — claims
  // a foreign path by returning true; anything unclaimed is destroyed, as
  // this listener always has.
  if (delegate?.(req, socket, head)) return;
  socket.destroy();
  return;
}
```

- [x] Create `packages/cezar/src/server/terminal.ts` per the spec: `terminalEnabled`, token table (`Map<string, {projectId, root, cols, rows, expiresAt}>`), `MAX_SESSIONS = 4`, `TOKEN_TTL_MS = 30_000`, frame schemas (`input` ≤200_000 chars, `resize`), PTY factory chain (`createRequire('node-pty')` → `script -q [-F] /dev/null $SHELL -l` → null), JSON frames `{type:'data'|'exit'|'error'}` outbound, per-connection 30 s ping/pong reaper, session dies with its socket, `close()` idempotent. `wsPath` is always the scoped spelling `/api/v1/p/<projectId>/terminal/ws`; the upgrade path regex accepts only that spelling.

- [x] `server.ts`:
  - `ServerDeps` gains `terminalHub?: TerminalHub`;
  - family, added beside the other project-scoped builders:

```ts
// ---- chained family: web terminal (project-scoped, opt-in CEZ_TERMINAL=1) ----
const terminalRoutes = new Hono<ProjectApiEnv>()
  .post('/terminal/session', jsonZodValidator(terminalSessionBodySchema), (c) => {
    if (!capabilities().terminal) {
      return c.json({ error: 'the web terminal is disabled — set CEZ_TERMINAL=1 and restart cezar' }, 409);
    }
    const project = c.get('project');
    const issued = terminalHub.issue({ projectId: project.id, root: project.root, ...c.req.valid('json') });
    return issued.status === 200 ? c.json(issued.body) : c.json({ error: issued.error }, issued.status);
  });
```

  - chain `.route('/', terminalRoutes)` into the `v1` assembly next to the other families;
  - `startServer`: `const terminalHub = deps.terminalHub ?? createTerminalHub({ bindHost: deps.bindHost });`, pass into `createApp`, pass a delegate into the existing `socketHub.attach(...)` call, and add `terminalHub.close()` to the `server.once('close', …)` cleanup.

- [x] Sanity: `npm run typecheck` green again (capability field now provided).

### Task 3: Server tests

**Files:**
- Create: `packages/cezar/src/server/terminal.test.ts` (hub: token TTL/single-use/cap, upgrade guard, frame wiring, socket death kills PTY — with an injected fake PTY factory and a real `ws` client over a scratch `http.Server`)
- Create: `packages/cezar/src/server/terminal-api.test.ts` (route: 409 off / 409 dry-run / 200 shape on / contract parity for `terminalSessionResponseSchema` via `InferResponseType`, plus `HasTypedBody<'/api/v1/terminal/session', '$post'>`)

- [x] Write the tests first, run `npm test -- packages/cezar/src/server/terminal.test.ts` → red where behavior is missing.
- [x] Implement/adjust until green; `npm test -- packages/cezar/src/server` green.
- [x] Prove the guard tests bite: temporarily remove the token check in `handleUpgrade` (`git stash`-free scratch edit), confirm the terminal.test cases fail, restore.

### Task 4: Cockpit — client, view, nav, route

**Files:**
- Modify: `packages/web/package.json` (add `@xterm/xterm ^5.5.0`, `@xterm/addon-fit ^0.10.0`; `npm install`)
- Modify: `packages/web/src/api/client.ts` (`createTerminalSession(body): Promise<TerminalSessionResponse>` via `cez.api.v1.p[':projectId'].terminal.session.$post`, `unwrap` as in `openRunInCli`)
- Create: `packages/web/src/routes/terminal/terminal.tsx` (`TerminalRoute`: skeleton per `skills.tsx`; `useHealth()` capability gate → `CenteredState` with the `CEZ_TERMINAL=1` copy when off; else `TerminalSessionView`)
- Modify: `packages/web/src/components/nav-items.ts` (`terminal?: boolean` gate on `NavItem` + `NavAvailability` + the `visibleNavItems` filter; entry `{ to: '/terminal', label: 'Terminal', icon: SquareTerminalIcon, match: ['/terminal'], terminal: true }`)
- Modify: `packages/web/src/components/app-shell.tsx:246` and `packages/web/src/components/command-palette.tsx:455` (pass `terminal: capabilities?.terminal === true` with the same source as the other gates)
- Modify: `packages/web/src/routes.tsx` (lazy `TerminalRoute`, `<Route path="terminal">` inside the `/p/:projectId` block, `PAGE_TITLE_ROUTES` entry)

View behavior: open container → fit → measure → `createTerminalSession({cols, rows})` → open `ws(s)://location.host + wsPath + '?token='` → frames `{type:'data',data}` → `term.write`, `{type:'exit',exitCode}` → exited state + "New session" button; `term.onData` → `{type:'input',data}`; ResizeObserver → `fit.fit()` → `{type:'resize',cols,rows}`; unmount closes the WS (server kills the PTY). Transparent xterm background so the Tailwind container owns the color; light/dark both legible.

- [x] Cockpit test: `packages/web/src/routes/terminal/terminal.test.tsx` — capability off renders the enable hint (no WS, no fetch); on, with a mocked `WebSocket` + client, input keystrokes emit `{type:'input'}` frames and `data` frames render into the terminal.

### Task 5: Docs

**Files:** `.env.example` (new `# ---- web terminal ----` block), `docs/reference.md` (env table row + views table row), `BACKWARD_COMPATIBILITY.md` §2 (route list entry + hand-entered upgrade-only WS path entry).

- [x] Write entries; `npm test -- packages/cezar/src/server/bc-route-inventory.test.ts` green.

### Task 6: Full validation

- [x] `npm run typecheck`
- [x] `npm test` (expect only the ~8 known environmental failures on this machine — tracker-connections, dashboard-forge-git, copilot-acp-runner)
- [x] `npm run test:unit`
- [x] `npm run build` (contract inlining picks up the new module automatically)
- [x] Manual smoke: `CEZ_TERMINAL=1 npm run dev`, open `/p/<boot>/terminal`, run `echo $TERM && tty && top` (q to quit), resize the window, Ctrl-C a sleep, close the tab, confirm the PTY died (`ps | grep script`/node-pty child gone).
