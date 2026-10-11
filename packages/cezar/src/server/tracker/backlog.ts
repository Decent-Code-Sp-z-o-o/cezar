import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerItem, TrackerItemResult, TrackerItemsResult, TrackerKind,
  TrackerListQuery, TrackerSearchQuery,
} from '@open-mercato/cezar-contract';
import type { TrackerAutomationEvent } from '@open-mercato/cezar-contract';
import type { PollPage, TrackerEventCandidate } from '../../automations/event-source.ts';
import type { EventPollInput } from './event-scan.ts';
import { parseEpicMarkdown, flipTaskLine, type ParsedEpic, type ParsedTask } from './backlog-parse.ts';
import { descriptionBody } from './adf.ts';
import { encodeCursor, decodeCursor } from './cursor.ts';
import { TrackerRequestError } from './transport.ts';
import type { TrackerDriver, TrackerProvider } from './types.ts';

const MAX_FILES = 1000;
const MAX_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_TTL_MS = 5_000;
const MAX_LABELS = 50;
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const EVENTS: TrackerAutomationEvent[] = ['issue.opened', 'issue.status_changed'];
const STATUSES = [{ id: 'todo', name: 'todo' }, { id: 'done', name: 'done' }];

export interface BacklogConfig {
  /** The project root the backlog directory lives in. */
  root: string;
  /** Project-root-relative directory (validated upstream); default 'backlog'. */
  dir: string;
}

interface SnapshotEpic {
  /** Absolute, realpath-resolved file path. */
  file: string;
  stem: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  tasks: ParsedTask[];
}
interface Snapshot {
  dir: string;
  webUrl: string;
  epics: SnapshotEpic[];
  skipped: number;
}

interface Scope {
  id: string;
  webUrl: string;
}

const scopeId = (dir: string): string => dir.replace(/\\/g, '/');

const isoOrNull = (date: Date, fallback: Date): string => {
  const value = Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : fallback;
  return value.toISOString();
};

/** Confine a configured directory to the project root, resolved against reality (symlinks too). */
async function resolveDir(root: string, dir: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const target = resolve(realRoot, dir);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new TrackerRequestError('unavailable', 'The backlog directory must live inside the project.');
  }
  const real = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new TrackerRequestError('unavailable', `The backlog directory ${scopeId(dir)} does not exist in this project. Create it or fix the path in Settings.`);
    }
    throw new TrackerRequestError('unavailable', 'The backlog directory is not readable. Check its permissions.');
  });
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new TrackerRequestError('unavailable', 'The backlog directory must live inside the project.');
  }
  return real;
}

/**
 * The file-backed provider: a project directory of epic Markdown files whose GFM checkbox items
 * are the tasks. Reads are bounded scans with a short TTL (files change under the server's
 * feet); the one write ticks a single checkbox atomically and records it so the event poll
 * does not echo cezar's own completion back as an automation trigger.
 * Construction performs no I/O.
 */
