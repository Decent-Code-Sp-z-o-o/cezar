# Backlog tracker — a third, file-based issue tracker provider

## 📝 TLDR

cezar's issue tracker module speaks to two vendors, Jira and Linear. Both are remote, both need
credentials, and neither knows about the way work is actually planned in the projects cezar runs
in: a plain `backlog/` directory of epic Markdown files where a task is a GFM checkbox —
`- [ ]` still to implement, `- [x]` done. This epic adds **`backlog` as the third
`TrackerKind`**: a local, secret-free provider that reads that directory, surfaces every
checkbox as a tracker item (unchecked = the to-do list), and — the part the vendors can never
do — **writes the completion back**: when cezar finishes a task that came from the backlog, it
flips the checkbox in the epic file, atomically, touching nothing else in the file.

The provider is **zero-config by construction**: no token, no origin, no env var. Connecting a
project means confirming a directory (default `backlog/` at the project root) that cezar has
already discovered. The provider is inert until connected, like every tracker: no directory, no
connection, no behavior change anywhere.

Implementation follows separately (this file is the design; the bite-sized work is tracked as
the connector epic's task list).

## Resolved assumptions (autonomous defaults)

Written in autonomous mode. These were **not** answered by a human; each carries the
conservative default applied.

| # | Question | Applied default | Why conservative |
|---|---|---|---|
| Q1 | What is a "task"? | **A GFM task-list item only**: `^(\s*)([-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$`. A Markdown **link** `- [EPIC-006 …](./EPIC-006….md)` is *not* a task — the real-world backlog this is built against uses that form for cross-epic links, and a regex that accepts it would hallucinate hundreds of tasks. | The parser must be honest about the corpus it will actually read. Bracket content constrained to a single space / `x` / `X` is the GFM definition of a checkbox; anything else is prose. |
| Q2 | What is the unit of association? | **The whole directory**, not one epic. `externalId` = the configured dir, items = every checkbox across all epics, `labels` carries the epic stem (`EPIC-076`) so the existing label filter *is* an epic filter. | One project has one tracker association; the user asked for "the list of tasks to do" — across epics, not inside one. Per-epic scoping would need N connections. |
| Q3 | Where does the directory come from? | **Stored in the connection record** (`{ kind: 'backlog', dir: 'backlog' }`), relative to the project root, defaulting to `backlog`. Validated: relative, no `..` segments, resolves inside the project root. | Zero-config default (`<root>/backlog`) with one honest escape hatch for a different layout — and the connection store is the per-project persistence every provider already uses, so no new state format. |
| Q4 | `url` fields are `https`-only in the contract — a local file has none. | **Relax `trackerSourceSchema.webUrl` and `trackerItemSchema.url` to allow `file:`** alongside `https:` (one shared schema, refined). `item.url` = `file://<realpath>/EPIC-076.md#L377`. | The agent handoff prompt embeds `Source: ${item.url}` — for a coding agent a `file://` URL is directly openable, which a synthetic `https` fake would lie about. Browsers refuse to *navigate* `file:` links; that is the honest rendering of a local file. |
| Q5 | How does a task become "done"? | **Two write paths, one seam.** (a) A run stamped with `automationTracker.provider === 'backlog'` settles `done` → the settle hook completes the item. (b) A **Mark done** button on a backlog item's detail view calls the new `POST /tracker/:id/complete`. Both funnel into `driver.completeItem(id)`. | The tracker layer is deliberately read-only today; adding one optional driver method keeps Jira/Linear untouched (they simply don't implement it) and gives the automation loop the user described without a new orchestration concept. |
| Q6 | Checkbox flip echoes back as a status change — automation loop? | **A self-write ledger**: `completeItem` records the item id in `<root>/.ai/cezar/backlog-writes.json` (pruned after 24 h); `pollEvents` skips `issue.status_changed` candidates for items written by cezar itself. | Without it, "run when a task is completed" automations would immediately re-fire on cezar's own flip. Bounded to one wasted run without the ledger, but the ledger is ~30 lines and removes the waste. |
| Q7 | Which automation events? | **`issue.opened`** (an unchecked checkbox appears) and **`issue.status_changed`** (a checkbox flips, from any cause except cezar's own write, per Q6). Statuses advertised: `todo` / `done`. Labels advertised: the epic stems. | `issue.opened` is exactly the user's loop ("based on these files create the task list, then do them"); `status_changed` lets an automation react to a human ticking a box in the file. No changelog exists for a text file, so the poll compares a snapshot persisted in the poll checkpoint — the checkpoint is opaque provider state by design. |
| Q8 | Task identity that survives edits? | **`id = <epic-stem>-<hash8>`**, hash8 = first 8 hex of sha256 of the normalized task text. | Line numbers shift when a file is edited above a task and would resurrect the same task as a new `issue.opened` event on every poll. Text hash is stable under unrelated edits; duplicate text in one file is ambiguous anyway and completes the first unchecked match. |
| Q9 | What about `author`, `createdAt`? | `author: ''`; `createdAt`/`updatedAt` from the file's birth/mtime (mtime fallback when birthtime is zero). | A checkbox line has no author. Empty string is what the Linear mapper already emits for a missing creator; the UI renders it as no author. |
| Q10 | Does `CEZ_DRY_RUN` cover it? | Yes — a `backlog` fixture row in `dry-run.ts` (exhaustive `Record<TrackerKind, …>`), so the demo cockpit can render the third provider without a real directory. | The dry-run client is the e2e surface; a missing fixture row is a compile error, not a silent gap. |
| Q11 | Scale caps? | ≤ 1000 `.md` files (sorted by name, top level only), ≤ 1 MiB per file (larger skipped), bodies capped 8 000 chars (list) / 60 000 (detail) like the vendors, checkpoint snapshot pruned to current items. | Bounded state everywhere, matching the repo's pagination and cursor discipline; a `backlog/` of 86 files is three orders of magnitude inside every cap. |

## Problem Statement

Work in the projects cezar serves is planned in a `backlog/` directory: one Markdown file per
epic (`EPIC-015-kadry-i-place.md`), tasks as checkboxes inside it. That planning surface is
invisible to the cockpit — the tracker tab speaks Jira and Linear only — so the loop the user
wants ("read the epics, build the list of tasks to do, do them, tick the box") has no
machine-readable entry point. Today the only ways in are a human reading the files or an agent
ad-hoc `cat`-ing them: no association, no settings surface, no automation trigger, no
completion write-back, and no audit trail of which checkbox a run actually closed.

Meanwhile every seam a third provider needs already exists and is **exhaustively typed**:
`trackerKindSchema` drives the credentials union, the dry-run fixtures, the factories record,
the run-provenance enums and the cockpit provider registry via `satisfies Record<TrackerKind,
…>`. Adding a kind is a compile-error-guided tour, not a hunt. The one seam that does *not*
exist is write-back: both vendor adapters are read-only by design, and the agent-credential
plumbing assumes every provider has secrets. A local directory needs the opposite — no
credentials at all, and the *ability* to write.

## Proposed Solution

Four pieces, each behind an existing seam.

1. **Contract** (`packages/contract/src/tracker.ts`): `'backlog'` joins `trackerKindSchema`;
   `trackerCredentialsSchema` grows `{ kind: 'backlog', dir }` (relative path, refined against
   traversal); `webUrl`/`item.url` allow `file:`; a new `POST /tracker/:id/complete` — no body,
   the optional `expectedScope` guard rides the query string like the item read route, and the
   success shape is `{ item }`. `runs.ts` and the automation receipt/candidate types widen
   their provider enums to the full kind union.
2. **Server** (`packages/cezar/src/server/tracker/backlog.ts` + a pure `backlog-parse.ts`):
   the provider — candidates (one scope: the directory), association resolution (dir must
   exist and contain at least one `.md`), list/search/detail over checkboxes with `state`
   filtering (`active` = unchecked), epic-stem labels, offset cursors scoped to the kind, a
   short TTL cache (local files change under the server's feet), `automationOptions` +
   snapshot-diff `pollEvents` with the self-write ledger, and `completeItem` — locate by id,
   flip exactly that line, atomic same-directory tmp+rename, O_NOFOLLOW regular-file checks,
   byte-for-byte preservation of the rest of the file, idempotent on an already-checked line.
   Registered in the `index.ts` factories; dry-run fixture row; `connection-env` third codec
   branch (`BACKLOG_DIR`); `agent-credentials` branch that releases **no** env vars and
   redacts nothing; task-prompt hint that points the agent at the epic file instead of a
   vendor API.
3. **Write-back hook**: the run-settle path routes through one helper — a run whose
   `automationTracker.provider` is `'backlog'` and that settles `done` calls
   `driver.completeItem(run.automationTracker.key)` best-effort (failure logged, never fails
   the run). The new server route exposes the same seam to the cockpit.
4. **Cockpit** (`packages/web`): `TRACKER_PROVIDERS` gains the `Backlog` row (the exhaustive
   record guides the rest); the Settings form's backlog branch is a directory field with no
   secret; the hard-coded "Jira / Linear" strings in the automations editor, trigger labels
   and settings description become table-driven; backlog item detail grows **Mark done**.

## What deliberately does not change

- Jira and Linear adapters, their events, and their credential env plumbing — untouched.
- The tracker watch, cursor HMAC, project isolation and `trackerReadScope` machinery —
  provider-agnostic already; backlog's cursors embed the kind like the other adapters.
- No new `CEZ_*` env var, no capability flag: the provider is discovered from what is already
  there (a connected directory) and is inert otherwise — zero config, safe default.
- No epic-level items, no sub-task nesting, no due dates: a checkbox is a title and a state.

## Security notes

The provider reads and **writes** inside the user's project — the first tracker that can. The
write path therefore gets the credential-store treatment: the configured dir must be relative
with no `..` and resolve (realpath) inside the project root; the epic file is opened
`O_NOFOLLOW`, fstat-checked to be a regular file ≤ 1 MiB, read bounded, transformed in memory,
and replaced atomically via a same-directory temp file + rename (no partial epic files, no
symlink target swapping mid-write). The ledger lives under `.ai/cezar/` — sanctioned project
state. No secret ever exists for this kind, so `agent-credentials` releases an empty env and
the prompt template drops the "call the vendor API" instruction instead of lying about it.

## Test plan

Parser (`backlog-parse.test.ts`): checkbox vs link discrimination (the real-corpus trap,
pinned first), ordered and nested lists, `X` uppercase, diacritics, section context, caps,
no-heading fallback. Provider (`backlog.test.ts`): candidates/resolve happy path and missing
dir; list `active`/`all`; labels and search filters; pagination; `getItem` after a flip;
`completeItem` flip-idempotent-missing; traversal and symlink confinement (regression: prove
each test fails without the guard it pins); `pollEvents` opened/changed/echo-skip and
checkpoint round-trip. Contract/codec: third credential branch round-trip, provider-enum
widening. Run-settle hook: backlog run done → checkbox flipped; failed run → untouched. Web:
backlog settings form, provider labels, Mark done button. The full validation gate
(`typecheck`, `test`, `test:unit`, `build`, `test:package`) before any PR.
