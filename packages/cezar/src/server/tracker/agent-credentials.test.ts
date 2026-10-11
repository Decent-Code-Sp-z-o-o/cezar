import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import { writeTrackerAssociation } from '../../tracker-association.ts';
import { TrackerConnections } from './connections.ts';
import { completeTrackerItemForRun, resolveTrackerAgentEnv, TrackerAgentBindingError } from './agent-credentials.ts';
import { createBacklogClient } from './backlog.ts';
let root: string;
let project: string;
let env: NodeJS.ProcessEnv;
let association: TrackerAssociation;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tracker-agent-env-'));
  project = join(root, 'project');
  await mkdir(project);
  env = { CEZ_HOME: join(root, 'home') };
  const record = await new TrackerConnections(env).write(project, { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'a@acme.com', token: 'synthetic-token' });
  association = { kind: 'jira', source: { id: 'https://acme.atlassian.net', webUrl: 'https://acme.atlassian.net' }, externalId: 'SAM', externalName: 'Sam', connectionId: record!.id };
  await writeTrackerAssociation(join(project, '.ai/cezar'), association);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('maps only the bound connection to agent env', async () => {
  expect(await resolveTrackerAgentEnv(project, association, env)).toEqual({ JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'a@acme.com', JIRA_API_TOKEN: 'synthetic-token' });
});
it('never substitutes a rotated credential', async () => {
  await new TrackerConnections(env).write(project, { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'a@acme.com', token: 'replacement-token' });
  await expect(resolveTrackerAgentEnv(project, association, env)).rejects.toThrow(/connection|scope/i);
});
it.each(['externalId', 'source', 'kind'] as const)('rejects a changed %s', async (field) => {
  await writeTrackerAssociation(join(project, '.ai/cezar'), { ...association, [field]: field === 'source' ? { ...association.source, id: 'different' } : field === 'kind' ? 'linear' : 'different' });
  await expect(resolveTrackerAgentEnv(project, association, env)).rejects.toThrow(/connection|scope/i);
});
it('legacy and dry runs never receive real credentials', async () => {
  expect(await resolveTrackerAgentEnv(project, undefined, env)).toEqual({});
  expect(await resolveTrackerAgentEnv(project, association, { ...env, CEZ_DRY_RUN: '1' })).toEqual({});
});

it('rejects a removed connection', async () => {
  await new TrackerConnections(env).remove(project);
  await expect(resolveTrackerAgentEnv(project, association, env)).rejects.toThrow(/connection|scope/i);
});
it('maps a bound Linear connection', async () => {
  const record = await new TrackerConnections(env).write(project, { kind: 'linear', key: 'synthetic-linear-key' });
  const linear = { ...association, kind: 'linear' as const, connectionId: record!.id };
  await writeTrackerAssociation(join(project, '.ai/cezar'), linear);
  expect(await resolveTrackerAgentEnv(project, linear, env)).toEqual({ LINEAR_API_KEY: 'synthetic-linear-key' });
});

it('maps a bound backlog connection to no env at all', async () => {
  const record = await new TrackerConnections(env).write(project, { kind: 'backlog', dir: 'backlog' });
  const client = createBacklogClient({ root: project, dir: 'backlog' });
  await mkdir(join(project, 'backlog'), { recursive: true });
  await writeFile(join(project, 'backlog', 'EPIC-000.md'), '- [ ] Only task.\n');
  const resolved = await client.resolveAssociation({ kind: 'backlog', sourceId: 'backlog', externalId: 'backlog' });
  if (!resolved.available) throw new Error('unresolvable');
  const backlog = { ...resolved.association, connectionId: record!.id };
  await writeTrackerAssociation(join(project, '.ai/cezar'), backlog);
  expect(await resolveTrackerAgentEnv(project, backlog, env)).toEqual({});
});

describe('completeTrackerItemForRun', () => {
  let root: string;
  let project: string;
  let backlogEnv: NodeJS.ProcessEnv;
  let association: TrackerAssociation;

  const connectBacklog = async (): Promise<TrackerAssociation> => {
    const resolved = await createBacklogClient({ root: project, dir: 'backlog' })
      .resolveAssociation({ kind: 'backlog', sourceId: 'backlog', externalId: 'backlog' });
    if (!resolved.available) throw new Error('unresolvable');
    return resolved.association;
  };

  const firstTaskId = async (): Promise<string> => {
    const list = await createBacklogClient({ root: project, dir: 'backlog' }).driver(association)
      .listIssues({ expectedScope: undefined, cursor: undefined, limit: 50, refresh: '1', state: 'active' });
    if (!list.available) throw new Error('no list');
    return list.items[0]!.id;
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'backlog-complete-')));
    project = join(root, 'project');
    await mkdir(join(project, 'backlog'), { recursive: true });
    await writeFile(join(project, 'backlog', 'EPIC-001.md'), '# EPIC-001\n\n- [ ] First task.\n');
    backlogEnv = { CEZ_HOME: join(root, 'home') };
    const record = await new TrackerConnections(backlogEnv).write(project, { kind: 'backlog', dir: 'backlog' });
    association = { ...await connectBacklog(), connectionId: record!.id };
    await writeTrackerAssociation(join(project, '.ai/cezar'), association);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('ticks the checkbox of the item a settled run was launched from', async () => {
    const key = await firstTaskId();
    await completeTrackerItemForRun(project, { provider: 'backlog', association, key }, backlogEnv);
    expect(await readFile(join(project, 'backlog', 'EPIC-001.md'), 'utf8')).toBe('# EPIC-001\n\n- [x] First task.\n');
  });

  it('refuses to write through a replaced connection', async () => {
    await new TrackerConnections(backlogEnv).write(project, { kind: 'backlog', dir: 'backlog' });
    const key = await firstTaskId();
    await expect(completeTrackerItemForRun(project, {
      provider: 'backlog',
      association: { ...association, connectionId: '00000000-0000-4000-8000-000000000000' },
      key,
    }, backlogEnv)).rejects.toThrow(TrackerAgentBindingError);
    expect(await readFile(join(project, 'backlog', 'EPIC-001.md'), 'utf8')).toBe('# EPIC-001\n\n- [ ] First task.\n');
  });

  it('ignores non-backlog providers, missing associations and dry runs without writing', async () => {
    const key = await firstTaskId();
    await completeTrackerItemForRun(project, { provider: 'jira', association, key }, backlogEnv);
    await completeTrackerItemForRun(project, { provider: 'backlog', key }, backlogEnv);
    await completeTrackerItemForRun(project, { provider: 'backlog', association, key }, { ...backlogEnv, CEZ_DRY_RUN: '1' });
    expect(await readFile(join(project, 'backlog', 'EPIC-001.md'), 'utf8')).toBe('# EPIC-001\n\n- [ ] First task.\n');
  });
});