export function createBacklogClient(config: BacklogConfig): TrackerProvider {
  const kind: TrackerKind = 'backlog';
  let cache: { at: number; value: Snapshot } | null = null;

  const invalidate = () => { cache = null; };

  const scopeOf = (snapshot: Snapshot): Scope => ({ id: scopeId(config.dir), webUrl: snapshot.webUrl });

  const assertScope = (snapshot: Snapshot, association: TrackerAssociation): Scope => {
    const scope = scopeOf(snapshot);
    if (association.kind !== kind || association.source.id !== scope.id || association.source.webUrl !== scope.webUrl) {
      throw new TrackerRequestError('source_changed', 'This tracker connection or scope changed. Reconnect in Settings.');
    }
    return scope;
  };

  const scan = async (refresh: boolean): Promise<Snapshot> => {
    if (!refresh && cache && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.value;
    const dir = await resolveDir(config.root, config.dir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
      throw new TrackerRequestError('unavailable', `The backlog directory ${scopeId(config.dir)} is not readable. Check its permissions.`);
    });    const epics: SnapshotEpic[] = [];
    const markdown = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).map(entry => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const names = markdown.slice(0, MAX_FILES);
    let skipped = markdown.length - names.length;
    for (const name of names) {
      const file = join(dir, name);
      try {
        const text = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) { skipped++; continue; }
        const parsed: ParsedEpic = parseEpicMarkdown(name.replace(/\.md$/i, ''), text);
        const stat = await fs.stat(file);
        epics.push({
          file,
          stem: parsed.stem,
          title: parsed.title,
          createdAt: isoOrNull(stat.birthtime, stat.mtime),
          updatedAt: isoOrNull(stat.mtime, stat.birthtime),
          tasks: parsed.tasks,
        });
      } catch { skipped++; }
    }
    const value: Snapshot = { dir, webUrl: pathToFileURL(dir).href, epics, skipped };
    cache = { at: Date.now(), value };
    return value;
  };

  const bodyFor = (epic: SnapshotEpic, task: ParsedTask): string => {
    const heading = task.section && task.section !== epic.title ? `\n\n## ${task.section}\n` : '\n';
    return `# ${epic.title}${heading}\n- [${task.done ? 'x' : ' '}] ${task.title}\n\nBacklog file: ${epic.stem}.md\n`;
  };

  const toItem = (epic: SnapshotEpic, task: ParsedTask, cap: number): TrackerItem => ({
    kind: 'issue',
    id: task.id,
    title: task.title,
    author: '',
    createdAt: epic.createdAt,
    updatedAt: epic.updatedAt,
    labels: [epic.stem],
    status: task.done ? 'done' : 'todo',
    ...descriptionBody(bodyFor(epic, task), cap),
    url: `${pathToFileURL(epic.file).href}#L${task.line}`,
  });

  const flatten = (snapshot: Snapshot): Array<{ epic: SnapshotEpic; task: ParsedTask }> =>
    snapshot.epics.flatMap(epic => epic.tasks.map(task => ({ epic, task })));

  const readItems = async (association: TrackerAssociation, query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
    const snapshot = await scan(query.refresh === '1');
    const scope = assertScope(snapshot, association);
    const q = 'q' in query ? query.q.toLowerCase() : '';
    const labels = query.labels ?? [];
    const found = flatten(snapshot)
      .filter(({ epic, task }) => (query.state === 'all' || !task.done)
        && labels.every(label => epic.stem === label)
        && (!q || `${task.title} ${epic.title} ${task.section}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(a.task.done) - Number(b.task.done)
        || (a.epic.stem < b.epic.stem ? -1 : a.epic.stem > b.epic.stem ? 1 : 0)
        || a.task.line - b.task.line);
    const scopeKey = [kind, scope.id, association.externalId, 'q' in query ? 'searchItems' : 'listIssues', q, query.state, labels, query.limit];
    const offset = Number(decodeCursor(scopeKey, query.cursor) ?? '0');
    const sliced = found.slice(offset, offset + query.limit);
    const truncated = offset + query.limit < found.length;
    return {
      available: true,
      items: sliced.map(({ epic, task }) => toItem(epic, task, 8000)),
      truncated,
      ...(truncated ? { nextCursor: encodeCursor(scopeKey, String(offset + query.limit)) } : {}),
    };
  };

  const findById = (snapshot: Snapshot, id: string): { epic: SnapshotEpic; task: ParsedTask } | undefined =>
    flatten(snapshot).find(entry => entry.task.id === id);

  const automationOptions = async (association: TrackerAssociation) => {
    const snapshot = await scan(false);
    assertScope(snapshot, association);
    const stems = [...new Set(snapshot.epics.map(epic => epic.stem))].sort().slice(0, MAX_LABELS);
    const limitations = [
      'The backlog has no change history: events come from comparing the checkbox snapshot between polls, so changes made while the server was down surface once, at detection time.',
      'New tasks that are already ticked in the file do not fire issue.opened.',
    ];
    if ([...new Set(snapshot.epics.map(epic => epic.stem))].length > MAX_LABELS) {
      limitations.push(`Only the first ${MAX_LABELS} epic labels are offered for filtering.`);
    }
    if (snapshot.skipped > 0) limitations.push(`${snapshot.skipped} backlog file(s) were skipped (over the size or file-count limit).`);
    return { events: EVENTS, limitations, statuses: STATUSES, labels: stems.map(id => ({ id, name: id })) };
  };

  const pollEvents = async (association: TrackerAssociation, input: EventPollInput): Promise<PollPage<TrackerEventCandidate>> => {
    const snapshot = await scan(true);
    const scope = assertScope(snapshot, association);
    const current = new Map<string, { epic: SnapshotEpic; task: ParsedTask }>();
    for (const entry of flatten(snapshot)) current.set(entry.task.id, entry);
    const fingerprint = createHash('sha256').update(JSON.stringify([scope.id, association.externalId, input.event ?? null])).digest('hex').slice(0, 16);
    const previous = decodeCheckpoint(input.checkpoint, fingerprint);
    if (!previous) {
      return { candidates: [], checkpoint: encodeCheckpoint(current, fingerprint), complete: true };
    }
    const ledger = await readLedger(config.root);
    const now = input.now ?? new Date().toISOString();
    const candidates: TrackerEventCandidate[] = [];
    for (const [id, entry] of current) {
      const was = previous.items[id];
      const status = entry.task.done ? 'done' : 'todo';
      if (was === undefined) {
        if (entry.task.done) continue; // history starts at the first poll; already-done adds nothing to do
        candidates.push(candidate(association, scope, entry, 'issue.opened', now, {}));
      } else if ((was === 1) !== entry.task.done) {
        const from = was === 1 ? 'done' : 'todo';
        if (entry.task.done && selfWritten(ledger, id)) continue; // cezar's own completion must not re-trigger
        candidates.push(candidate(association, scope, entry, 'issue.status_changed', now, { fromId: from, toId: status }));
      }
    }
    candidates.sort((a, b) => (a.tieBreaker < b.tieBreaker ? -1 : a.tieBreaker > b.tieBreaker ? 1 : 0));
    const sliced = candidates.slice(0, input.limit);
    return {
      candidates: sliced,
      checkpoint: encodeCheckpoint(current, fingerprint),
      complete: sliced.length === candidates.length,
    };
  };

  const candidate = (association: TrackerAssociation, scope: Scope, entry: { epic: SnapshotEpic; task: ParsedTask }, event: TrackerAutomationEvent, timestamp: string, change: TrackerEventCandidate['change']): TrackerEventCandidate => {
    const status = entry.task.done ? 'done' : 'todo';
    const changeKey = JSON.stringify([event, change.fromId ?? null, change.toId ?? null]);
    const eventId = createHash('sha256').update([kind, scope.id, association.externalId, entry.task.id, changeKey].join('|')).digest('hex').slice(0, 32);
    return {
      eventId,
      timestamp,
      tieBreaker: entry.task.id,
      provider: kind,
      event,
      association,
      issueId: entry.task.id,
      key: entry.task.id,
      title: entry.task.title,
      url: `${pathToFileURL(entry.epic.file).href}#L${entry.task.line}`,
      status,
      labels: [entry.epic.stem],
      change,
    };
  };

  const completeItem = async (association: TrackerAssociation, id: string): Promise<TrackerItemResult> => {
    const snapshot = await scan(true);
    const scope = assertScope(snapshot, association);
    const found = findById(snapshot, id);
    if (!found) throw new TrackerRequestError('not_found', 'This backlog task no longer exists in the epic file.');
    if (found.task.done) return { available: true, item: toItem(found.epic, found.task, 60000) };
    // Re-read and re-locate through the file itself: the snapshot may be up to one TTL stale
    // even fresh, and the flip must land on the line that exists now.
    const text = await readEpicFile(found.epic.file);
    const reparsed = parseEpicMarkdown(found.epic.stem, text);
    const current = reparsed.tasks.find(task => task.id === id);
    if (!current) throw new TrackerRequestError('not_found', 'This backlog task no longer exists in the epic file.');
    if (current.done) {
      const epic: SnapshotEpic = { ...found.epic, title: reparsed.title, tasks: reparsed.tasks };
      return { available: true, item: toItem(epic, current, 60000) };
    }
    const flipped = flipTaskLine(text, current.line);
    if (flipped === null) throw new TrackerRequestError('unavailable', 'The backlog file changed shape and the task line could not be ticked. Refresh and try again.');
    await atomicWrite(found.epic.file, flipped);
    await recordLedger(config.root, id);
    invalidate();
    const epic: SnapshotEpic = { ...found.epic, title: reparsed.title, tasks: reparsed.tasks.map(task => task.id === id ? { ...task, done: true } : task) };
    return { available: true, item: toItem(epic, { ...current, done: true }, 60000) };
  };

  return {
    kind,
    clearCache: invalidate,
    async listCandidates(query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> {
      if (query.kind !== kind) throw new TrackerRequestError('source_changed', 'This tracker connection changed. Reconnect in Settings.');
      const snapshot = await scan(false);
      const scope = scopeOf(snapshot);
      const name = snapshot.epics.length === 0 ? 'Backlog (no epic files yet)'
        : `Backlog — ${snapshot.epics.length} epic${snapshot.epics.length === 1 ? '' : 's'}`;
      const all = [{ id: scope.id, name }];
      const found = all.filter(row => !query.q || row.name.toLowerCase().includes(query.q.toLowerCase()) || row.id.toLowerCase().includes(query.q.toLowerCase()));
      return { available: true, source: scope, candidates: found.slice(0, query.limit), truncated: false };
    },
    async resolveAssociation(input: TrackerAssociationInput): Promise<TrackerAssociationResult> {
      if (input.kind !== kind) throw new TrackerRequestError('source_changed', 'This tracker connection changed. Reconnect in Settings.');
      const snapshot = await scan(false);
      const scope = scopeOf(snapshot);
      if (input.sourceId !== scope.id) throw new TrackerRequestError('source_changed', 'This tracker connection changed. Reconnect in Settings.');
      if (input.externalId !== scope.id || snapshot.epics.length === 0) {
        throw new TrackerRequestError('not_found', 'The backlog directory has no epic (.md) files to connect. Add one first.');
      }
      return { available: true, association: { kind, source: scope, externalId: scope.id, externalName: 'Backlog' } };
    },
    driver(association: TrackerAssociation): TrackerDriver {
      return {
        association,
        listIssues: (query: TrackerListQuery) => readItems(association, query),
        searchItems: (query: TrackerSearchQuery) => readItems(association, query),
        automationOptions: (query?: { search?: string; cursor?: string }) => automationOptions(association),
        pollEvents: (input: EventPollInput) => pollEvents(association, input),
        getItem: async (id: string): Promise<TrackerItemResult> => {
          const snapshot = await scan(true);
          assertScope(snapshot, association);
          const found = findById(snapshot, id);
          if (!found) throw new TrackerRequestError('not_found', 'Tracker item not found in this scope.');
          return { available: true, item: toItem(found.epic, found.task, 60000) };
        },
        completeItem: (id: string) => completeItem(association, id),
      };
    },
  };
}

/** Open a file without following a final symlink and bound the read; the flip rewrites it whole. */
async function readEpicFile(file: string): Promise<string> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new TrackerRequestError('unavailable', 'The backlog file is not readable. Check its permissions.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new TrackerRequestError('unavailable', 'The backlog file exceeded the size limit and was not read.');
    return await handle.readFile({ encoding: 'utf8' });
  } finally { await handle.close(); }
}

