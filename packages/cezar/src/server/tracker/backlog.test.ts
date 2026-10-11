import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TrackerAssociation, TrackerItem } from '@open-mercato/cezar-contract';
import { createBacklogClient } from './backlog.ts';
import { TrackerRequestError } from './transport.ts';

let project: string;

beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), 'backlog-provider-')));
  await mkdir(join(project, 'backlog'), { recursive: true });
  await writeFile(join(project, 'backlog', 'EPIC-015-kadry-i-place.md'), [
    '# EPIC-015 Kadry i place',
    '',
    '## Kryteria akceptacji',
    '',
    '- Lista płac wymaga zatwierdzenia.',
    '- [ ] Dane płacowe mają podwyższone wymagania dostępu.',
    '- [x] Korekta listy nie usuwa historii.',
  ].join('\n') + '\n');
  await writeFile(join(project, 'backlog', 'EPIC-016-zus.md'), [
    '# EPIC-016 ZUS EWD/KEDU',
    '',
    '- [ ] Przygotować dane do ZUS.',
  ].join('\n') + '\n');
});

afterEach(async () => { await rm(project, { recursive: true, force: true }); });

const client = () => createBacklogClient({ root: project, dir: 'backlog' });

const connect = async (): Promise<TrackerAssociation> => {
  const resolved = await client().resolveAssociation({ kind: 'backlog', sourceId: 'backlog', externalId: 'backlog' });
  if (!resolved.available) throw new Error('association did not resolve');
  return resolved.association;
};

const listItems = async (
  association: TrackerAssociation,
  query: { state?: 'active' | 'all'; labels?: string[]; refresh?: '0' | '1'; limit?: number; cursor?: string } = {},
): Promise<TrackerItem[]> => {
  const result = await client().driver(association).listIssues({
    expectedScope: undefined, cursor: query.cursor, limit: query.limit ?? 50,
    refresh: query.refresh, state: query.state ?? 'active', ...(query.labels ? { labels: query.labels } : {}),
  });
  if (!result.available) throw new Error(result.reason);
  return result.items;
};

const searchItems = async (association: TrackerAssociation, q: string): Promise<TrackerItem[]> => {
  const result = await client().driver(association).searchItems({ expectedScope: undefined, cursor: undefined, limit: 50, refresh: '1', state: 'all', q });
  if (!result.available) throw new Error(result.reason);
  return result.items;
};

it('offers exactly one scope — the directory — and resolves it against real files', async () => {
  const candidates = await client().listCandidates({ kind: 'backlog', limit: 50 });
  if (!candidates.available) throw new Error('candidates unavailable');
  expect(candidates.source).toMatchObject({ id: 'backlog' });
  expect(candidates.source.webUrl).toMatch(/^file:\/.+\/backlog$/);
  expect(candidates.candidates).toEqual([{ id: 'backlog', name: 'Backlog — 2 epics' }]);
  expect(candidates.truncated).toBe(false);

  const association = await connect();
  expect(association).toMatchObject({ kind: 'backlog', source: { id: 'backlog' }, externalId: 'backlog', externalName: 'Backlog' });
  await expect(client().resolveAssociation({ kind: 'backlog', sourceId: 'elsewhere', externalId: 'backlog' }))
    .rejects.toThrow(/connection|scope/i);
  await expect(client().resolveAssociation({ kind: 'backlog', sourceId: 'backlog', externalId: 'EPIC-015' }))
    .rejects.toThrow(TrackerRequestError);
});

it('refuses to connect an empty or missing directory', async () => {
  await rm(join(project, 'backlog', 'EPIC-015-kadry-i-place.md'));
  await rm(join(project, 'backlog', 'EPIC-016-zus.md'));
  await expect(client().resolveAssociation({ kind: 'backlog', sourceId: 'backlog', externalId: 'backlog' }))
    .rejects.toThrow(/no epic/i);
  await rm(join(project, 'backlog'), { recursive: true });
  await expect(client().listCandidates({ kind: 'backlog', limit: 50 })).rejects.toThrow(/does not exist/i);
});

