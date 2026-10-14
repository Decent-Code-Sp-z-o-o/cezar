import { hc, type InferResponseType } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { terminalSessionBodySchema, terminalSessionResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * The terminal session schemas must describe the route exactly — both
 * directions, the same mutual-assignability rule as every other family
 * (see contract-parity.test.ts). Compile-time; `npm run typecheck` enforces it.
 */
describe('terminal contract parity', () => {
  const client = hc<AppType>('http://127.0.0.1');
  const session = client.api.v1.terminal.session;

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Session200 = InferResponseType<typeof session.$post, 200>;
  type _Checks = [
    Assert<Exact<z.infer<typeof terminalSessionResponseSchema>, Session200>>,
    Assert<Exact<z.infer<typeof terminalSessionBodySchema>, Parameters<typeof session.$post>[0]['json']>>,
  ];

  it('keeps the chained route visible to the typed client', () => {
    expect(session).toBeDefined();
    // Pins the comparator itself, like contract-parity.test.ts does.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    expect(wider).toBe('schema-is-wider');
  });
});
