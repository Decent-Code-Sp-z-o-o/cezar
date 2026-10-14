import { join } from 'node:path';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import { readTrackerAssociation } from '../../tracker-association.ts';
import { TrackerConnections } from './connections.ts';
import { createBacklogClient } from './backlog.ts';

export class TrackerAgentBindingError extends Error {
  constructor() { super('Tracker connection or scope changed. Create a new run from the current automation.'); }
}

/** The run-record provenance a settled run carries: the same shape the contract and the store
 *  describe. Kept structural so this module needs no store import. */
export interface TrackerRunProvenance {
  provider: string;
  association?: TrackerAssociation;
  key: string;
}

/** Resolve only the credential revision captured by the run, never its replacement. */
export async function resolveTrackerAgentEnv(
  root: string,
  expected: TrackerAssociation | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  if (!expected || env.CEZ_DRY_RUN === '1') return {};
  const current = await readTrackerAssociation(join(root, '.ai/cezar'));
  const record = await new TrackerConnections(env).read(root);
  if (!expected.connectionId || !current || !record
    || current.kind !== expected.kind || current.externalId !== expected.externalId
    || current.source.id !== expected.source.id || current.source.webUrl !== expected.source.webUrl
    || current.connectionId !== expected.connectionId || record.id !== expected.connectionId
    || record.credentials.kind !== expected.kind) throw new TrackerAgentBindingError();
  return record.credentials.kind === 'jira'
    ? { JIRA_BASE_URL: record.credentials.origin, JIRA_EMAIL: record.credentials.email, JIRA_API_TOKEN: record.credentials.token }
    : record.credentials.kind === 'linear'
      ? { LINEAR_API_KEY: record.credentials.key }
      : {}; // backlog: a local directory — no credentials exist to forward.
}

/**
 * Tick the backlog checkbox a settled run was launched from. Same binding discipline as
 * `resolveTrackerAgentEnv`: the association captured at launch must still be the one on disk,
 * or nothing is written. Today only the file-backed provider has a write path; the other
 * kinds are skipped (their trackers stay read-only to cezar). Best-effort by contract: callers
 * log failures, they never fail the run.
 */
export async function completeTrackerItemForRun(
  root: string,
  provenance: TrackerRunProvenance,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const expected = provenance.association;
  if (!expected || provenance.provider !== 'backlog' || env.CEZ_DRY_RUN === '1') return;
  const current = await readTrackerAssociation(join(root, '.ai/cezar'));
  const record = await new TrackerConnections(env).read(root);
  if (!expected.connectionId || !current || !record
    || current.kind !== 'backlog' || current.externalId !== expected.externalId
    || current.source.id !== expected.source.id || current.source.webUrl !== expected.source.webUrl
    || current.connectionId !== expected.connectionId || record.id !== expected.connectionId
    || record.credentials.kind !== 'backlog') throw new TrackerAgentBindingError();
  const client = createBacklogClient({ root, dir: record.credentials.dir });
  const driver = client.driver(current);
  if (!driver.completeItem) throw new TrackerAgentBindingError();
  const result = await driver.completeItem(provenance.key);
  if (!result.available) throw new TrackerAgentBindingError();
}