it('lists unchecked tasks as the active state, with epic stems as labels and line-anchored file URLs', async () => {
  const association = await connect();
  const active = await listItems(association, { refresh: '1' });
  expect(active.map(item => item.title)).toEqual(['Dane płacowe mają podwyższone wymagania dostępu.', 'Przygotować dane do ZUS.']);
  expect(active[0]).toMatchObject({
    kind: 'issue', status: 'todo', author: '',
    labels: ['EPIC-015-kadry-i-place'],
    body: expect.stringContaining('## Kryteria akceptacji'),
    url: expect.stringMatching(/^file:\/\/.+EPIC-015-kadry-i-place\.md#L6$/),
  });
  const all = await listItems(association, { state: 'all', refresh: '1' });
  expect(all.map(item => item.status)).toEqual(['todo', 'todo', 'done']);
  const filtered = await listItems(association, { labels: ['EPIC-016-zus'], refresh: '1' });
  expect(filtered.map(item => item.title)).toEqual(['Przygotować dane do ZUS.']);
  expect(await searchItems(association, 'ZUS')).toHaveLength(1);
});

it('paginates with scope-bound cursors and rejects foreign ones', async () => {
  const association = await connect();
  const driver = client().driver(association);
  const page = await driver.listIssues({ expectedScope: undefined, cursor: undefined, limit: 1, refresh: '1', state: 'all' });
  if (!page.available) throw new Error('unavailable');
  expect(page.items).toHaveLength(1);
  expect(page.truncated).toBe(true);
  if (!page.nextCursor) throw new Error('expected a cursor');
  const next = await driver.listIssues({ expectedScope: undefined, cursor: page.nextCursor, limit: 1, refresh: '1', state: 'all' });
  if (!next.available) throw new Error('unavailable');
  expect(next.items).toHaveLength(1);
  const other = client().driver({ ...association, externalId: 'different' });
  await expect(other.listIssues({ expectedScope: undefined, cursor: page.nextCursor, limit: 1, refresh: '1', state: 'all' }))
    .rejects.toThrow(/expired|scope|changed/i);
});

it('reads one task back by id and misses unknown ones', async () => {
  const association = await connect();
  const active = await listItems(association, { refresh: '1' });
  const driver = client().driver(association);
  const detail = await driver.getItem(active[0]!.id);
  if (!detail.available) throw new Error('unavailable');
  expect(detail.item.body).toContain('Backlog file: EPIC-015-kadry-i-place.md');
  await expect(driver.getItem('EPIC-015-nope')).rejects.toThrow(/not found|no longer exists/i);
  await expect(client().driver({ ...association, source: { ...association.source, id: 'other' } }).getItem(active[0]!.id))
    .rejects.toThrow(/changed/i);
});

it('completes a task by ticking exactly its checkbox, once, and records the self-write', async () => {
  const association = await connect();
  const active = await listItems(association, { refresh: '1' });
  const target = active.find(item => item.title === 'Przygotować dane do ZUS.')!;

  const driver = client().driver(association);
  const done = await driver.completeItem!(target.id);
  if (!done.available) throw new Error('unavailable');
  expect(done.item.status).toBe('done');

  const after = await readFile(join(project, 'backlog', 'EPIC-016-zus.md'), 'utf8');
  expect(after).toBe('# EPIC-016 ZUS EWD/KEDU\n\n- [x] Przygotować dane do ZUS.\n');
  const idempotent = await driver.completeItem!(target.id);
  expect(idempotent.available).toBe(true);
  expect(await readFile(join(project, 'backlog', 'EPIC-016-zus.md'), 'utf8')).toBe(after);
  expect(JSON.parse(await readFile(join(project, '.ai/cezar', 'backlog-writes.json'), 'utf8'))).toMatchObject({ [target.id]: expect.any(Number) });
  await expect(driver.completeItem!('EPIC-015-gone')).rejects.toThrow(TrackerRequestError);
});

it('ticking a CRLF epic keeps every other byte, including the line endings', async () => {
  await writeFile(join(project, 'backlog', 'EPIC-016-zus.md'), '# EPIC-016\r\n\r\n- [ ] ZUS.\r\n- [x] KEDU.\r\n');
  const association = await connect();
  const active = await listItems(association, { refresh: '1' });
  const target = active.find(item => item.title === 'ZUS.')!;
  const result = await client().driver(association).completeItem!(target.id);
  expect(result.available).toBe(true);
  expect(await readFile(join(project, 'backlog', 'EPIC-016-zus.md'), 'utf8')).toBe('# EPIC-016\r\n\r\n- [x] ZUS.\r\n- [x] KEDU.\r\n');
});

it('confines the configured directory to the project, through symlinks too', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'backlog-outside-'));
  try {
    await writeFile(join(outside, 'EPIC-000-escape.md'), '- [ ] outside the project\n');
    const escape = createBacklogClient({ root: project, dir: join('..', outside) });
    await expect(escape.listCandidates({ kind: 'backlog', limit: 50 })).rejects.toThrow(/inside the project/i);

    await rm(join(project, 'backlog'), { recursive: true });
    await symlink(outside, join(project, 'backlog'));
    const linked = createBacklogClient({ root: project, dir: 'backlog' });
    await expect(linked.listCandidates({ kind: 'backlog', limit: 50 })).rejects.toThrow(/inside the project/i);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

it('polls opened and status-changed tasks from the snapshot diff, skipping its own writes', async () => {
  const association = await connect();
  const driver = client().driver(association);
  const poll = (checkpoint?: string) => driver.pollEvents!({ baselineAt: '2026-10-11T00:00:00.000Z', checkpoint, limit: 50, signal: new AbortController().signal });

  const baseline = await poll();
  expect(baseline.candidates).toEqual([]);
  expect(baseline.complete).toBe(true);

  // A new unchecked task fires issue.opened; a new already-done one stays silent.
  await writeFile(join(project, 'backlog', 'EPIC-016-zus.md'), '# EPIC-016 ZUS EWD/KEDU\n\n- [ ] Przygotować dane do ZUS.\n- [ ] Złożyć dokumenty.\n- [x] Already finished elsewhere.\n');
  const opened = await poll(baseline.checkpoint);
  expect(opened.candidates.map(candidate => [candidate.event, candidate.title, candidate.status])).toEqual([
    ['issue.opened', 'Złożyć dokumenty.', 'todo'],
  ]);
  expect(opened.candidates[0]).toMatchObject({ provider: 'backlog', key: expect.any(String), labels: ['EPIC-016-zus'] });

  // A human ticking the checkbox in the file fires issue.status_changed → done…
  await writeFile(join(project, 'backlog', 'EPIC-016-zus.md'), '# EPIC-016 ZUS EWD/KEDU\n\n- [ ] Przygotować dane do ZUS.\n- [x] Złożyć dokumenty.\n- [x] Already finished elsewhere.\n');
  const changed = await poll(opened.checkpoint);
  expect(changed.candidates.map(candidate => [candidate.event, candidate.change.fromId, candidate.change.toId])).toEqual([
    ['issue.status_changed', 'todo', 'done'],
  ]);

  // …but cezar's own completion is ledgered and must not echo back as an event.
  const active = await listItems(association, { refresh: '1' });
  const target = active.find(item => item.title === 'Przygotować dane do ZUS.')!;
  await client().driver(association).completeItem!(target.id);
  const echoed = await poll(changed.checkpoint);
  expect(echoed.candidates).toEqual([]);
});