/** Same-directory temp file + rename: readers see the old or the new epic, never a partial one. */
async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    const original = await fs.stat(file).catch(() => null);
    await fs.writeFile(temporary, text, { mode: original?.mode ? original.mode & 0o777 : 0o644 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

// --- Self-write ledger: completions cezar itself made, so the event poll never echoes them. ---

const ledgerPath = (root: string): string => join(root, '.ai/cezar', 'backlog-writes.json');

type Ledger = Record<string, number>;

async function readLedger(root: string): Promise<Ledger> {
  const text = await fs.readFile(ledgerPath(root), 'utf8').catch(() => null);
  if (text === null || text.length > 65_536) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries: Ledger = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at) && Date.now() - at < LEDGER_TTL_MS) entries[id] = at;
    }
    return entries;
  } catch { return {}; }
}

const selfWritten = (ledger: Ledger, id: string): boolean => ledger[id] !== undefined;

async function recordLedger(root: string, id: string): Promise<void> {
  const ledger = await readLedger(root);
  ledger[id] = Date.now();
  const trimmed = Object.fromEntries(Object.entries(ledger).slice(-500));
  const file = ledgerPath(root);
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 }).catch(() => {});
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

// --- Poll checkpoint: the provider-owned snapshot of checkbox states between polls. ---

const checkpointSchemaMax = 2000;

interface Checkpoint { fingerprint: string; items: Record<string, number> }

function encodeCheckpoint(current: Map<string, { task: ParsedTask }>, fingerprint: string): string {
  const items: Record<string, 0 | 1> = {};
  for (const [id, entry] of [...current.entries()].slice(0, checkpointSchemaMax)) items[id] = entry.task.done ? 1 : 0;
  const payload: Checkpoint = { fingerprint, items };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCheckpoint(checkpoint: string | undefined, fingerprint: string): Checkpoint | null {
  if (!checkpoint) return null;
  try {
    if (checkpoint.length > 131_072) return null;
    const parsed: unknown = JSON.parse(Buffer.from(checkpoint, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Partial<Checkpoint>;
    if (record.fingerprint !== fingerprint || !record.items || typeof record.items !== 'object' || Array.isArray(record.items)) return null;
    const items: Record<string, 0 | 1> = {};
    for (const [id, state] of Object.entries(record.items)) {
      if ((state === 0 || state === 1) && id.length <= 256) items[id] = state;
    }
    return { fingerprint, items };
  } catch { return null; }
}
